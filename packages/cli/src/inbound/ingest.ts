import { createPublicKey } from "node:crypto";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { addSuppression, classifyInbound, htmlToText, parseHeaders, parseMimeMessage, splitMime, verifyDkimSignature, type BounceRecipient } from "@sealpost/core";
import { readEmails, logEvent, type EmailRecord } from "../emaillog";
import { emitSafely } from "../outbound";
import { exclusive, type Runtime } from "../runtime";
import { readSuppressions, writeSuppressions } from "../store";
import { newInboundId, saveInbound, type InboundDkim, type InboundRecord } from "./store";

export interface IngestContext {
  source: InboundRecord["source"];
  envelopeFrom?: string;
  envelopeTo?: string[];
  remoteAddress?: string;
  secure?: boolean;
}

const strip = (id: string): string => id.replace(/^<|>$/g, "").toLowerCase();

/** The DKIM-Signature's key from DNS, verified against the message. 8-bit non-UTF-8 messages are not verified (reported as `none`). */
async function checkDkim(rt: Runtime, raw: Buffer): Promise<InboundDkim> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { result: "none", detail: "message is 8-bit but not UTF-8; DKIM was not verified" };
  }
  const sig = parseHeaders(splitMime(text.replace(/\r?\n/g, "\r\n")).headerBlock).find((h) => h.name.toLowerCase() === "dkim-signature");
  if (!sig) return { result: "none", detail: "no DKIM-Signature" };
  const tags = Object.fromEntries(sig.value.split(";").map((p) => [p.slice(0, p.indexOf("=")).trim().toLowerCase(), p.slice(p.indexOf("=") + 1).replace(/\s+/g, "")]));
  const domain = tags.d;
  const selector = tags.s;
  if (!domain || !selector || !/^[A-Za-z0-9._-]+$/.test(domain) || !/^[A-Za-z0-9._-]+$/.test(selector)) return { result: "fail", detail: "malformed DKIM-Signature" };
  const lookup = rt.resolveTxt ?? ((n: string) => dnsResolveTxt(n));
  let records: string[][];
  try {
    records = await Promise.race([lookup(`${selector}._domainkey.${domain}`), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 4000).unref())]);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? { result: "none", domain, selector, detail: "no DKIM key published for this selector" } : { result: "temperror", domain, selector, detail: e instanceof Error ? e.message : "DNS lookup failed" };
  }
  const p = records.map((r) => r.join("")).map((v) => /(?:^|;)\s*p=([^;\s]+)/.exec(v.replace(/\s+/g, ""))?.[1]).find((v) => v !== undefined);
  if (!p) return { result: "none", domain, selector, detail: "the DKIM record has no key (revoked)" };
  let jwk: JsonWebKey;
  try {
    jwk = createPublicKey({ key: Buffer.from(p, "base64"), format: "der", type: "spki" }).export({ format: "jwk" }) as JsonWebKey;
  } catch {
    return { result: "fail", domain, selector, detail: "the published key is not a valid RSA public key" };
  }
  const v = await verifyDkimSignature(text.replace(/\r?\n/g, "\r\n"), jwk);
  return v.ok ? { result: "pass", domain, selector } : { result: "fail", domain, selector, detail: v.reason };
}

function matchSent(sent: readonly EmailRecord[], candidates: readonly string[]): EmailRecord | undefined {
  const wanted = new Set(candidates.map(strip));
  return wanted.size === 0 ? undefined : sent.find((e) => wanted.has(strip(e.messageId)));
}

/**
 * The one path every received message takes (SMTP listener, relay webhook, `sealpost inbound import`): parse, check DKIM,
 * classify, store, then act. A delivery report or abuse report only changes anything (suppression, timeline) when it
 * quotes the Message-ID of mail this server really sent and names one of that mail's recipients, so a forged report
 * cannot suppress an arbitrary address.
 */
export async function ingestInbound(rt: Runtime, raw: Buffer, ctx: IngestContext): Promise<InboundRecord> {
  const parsed = parseMimeMessage(raw);
  const cls = classifyInbound(parsed);
  const dkim = await checkDkim(rt, raw);
  const text = parsed.text ?? (parsed.html ? htmlToText(parsed.html) : "");
  const sent = parsed.inReplyTo || parsed.references.length || cls.bounce?.originalMessageId || cls.complaint?.originalMessageId ? await readEmails(rt.project) : [];
  const thread = matchSent(sent, [...(parsed.inReplyTo ? [parsed.inReplyTo] : []), ...parsed.references, ...(cls.bounce?.originalMessageId ? [cls.bounce.originalMessageId] : []), ...(cls.complaint?.originalMessageId ? [cls.complaint.originalMessageId] : [])]);

  const record: InboundRecord = {
    id: newInboundId(),
    receivedAtIso: new Date().toISOString(),
    source: ctx.source,
    envelope: { from: ctx.envelopeFrom ?? parsed.from?.address ?? "", to: ctx.envelopeTo ?? parsed.to.map((a) => a.address) },
    remoteAddress: ctx.remoteAddress,
    secure: ctx.secure,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    replyTo: parsed.replyTo,
    subject: parsed.subject,
    dateIso: parsed.dateIso,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 300),
    hasText: parsed.text !== undefined,
    hasHtml: parsed.html !== undefined,
    attachments: parsed.attachments.map((a, index) => ({ index, filename: a.filename, contentType: a.contentType, disposition: a.disposition, contentId: a.contentId, size: a.size })),
    size: raw.length,
    dkim,
    kind: cls.kind,
    autoReply: cls.autoReply,
    bounce: cls.bounce,
    complaint: cls.complaint,
    threadEmailId: thread?.id,
    problems: parsed.problems,
  };

  const toSuppress: Array<{ email: string; reason: "hard_bounce" | "complaint"; detail: string }> = [];
  const timeline: Array<{ type: "bounced" | "deferred" | "complained" | "replied"; detail: string }> = [];
  if (thread && cls.kind === "bounce" && cls.bounce) {
    const ours = new Set([...thread.to, ...thread.cc, ...thread.bcc].map((a) => a.toLowerCase()));
    const matched: BounceRecipient[] = cls.bounce.recipients.filter((r) => ours.has(r.email));
    record.reportVerified = matched.length > 0;
    for (const r of matched) {
      if (r.hard) {
        toSuppress.push({ email: r.email, reason: "hard_bounce", detail: r.diagnostic ?? `bounce ${r.status ?? ""}`.trim() });
        timeline.push({ type: "bounced", detail: `${r.email}: ${r.status ?? ""} ${r.diagnostic ?? ""}`.trim() });
      } else if (r.action === "delayed") timeline.push({ type: "deferred", detail: `${r.email}: ${r.status ?? ""} ${r.diagnostic ?? ""}`.trim() });
    }
  } else if (thread && cls.kind === "complaint" && cls.complaint?.recipient) {
    const ours = new Set([...thread.to, ...thread.cc, ...thread.bcc].map((a) => a.toLowerCase()));
    record.reportVerified = ours.has(cls.complaint.recipient);
    if (record.reportVerified) {
      toSuppress.push({ email: cls.complaint.recipient, reason: "complaint", detail: cls.complaint.feedbackType ?? "abuse report" });
      timeline.push({ type: "complained", detail: `${cls.complaint.recipient}: ${cls.complaint.feedbackType ?? "abuse"}` });
    }
  } else if (thread && cls.kind === "message") timeline.push({ type: "replied", detail: `${parsed.from?.address ?? record.envelope.from}: ${parsed.subject}`.slice(0, 300) });

  await saveInbound(rt.project, record, raw);
  if (toSuppress.length > 0) {
    await exclusive(rt, async () => {
      let list = await readSuppressions(rt.project);
      for (const s of toSuppress) list = addSuppression(list, { email: s.email, reason: s.reason, detail: s.detail, atIso: record.receivedAtIso });
      await writeSuppressions(rt.project, list);
    });
  }
  if (thread) for (const t of timeline) await logEvent(rt.project, { id: thread.id }, t.type, { detail: t.detail, source: "inbound", inboundId: record.id });

  emitSafely(rt, "email.received", { id: record.id, kind: record.kind, autoReply: record.autoReply, from: record.from?.address ?? record.envelope.from, to: record.envelope.to, subject: record.subject, snippet: record.snippet.slice(0, 200), hasHtml: record.hasHtml, attachments: record.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })), dkim: record.dkim.result, threadEmailId: record.threadEmailId, reportVerified: record.reportVerified, source: record.source });
  if (thread) for (const t of toSuppress) emitSafely(rt, t.reason === "complaint" ? "email.complained" : "email.bounced", { email: t.email, emailId: thread.id, messageId: thread.messageId, detail: t.detail, source: "inbound" });
  return record;
}
