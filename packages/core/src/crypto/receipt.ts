import { sha256OfMime } from "../engine/mime";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, fromUtf8, hexToBytes, utf8 } from "../util/encoding";
import { canonicalize, type JsonValue } from "./canonical";
import { fingerprintJwk, importPublicKeyJwk, sha256Hex, signBytes, verifySignature, type KeyMaterial, type KeyRegistry } from "./keys";

export const RECEIPT_PREFIX = "evw_";

export interface ReceiptPayload {
  v: 1;
  templateId: string;
  templateVersion: string;
  to: string;
  fromEmail: string;
  subject: string;
  messageId: string;
  /** SHA-256 of the exact bytes handed to the SMTP server (DKIM header included). */
  mimeSha256: string;
  /** The `bh=` of the DKIM signature. */
  dkimBodyHash: string;
  idempotencyKey: string;
  smtpHost: string;
  smtpStatusCode: number;
  smtpBanner: string;
  smtpQueuedResponse: string;
  deliverabilityScore: number;
  issuedAtIso: string;
  issuerFingerprint: string;
  issuerPublicKeyJwk: JsonWebKey;
}

export interface DeliveryReceipt {
  token: string;
  receiptId: string;
  stateHashSha256: string;
  signatureHex: string;
  payload: ReceiptPayload;
}

export type ReceiptInput = Omit<ReceiptPayload, "v" | "issuedAtIso" | "issuerFingerprint" | "issuerPublicKeyJwk"> & { issuedAtIso?: string };

/** Seals an ECDSA P-256 delivery receipt: `evw_<payload>.<signature>`. */
export async function generateDeliveryReceipt(input: ReceiptInput, issuerKey: KeyMaterial): Promise<DeliveryReceipt> {
  const payload: ReceiptPayload = { v: 1, ...input, issuedAtIso: input.issuedAtIso ?? new Date().toISOString(), issuerFingerprint: issuerKey.fingerprint, issuerPublicKeyJwk: issuerKey.publicKeyJwk };
  const canonical = canonicalize(payload as unknown as JsonValue);
  const stateHashSha256 = await sha256Hex(canonical);
  const sig = await signBytes(issuerKey, canonical);
  const signatureHex = bytesToHex(sig);
  return { token: `${RECEIPT_PREFIX}${bytesToBase64Url(utf8(canonical))}.${bytesToBase64Url(sig)}`, receiptId: `${RECEIPT_PREFIX}${stateHashSha256.slice(0, 8)}${signatureHex.slice(0, 8)}`, stateHashSha256, signatureHex, payload };
}

export interface DecodedReceipt {
  payload: ReceiptPayload;
  canonical: string;
  signatureHex: string;
}

export function decodeDeliveryReceipt(token: string): DecodedReceipt {
  if (!token.startsWith(RECEIPT_PREFIX)) throw new Error("Not an evw_ receipt");
  const [p, s, extra] = token.slice(RECEIPT_PREFIX.length).split(".");
  if (!p || !s || extra !== undefined) throw new Error("Malformed receipt: expected evw_<payload>.<signature>");
  const canonical = fromUtf8(base64UrlToBytes(p));
  const payload = JSON.parse(canonical) as ReceiptPayload;
  if (payload?.v !== 1 || typeof payload.messageId !== "string" || typeof payload.mimeSha256 !== "string" || typeof payload.to !== "string") throw new Error("Payload is not an Sealpost delivery receipt");
  return { payload, canonical, signatureHex: bytesToHex(base64UrlToBytes(s)) };
}

export interface ReceiptVerification {
  ok: boolean;
  receiptId: string;
  signature: boolean;
  issuerTrusted: boolean;
  canonicalRoundTrip: boolean;
  /** When the raw message was supplied: it hashes to the receipt's `mimeSha256`. */
  mimeMatches: boolean | null;
  reasons: string[];
}

export async function verifyDeliveryReceipt(token: string, opts: { issuerRegistry?: KeyRegistry; rawMime?: string } = {}): Promise<ReceiptVerification> {
  let d: DecodedReceipt;
  try {
    d = decodeDeliveryReceipt(token);
  } catch (e) {
    return { ok: false, receiptId: "", signature: false, issuerTrusted: false, canonicalRoundTrip: false, mimeMatches: null, reasons: [e instanceof Error ? e.message : "Unreadable receipt"] };
  }
  const reasons: string[] = [];
  const stateHash = await sha256Hex(d.canonical);
  const receiptId = `${RECEIPT_PREFIX}${stateHash.slice(0, 8)}${d.signatureHex.slice(0, 8)}`;
  const canonicalRoundTrip = canonicalize(d.payload as unknown as JsonValue) === d.canonical;
  if (!canonicalRoundTrip) reasons.push("Receipt payload is not in canonical form.");
  let signature = false;
  try {
    signature = (await fingerprintJwk(d.payload.issuerPublicKeyJwk)) === d.payload.issuerFingerprint && (await verifySignature(await importPublicKeyJwk(d.payload.issuerPublicKeyJwk), d.signatureHex, d.canonical));
  } catch {
    signature = false;
  }
  if (!signature) reasons.push("Issuer signature does not verify: the receipt was altered after signing.");
  let mimeMatches: boolean | null = null;
  if (opts.rawMime !== undefined) {
    mimeMatches = (await sha256OfMime(opts.rawMime)) === d.payload.mimeSha256;
    if (!mimeMatches) reasons.push("The message does not hash to the receipt's mimeSha256: it is not the message that was delivered.");
  }
  return { ok: signature && canonicalRoundTrip && mimeMatches !== false, receiptId, signature, issuerTrusted: signature && Boolean(opts.issuerRegistry?.[d.payload.issuerFingerprint]), canonicalRoundTrip, mimeMatches, reasons };
}

export type ReceiptTamperMode = "alter-recipient" | "corrupt-mime-hash";

/** Simulation helper: alters a receipt after signing while keeping the old signature. */
export function tamperDeliveryReceipt(token: string, mode: ReceiptTamperMode = "alter-recipient"): string {
  const d = decodeDeliveryReceipt(token);
  const p = structuredClone(d.payload);
  if (mode === "alter-recipient") p.to = `attacker+${p.to}`;
  else p.mimeSha256 = (p.mimeSha256[0] === "0" ? "1" : "0") + p.mimeSha256.slice(1);
  return `${RECEIPT_PREFIX}${bytesToBase64Url(utf8(canonicalize(p as unknown as JsonValue)))}.${bytesToBase64Url(hexToBytes(d.signatureHex))}`;
}
