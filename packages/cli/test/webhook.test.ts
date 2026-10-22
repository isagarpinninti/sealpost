import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deliver, isPrivateIp, safeLookup, validateWebhookUrl } from "../src/webhook";

describe("isPrivateIp", () => {
  it("blocks private, loopback, link-local and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "93.184.216.34", "100.63.0.1"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("blocks IPv6 loopback, ULA, link-local and multicast", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) expect(isPrivateIp(ip), ip).toBe(true);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks every IPv6 form that embeds a private IPv4 (the form Node's URL parser emits is hex)", () => {
    const hostOf = (u: string): string => new URL(u).hostname.replace(/^\[|\]$/g, "");
    for (const u of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:172.16.0.1]/", "http://[::ffff:10.1.2.3]/", "http://[::ffff:192.168.0.1]/", "http://[64:ff9b::7f00:1]/", "http://[::7f00:1]/", "http://2130706433/"]) {
      expect(isPrivateIp(hostOf(u)), u).toBe(true);
    }
    expect(isPrivateIp(hostOf("http://[::ffff:8.8.8.8]/"))).toBe(false);
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });
});

describe("validateWebhookUrl", () => {
  it("rejects bad schemes, credentials and private literals unless allowed", () => {
    expect(() => validateWebhookUrl("ftp://example.com/x", false)).toThrow(/http/);
    expect(() => validateWebhookUrl("https://user:pw@example.com/x", false)).toThrow(/credentials/);
    expect(() => validateWebhookUrl("http://localhost:9/x", false)).toThrow(/private/);
    expect(() => validateWebhookUrl("http://[::ffff:7f00:1]/x", false)).toThrow(/private/);
    expect(() => validateWebhookUrl("http://127.0.0.1:9/x", true)).not.toThrow();
    expect(() => validateWebhookUrl("https://example.com/x", false)).not.toThrow();
  });
});

describe("deliver", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    while (servers.length) servers.pop()?.close();
  });

  const listen = (handler: Parameters<typeof createServer>[1]): Promise<number> =>
    new Promise((resolve) => {
      const s = createServer(handler);
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
    });

  it("blocks loopback by default, including a hostname that resolves to loopback (checked at connect time)", async () => {
    const port = await listen((_req, res) => res.end("ok"));
    const byLiteral = await deliver(`http://127.0.0.1:${port}/hook`, {}, false);
    expect(byLiteral.ok).toBe(false);
    expect(byLiteral.note).toMatch(/private/);
    const byName = await deliver(`http://localtest.me:${port}/hook`, {}, false); // resolves to 127.0.0.1 (or fails offline)
    expect(byName.ok).toBe(false);
  });

  it("delivers when private targets are allowed, reports non-2xx, and never follows redirects", async () => {
    const seen: string[] = [];
    const port = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${body}`);
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://127.0.0.1:1/leak" });
          return res.end();
        }
        res.writeHead(req.url === "/fail" ? 500 : 200);
        res.end("done");
      });
    });
    const ok = await deliver(`http://127.0.0.1:${port}/ok`, { a: 1 }, true);
    expect(ok).toMatchObject({ ok: true, status: 200, mode: "real" });
    expect(seen[0]).toBe('POST /ok {"a":1}');
    expect((await deliver(`http://127.0.0.1:${port}/fail`, {}, true)).ok).toBe(false);
    const redirect = await deliver(`http://127.0.0.1:${port}/redirect`, {}, true);
    expect(redirect.ok).toBe(false);
    expect(redirect.note).toMatch(/redirects are not followed/);
  });

  it("returns a simulated acknowledgement when no URL is configured", async () => {
    expect(await deliver(undefined, {}, false)).toMatchObject({ ok: true, mode: "simulated" });
  });
});

describe("safeLookup (shared by webhooks and the gateway upstream)", () => {
  const resolve = (allowPrivate: boolean): Promise<{ err: Error | null }> =>
    new Promise((done) => {
      safeLookup(allowPrivate)("localhost", { all: true }, (err) => done({ err }));
    });

  it("refuses a hostname that resolves to a private address, at connect time", async () => {
    const { err } = await resolve(false);
    expect(err?.message).toMatch(/resolves to a private address/);
  });

  it("permits it when private networks are allowed", async () => {
    expect((await resolve(true)).err).toBeNull();
  });
});
