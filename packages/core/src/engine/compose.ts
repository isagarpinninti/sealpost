import { DEFAULT_SIGNED_HEADERS, signDkim } from "../crypto/dkim";
import type { DomainProfile } from "../schemas/template";
import { buildMimeMessage, type Attachment } from "./mime";
import type { PreflightResult } from "./preflight";

export interface ComposeInput {
  preflight: PreflightResult;
  domain: Pick<DomainProfile, "domain" | "dkimSelector" | "replyTo" | "unsubscribeUrl">;
  messageId: string;
  /** The domain's RSA private key (from `createDkimKeyPair` / `loadDkimKeyPair`). */
  privateKey: CryptoKey;
  attachments?: Attachment[];
  replyTo?: string;
  /** Makes the message a reply: adds In-Reply-To and References (ids without angle brackets) and signs them. */
  thread?: { inReplyTo: string; references: string[] };
  now?: Date;
}

export interface ComposedMessage {
  /** The complete, DKIM-signed RFC 5322 message with CRLF line endings. */
  raw: string;
  /** The `bh=` of the DKIM signature. */
  bodyHash: string;
  messageId: string;
}

/** Turns a cleared pre-flight result into the exact bytes to hand to an SMTP server: MIME built, then DKIM-signed. */
export async function composeSignedMessage(input: ComposeInput): Promise<ComposedMessage> {
  const { preflight: pre, domain: d } = input;
  const msg = buildMimeMessage({
    from: { name: pre.recipients.fromName, email: pre.recipients.fromEmail },
    to: pre.recipients.to,
    cc: pre.recipients.cc,
    bcc: pre.recipients.bcc,
    replyTo: input.replyTo ?? d.replyTo,
    subject: pre.compiled.subject,
    text: pre.compiled.text,
    html: pre.compiled.html,
    messageId: input.messageId,
    listUnsubscribe: d.unsubscribeUrl ? [d.unsubscribeUrl] : undefined,
    attachments: input.attachments,
    date: input.now,
    headers: input.thread ? { "In-Reply-To": `<${input.thread.inReplyTo}>`, References: input.thread.references.map((r) => `<${r}>`).join(" ") } : undefined,
  });
  const signed = await signDkim(msg.raw, { domain: d.domain, selector: d.dkimSelector, privateKey: input.privateKey, now: input.now, headers: input.thread ? [...DEFAULT_SIGNED_HEADERS, "in-reply-to", "references"] : undefined });
  return { raw: signed.raw, bodyHash: signed.bodyHash, messageId: input.messageId };
}
