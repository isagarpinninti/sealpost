import { createHash } from "node:crypto";
import { formatRfc5322Date, newMessageId, parseHeaders, parseMimeMessage, sha256OfMime, signDkim, splitMime } from "@sealpost/core";
import { deliverPrebuilt, recentKeys } from "./dispatch";
import { newEmailId } from "./emaillog";
import type { InboundEnvelope } from "./inbound/smtp";
import { allDomains } from "./project";
import { dkimFor, type Runtime } from "./runtime";

export class SubmissionError extends Error {
  readonly smtp: { code: number; text: string };
  constructor(code: number, text: string) {
    super(text);
    this.smtp = { code, text };
  }
}

const DROP = new Set(["dkim-signature", "bcc", "return-path", "x-sealpost-internal"]);
const domainOf = (addr: string): string => addr.slice(addr.lastIndexOf("@") + 1).toLowerCase();

/**
 * Turns a message submitted over SMTP into a sent email. It must come from one of your configured domains (the same
 * guarantee as EW-103), is signed with that domain's DKIM key, and is delivered with the normal bookkeeping. Retries by
 * a client that reuses a Message-ID are recognised and not sent twice. Template gate checks do not apply: the body
 * is whatever the application wrote.
 */
export async function submitMessage(rt: Runtime, raw: Buffer, env: InboundEnvelope): Promise<void> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new SubmissionError(554, "5.6.0 The message must be UTF-8 (use 7bit, quoted-printable or base64 for other encodings)");
  }
  const parsed = parseMimeMessage(raw);
  const from = parsed.from?.address.toLowerCase();
  if (!from) throw new SubmissionError(554, "5.6.0 The message has no usable From header");
  const profile = allDomains(rt.project.config).find((d) => d.domain.toLowerCase() === domainOf(from));
  if (!profile) throw new SubmissionError(550, `5.7.1 The sender domain ${domainOf(from)} is not configured on this server`);
  if (env.to.length === 0) throw new SubmissionError(554, "5.5.1 No recipients");

  const { headerBlock, body } = splitMime(text.replace(/\r?\n/g, "\r\n"));
  const headers = parseHeaders(headerBlock);
  const kept = headers.filter((h) => !DROP.has(h.name.toLowerCase()) && h.name.toLowerCase() !== "received");
  const has = (n: string): boolean => kept.some((h) => h.name.toLowerCase() === n);
  const messageId = parsed.messageId ? `<${parsed.messageId}>` : newMessageId(profile.domain);
  const lines = kept.map((h) => `${h.name}:${h.raw}`);
  if (!has("message-id")) lines.push(`Message-ID: ${messageId}`);
  if (!has("date")) lines.push(`Date: ${formatRfc5322Date(new Date())}`);
  const rebuilt = `${lines.join("\r\n")}\r\n\r\n${body}`;

  const idemKey = createHash("sha256").update(`${messageId}|${[...env.to].map((x) => x.toLowerCase()).sort().join(",")}`).digest("hex");
  if ((await recentKeys(rt)).has(idemKey)) return; // the client is retrying something that already went out

  const key = await dkimFor(rt, profile);
  const signed = await signDkim(rebuilt, { domain: profile.domain, selector: profile.dkimSelector, privateKey: key.privateKey });
  const addr = (list: Array<{ address: string }>): string[] => list.map((a) => a.address.toLowerCase());
  const envelope = [...new Set(env.to.map((x) => x.toLowerCase()))];
  const to = addr(parsed.to).filter((a) => envelope.includes(a));
  const cc = addr(parsed.cc).filter((a) => envelope.includes(a));
  const bcc = envelope.filter((a) => !to.includes(a) && !cc.includes(a));
  const out = await deliverPrebuilt(rt, {
    raw: signed.raw,
    from,
    recipients: envelope,
    to,
    cc,
    bcc,
    subject: parsed.subject,
    emailId: newEmailId(),
    tags: [{ name: "source", value: "smtp-submission" }],
    meta: { templateId: "smtp-submission", templateVersion: "1", to: envelope.join(", "), fromEmail: from, domain: profile.domain, subject: parsed.subject, messageId, mimeSha256: await sha256OfMime(signed.raw), dkimBodyHash: signed.bodyHash, idempotencyKey: idemKey, deliverabilityScore: 100, links: [] },
  });
  if (out.status === "failed") throw new SubmissionError(554, `5.0.0 Delivery failed: ${(out.error ?? "relay refused the message").replace(/[\r\n]+/g, " ").slice(0, 200)}`);
}
