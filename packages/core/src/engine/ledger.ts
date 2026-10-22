import { decodeDeliveryReceipt, verifyDeliveryReceipt, type DeliveryReceipt } from "../crypto/receipt";
import { sha256Hex } from "../crypto/keys";

export const GENESIS_HASH = "0".repeat(64);

export interface DeliveryLedgerRecord {
  seq: number;
  timestampIso: string;
  receiptId: string;
  templateId: string;
  to: string;
  messageId: string;
  smtpHost: string;
  smtpStatusCode: number;
  deliverabilityScore: number;
  mimeSha256: string;
  idempotencyKey: string;
  stateHashSha256: string;
  signatureHex: string;
  /** The full `evw_` token so any record can be re-verified offline. */
  token: string;
  prevHash: string;
  chainHash: string;
}

/** chainHash = SHA-256(prevHash | receiptId | messageId | stateHashSha256 | signatureHex) */
export function computeChainHash(prevHash: string, receiptId: string, messageId: string, stateHashSha256: string, signatureHex: string): Promise<string> {
  return sha256Hex([prevHash, receiptId, messageId, stateHashSha256, signatureHex].join("|"));
}

export async function buildLedgerRecord(prev: DeliveryLedgerRecord | undefined, r: DeliveryReceipt, nowIso: string = new Date().toISOString()): Promise<DeliveryLedgerRecord> {
  const prevHash = prev?.chainHash ?? GENESIS_HASH;
  const p = r.payload;
  return { seq: (prev?.seq ?? 0) + 1, timestampIso: nowIso, receiptId: r.receiptId, templateId: p.templateId, to: p.to, messageId: p.messageId, smtpHost: p.smtpHost, smtpStatusCode: p.smtpStatusCode, deliverabilityScore: p.deliverabilityScore, mimeSha256: p.mimeSha256, idempotencyKey: p.idempotencyKey, stateHashSha256: r.stateHashSha256, signatureHex: r.signatureHex, token: r.token, prevHash, chainHash: await computeChainHash(prevHash, r.receiptId, p.messageId, r.stateHashSha256, r.signatureHex) };
}

export interface LedgerVerification {
  ok: boolean;
  count: number;
  firstBrokenSeq: number | null;
  reason: string;
  badReceipts: number[];
}

/** Checks sequence, linkage, each chain hash, that summary fields match the embedded receipt, and every signature. */
export async function verifyDeliveryLedger(records: readonly DeliveryLedgerRecord[], opts: { verifyReceipts?: boolean } = {}): Promise<LedgerVerification> {
  let prev = GENESIS_HASH;
  const badReceipts: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const broken = (reason: string): LedgerVerification => ({ ok: false, count: records.length, firstBrokenSeq: r.seq, reason, badReceipts });
    if (r.seq !== i + 1) return broken(`Sequence gap at position ${i + 1}.`);
    if (r.prevHash !== prev) return broken(`Record ${r.seq} does not link to the previous record.`);
    if ((await computeChainHash(r.prevHash, r.receiptId, r.messageId, r.stateHashSha256, r.signatureHex)) !== r.chainHash) return broken(`Record ${r.seq} chain hash was altered.`);
    if (opts.verifyReceipts !== false) {
      let good = false;
      try {
        const d = decodeDeliveryReceipt(r.token);
        const v = await verifyDeliveryReceipt(r.token);
        const p = d.payload;
        good = v.ok && v.receiptId === r.receiptId && r.templateId === p.templateId && r.to === p.to && r.messageId === p.messageId && r.smtpHost === p.smtpHost && r.smtpStatusCode === p.smtpStatusCode && r.deliverabilityScore === p.deliverabilityScore && r.mimeSha256 === p.mimeSha256 && r.idempotencyKey === p.idempotencyKey && (await sha256Hex(d.canonical)) === r.stateHashSha256 && d.signatureHex === r.signatureHex;
      } catch {
        good = false;
      }
      if (!good) badReceipts.push(r.seq);
    }
    prev = r.chainHash;
  }
  if (badReceipts.length) return { ok: false, count: records.length, firstBrokenSeq: badReceipts[0], reason: `Embedded receipt failed verification at record ${badReceipts[0]}.`, badReceipts };
  return { ok: true, count: records.length, firstBrokenSeq: null, reason: records.length ? `Chain intact across ${records.length} record(s).` : "Ledger is empty.", badReceipts };
}
