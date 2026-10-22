import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/* ───────────────────────── SSRF guard ───────────────────────── */

function isPrivateIPv4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands any textual IPv6 address into 8 16-bit groups (handles `::` and dotted-quad tails). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [o1, o2, o3, o4] = dotted.slice(1).map(Number);
    s = `${s.slice(0, dotted.index)}${((o1 << 8) | o2).toString(16)}:${((o3 << 8) | o4).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * True for loopback, private, link-local, CGNAT, multicast and reserved addresses, including every
 * IPv6 form that embeds an IPv4 address (IPv4-mapped `::ffff:a.b.c.d` / `::ffff:aabb:ccdd`, NAT64
 * `64:ff9b::/96`, deprecated IPv4-compatible `::a.b.c.d`). Unparseable input is treated as private.
 */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return isPrivateIPv4(a, b, c);
  }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number): boolean => isPrivateIPv4(hi >> 8, hi & 0xff, lo >> 8);
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (first5Zero && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 && g[7] <= 1 ? true : embedded(g[6], g[7]); // ::, ::1, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function validateWebhookUrl(rawUrl: string, allowPrivate: boolean): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Webhook URL must be http(s)");
  if (url.username || url.password) throw new Error("Webhook URL must not contain credentials");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Webhook host '${host}' is private; set allowPrivateNetworks in sealpost.config.json to permit it`);
  }
  if (isIP(host) !== 0 && isPrivateIp(host)) throw new Error(`Webhook address '${host}' is private; set allowPrivateWebhooks to permit it`);
  return url;
}

/* ───────────────────────── delivery ───────────────────────── */

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * A socket `lookup` that validates the address it is about to connect to. When private targets are not
 * allowed, a public hostname that resolves to a private address (for example `localtest.me`) is refused
 * at connect time. Shared by webhook delivery and the gateway's upstream calls.
 */
export function safeLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = Array.isArray(addresses) ? addresses : [];
      const blocked = !allowPrivate && list.find((a) => isPrivateIp(a.address));
      if (blocked) return callback(new Error(`Host '${hostname}' resolves to a private address (${blocked.address}); set allowPrivateNetworks to permit it`), "", 4);
      const pick = list[0];
      if (options.all) return callback(null, list as never, undefined as never);
      return callback(null, pick.address, pick.family);
    });
  };
}

/**
 * POSTs JSON without following redirects. When private targets are not allowed the check happens
 * inside the socket's own DNS lookup, so the address that is validated is the one that is connected
 * to (no second lookup, no DNS-rebinding window).
 */
function postJson(url: URL, body: string, allowPrivate: boolean, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<{ status: number; statusText: string }> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "POST",
        headers: { ...extraHeaders, "content-type": "application/json", "content-length": Buffer.byteLength(body), "user-agent": "sealpost-webhook/1" },
        timeout: timeoutMs,
        lookup: safeLookup(allowPrivate),
      },
      (res) => {
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "" }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "" }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("Timed out after 5 s"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end(body);
  });
}

export interface WebhookDelivery {
  url: string;
  mode: "real" | "simulated";
  ok: boolean;
  status: number;
  latencyMs: number;
  note: string;
}

/** Delivers a signed receipt. Empty URL = acknowledged locally (nothing leaves the machine). */
export async function deliver(rawUrl: string | undefined, payload: unknown, allowPrivate: boolean): Promise<WebhookDelivery> {
  const t0 = performance.now();
  if (!rawUrl || rawUrl.trim() === "") {
    return { url: "(none configured)", mode: "simulated", ok: true, status: 200, latencyMs: Math.round(performance.now() - t0), note: "200 OK — no webhook configured" };
  }
  try {
    const url = validateWebhookUrl(rawUrl.trim(), allowPrivate);
    const res = await postJson(url, JSON.stringify(payload), allowPrivate, 5000);
    const ok = res.status >= 200 && res.status < 300;
    return { url: url.toString(), mode: "real", ok, status: res.status, latencyMs: Math.round(performance.now() - t0), note: ok ? `${res.status} ${res.statusText || "OK"}` : res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}` };
  } catch (e) {
    return { url: rawUrl, mode: "real", ok: false, status: 0, latencyMs: Math.round(performance.now() - t0), note: e instanceof Error ? e.message : "Delivery failed" };
  }
}

/** POSTs an already-serialised body with extra headers (the signature). Never follows redirects; private targets are refused unless allowed. */
export async function deliverRaw(rawUrl: string, body: string, headers: Record<string, string>, allowPrivate: boolean): Promise<{ ok: boolean; status: number; note: string }> {
  try {
    const res = await postJson(validateWebhookUrl(rawUrl.trim(), allowPrivate), body, allowPrivate, 8000, headers);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, note: ok ? `${res.status} ${res.statusText || "OK"}` : res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, note: e instanceof Error ? e.message : "Delivery failed" };
  }
}
