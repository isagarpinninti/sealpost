import { bytesToHex, subtle, utf8 } from "../util/encoding";

/**
 * Outbound webhook signatures. The `Sealpost-Signature` header is `t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Verify against the raw bytes, before parsing the JSON.
 */
export const WEBHOOK_SIGNATURE_HEADER = "Sealpost-Signature";
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await subtle().importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await subtle().sign("HMAC", key, utf8(message)));
}

export async function signWebhookPayload(secret: string, body: string, timestampSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacHex(secret, `${timestampSeconds}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface WebhookVerification {
  ok: boolean;
  reason?: "malformed" | "stale" | "mismatch";
}

export async function verifyWebhookSignature(secret: string, body: string, header: string | null | undefined, opts: { toleranceSeconds?: number; nowSeconds?: number } = {}): Promise<WebhookVerification> {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? ["", ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== "string" || !/^[0-9a-f]{64}$/.test(parts.v1)) return { ok: false, reason: "malformed" };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  return constantTimeEqual(parts.v1, await hmacHex(secret, `${t}.${body}`)) ? { ok: true } : { ok: false, reason: "mismatch" };
}
