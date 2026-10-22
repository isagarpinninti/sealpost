import { randomBytes } from "node:crypto";
import {
  addSuppression,
  autoFillSampleVariables,
  composeSignedMessage,
  classifyRecipientReply,
  evaluateDispatchPreflight,
  generateDeliveryReceipt,
  newMessageId,
  retryDelayMs,
  sha256OfMime,
  verifyDkimSignature,
  type Attachment,
  type DeliveryLedgerRecord,
  type DeliveryReceipt,
  type DomainProfile,
  type DkimVerification,
  type EmailTemplate,
  type PreflightResult,
  type SmtpDispatchResult,
  type VariableValues,
} from "@sealpost/core";
import { logCreated, logEvent, newEmailId, type EmailTag } from "./emaillog";
import { readInbound } from "./inbound/store";
import { readLedger } from "./ledger";
import { withHostedUnsub } from "./unsub";
import { emitSafely } from "./outbound";
import { allDomains } from "./project";
import { dkimFor, domainFor, exclusive, noteSend, rateWait, readInflight, releaseKey, reserveKey, resolveDkimPublicKey, type Runtime } from "./runtime";
import { dispatchWithFailover, sendRawSmtp, type SmtpEndpoint } from "./smtp/client";
import { startSmtpSink } from "./smtp/sink";
import { readQueue, readSuppressions, readTracking, saveInboxMessage, writeQueue, writeSuppressions, writeTracking, type QueueItem } from "./store";

export { exclusive, openRuntime, type Runtime } from "./runtime";

export interface SendRequest {
  templateId: string;
  /** Sending domain; defaults to the project's primary domain. */
  domain?: string;
  /**
   * Send this as a reply: a Message-ID, or the `in_…` id of a received message. Adds In-Reply-To and References
   * (and signs them) so mail clients thread it, and the received message's sender is not changed for you.
   */
  inReplyTo?: string;
  /** Free-form labels you can filter logs and analytics by. */
  tags?: EmailTag[];
  /** Your own key/value data, kept with the email record. */
  metadata?: Record<string, string>;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  variables: VariableValues;
  /** Fill missing variables from sample values (testing). */
  autoFill?: boolean;
  attachments?: Attachment[];
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
}

export type SendStatus = "delivered" | "queued" | "failed" | "blocked";

export interface SendOutcome {
  status: SendStatus;
  /** `em_…` id for `GET /api/emails/:id`. Absent when the gate blocked the send. */
  emailId?: string;
  preflight: PreflightResult;
  messageId?: string;
  /** The exact DKIM-signed bytes that were handed to the SMTP server. */
  rawMime?: string;
  receipt?: DeliveryReceipt;
  record?: DeliveryLedgerRecord;
  smtp?: SmtpDispatchResult;
  queueId?: string;
  /** Recipients added to the suppression list because the server hard-bounced them. */
  suppressed?: string[];
  error?: string;
}

export function findTemplate(rt: Runtime, id: string): EmailTemplate {
  const t = rt.project.templates.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown template '${id}'. Available: ${rt.project.templates.map((x) => x.id).join(", ")}`);
  return t;
}

export async function recentKeys(rt: Runtime): Promise<Set<string>> {
  const keys = new Set([...rt.inflight, ...Object.keys(await readInflight(rt))]);
  const windowMs = rt.project.config.dedupeWindowMinutes * 60_000;
  if (windowMs > 0) for (const r of await readLedger(rt.project.paths.ledger, rt.project.storage)) if (Date.now() - Date.parse(r.timestampIso) <= windowMs) keys.add(r.idempotencyKey);
  for (const q of await readQueue(rt.project)) if (q.status === "queued") keys.add(q.meta.idempotencyKey);
  return keys;
}

const trackingFor = (profile: DomainProfile, messageId: string) => (profile.trackingBaseUrl ? { baseUrl: profile.trackingBaseUrl, messageId } : undefined);

export interface Preview {
  preflight: PreflightResult;
  messageId: string;
  /** The DKIM-signed RFC 5322 message, when it could be built safely (no header-injection block). */
  rawMime?: string;
  dkim?: DkimVerification;
}

/** Runs the pre-flight gate and (optionally) builds and DKIM-signs the message, without sending or reserving anything. */
export async function previewEmail(rt: Runtime, req: SendRequest & { template?: EmailTemplate }, opts: { mime: boolean }): Promise<Preview> {
  const template = req.template ?? findTemplate(rt, req.templateId);
  const variables = req.autoFill ? autoFillSampleVariables(template, req.variables) : req.variables;
  const profile = withHostedUnsub(rt, domainFor(rt, req.domain), req.to);
  const key = await dkimFor(rt, profile);
  const messageId = newMessageId(profile.domain);
  const preflight = await evaluateDispatchPreflight({ to: req.to, cc: req.cc, bcc: req.bcc, fromEmail: req.fromEmail, fromName: req.fromName, replyTo: req.replyTo, variables }, { template, domain: profile, suppressions: await readSuppressions(rt.project), recentKeys: await recentKeys(rt), compile: { tracking: trackingFor(profile, messageId) } });
  if (!opts.mime || preflight.checks.some((c) => c.code === "EW-102" && c.severity === "block")) return { preflight, messageId };
  const signed = await buildSigned(preflight, profile, key.privateKey, messageId, req.attachments, req.replyTo, await resolveThread(rt, req.inReplyTo));
  return { preflight, messageId, rawMime: signed.raw, dkim: await verifyDkimSignature(signed.raw, key.publicKeyJwk) };
}

/** `in_…` or a Message-ID → the threading headers of a reply. Throws for an unknown received message or an unsafe id. */
async function resolveThread(rt: Runtime, ref: string | undefined): Promise<{ inReplyTo: string; references: string[] } | undefined> {
  if (!ref) return undefined;
  const safe = (id: string): string => {
    const bare = id.trim().replace(/^<|>$/g, "");
    if (!/^[^\s<>\u0000-\u001f]{1,300}$/.test(bare)) throw new Error("inReplyTo is not a valid Message-ID");
    return bare;
  };
  if (/^in_[0-9a-f]{16}$/.test(ref)) {
    const rec = await readInbound(rt.project, ref);
    if (!rec) throw new Error(`No received message '${ref}' to reply to`);
    if (!rec.messageId) throw new Error(`Received message '${ref}' has no Message-ID to reply to`);
    return { inReplyTo: safe(rec.messageId), references: [...rec.references.map(safe), safe(rec.messageId)].slice(-20) };
  }
  return { inReplyTo: safe(ref), references: [safe(ref)] };
}

async function buildSigned(pre: PreflightResult, profile: DomainProfile, privateKey: CryptoKey, messageId: string, attachments: Attachment[] | undefined, replyTo: string | undefined, thread?: { inReplyTo: string; references: string[] }): Promise<{ raw: string; bodyHash: string }> {
  return composeSignedMessage({ preflight: pre, domain: profile, messageId, privateKey, attachments, replyTo, thread });
}

async function mailboxEndpoints(rt: Runtime): Promise<SmtpEndpoint[]> {
  return rt.project.config.mailboxes.map((m) => {
    let password: string | undefined;
    if (m.passwordEnv) {
      password = process.env[m.passwordEnv];
      if (password === undefined) throw new Error(`Mailbox '${m.id}' needs the environment variable ${m.passwordEnv}, but it is not set`);
    }
    return { id: m.id, host: m.host, port: m.port, security: m.security, username: m.username, password };
  });
}

/** Sends the already-signed message through the configured transport: the local sink, or the SMTP mailboxes with failover. */
export async function transmit(rt: Runtime, raw: string, from: string, recipients: string[]): Promise<SmtpDispatchResult> {
  const cfg = rt.project.config;
  const fromDomain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  const helo = allDomains(cfg).find((d) => d.domain.toLowerCase() === fromDomain)?.domain ?? cfg.domain.domain;
  if (cfg.transport === "sink") {
    const own = rt.sink ?? (await startSmtpSink({ resolveDkimKey: (d, s) => resolveDkimPublicKey(rt, d, s), onMessage: (m) => saveInboxMessage(rt.project, m) }));
    try {
      return await sendRawSmtp({ endpoint: { id: "loopback-sink", host: own.host, port: own.port, security: "none" }, from, recipients, data: raw, helo, allowPrivateNetworks: true, timeoutMs: 10_000 });
    } finally {
      if (!rt.sink) await own.close();
    }
  }
  return dispatchWithFailover(await mailboxEndpoints(rt), { from, recipients, data: raw, helo, allowPrivateNetworks: cfg.allowPrivateNetworks });
}

async function applyBounces(rt: Runtime, result: SmtpDispatchResult): Promise<string[]> {
  const hard = result.rejected.filter((r) => classifyRecipientReply(r.code) === "hard_bounce");
  if (hard.length === 0) return [];
  let list = await readSuppressions(rt.project);
  for (const r of hard) list = addSuppression(list, { email: r.recipient, reason: "hard_bounce", atIso: new Date().toISOString(), detail: r.message });
  await writeSuppressions(rt.project, list);
  return hard.map((r) => r.recipient);
}

export type Meta = QueueItem["meta"];

async function sealDelivery(rt: Runtime, meta: Meta, result: SmtpDispatchResult): Promise<{ receipt: DeliveryReceipt; record: DeliveryLedgerRecord }> {
  const receipt = await generateDeliveryReceipt({ templateId: meta.templateId, templateVersion: meta.templateVersion, to: meta.to, fromEmail: meta.fromEmail, subject: meta.subject, messageId: meta.messageId, mimeSha256: meta.mimeSha256, dkimBodyHash: meta.dkimBodyHash, idempotencyKey: meta.idempotencyKey, smtpHost: result.host, smtpStatusCode: result.finalCode, smtpBanner: result.banner, smtpQueuedResponse: result.finalResponse, deliverabilityScore: meta.deliverabilityScore }, rt.issuer);
  const record = await rt.ledger.append(receipt);
  const tracking = await readTracking(rt.project);
  tracking[meta.messageId] = { templateId: meta.templateId, to: meta.to, sentAtIso: new Date().toISOString(), links: meta.links };
  await writeTracking(rt.project, tracking);
  return { receipt, record };
}

/**
 * The whole send: pre-flight (serialised, reserving the idempotency key), build + DKIM-sign, transmit,
 * then seal the receipt and append to the ledger (serialised). The slow network step runs outside the lock.
 */
export async function sendEmail(rt: Runtime, req: SendRequest): Promise<SendOutcome> {
  const template = findTemplate(rt, req.templateId);
  const variables = req.autoFill ? autoFillSampleVariables(template, req.variables) : req.variables;
  const emailId = newEmailId();
  const profile = withHostedUnsub(rt, domainFor(rt, req.domain), req.to, emailId);
  const key = await dkimFor(rt, profile);
  const thread = await resolveThread(rt, req.inReplyTo);
  const messageId = newMessageId(profile.domain);
  const reserved = await exclusive(rt, async () => {
    const pre = await evaluateDispatchPreflight({ to: req.to, cc: req.cc, bcc: req.bcc, fromEmail: req.fromEmail, fromName: req.fromName, replyTo: req.replyTo, variables }, { template, domain: profile, suppressions: await readSuppressions(rt.project), recentKeys: await recentKeys(rt), compile: { tracking: trackingFor(profile, messageId) } });
    if (pre.gate !== "BLOCKED") await reserveKey(rt, pre.idempotencyKey);
    return pre;
  });
  if (reserved.gate === "BLOCKED") return { status: "blocked", preflight: reserved, messageId };

  const release = (): void => void releaseKey(rt, reserved.idempotencyKey).catch(() => undefined);
  await logCreated(rt.project, emailId, { messageId, from: reserved.recipients.fromEmail, to: reserved.recipients.to, cc: reserved.recipients.cc, bcc: reserved.recipients.bcc, subject: reserved.compiled.subject, templateId: template.id, domain: profile.domain, tags: req.tags ?? [], metadata: req.metadata ?? {} });
  try {
    const signed = await buildSigned(reserved, profile, key.privateKey, messageId, req.attachments, req.replyTo, thread);
    const meta: Meta = { templateId: template.id, templateVersion: template.version, to: reserved.recipients.to.join(", "), fromEmail: reserved.recipients.fromEmail, domain: profile.domain, subject: reserved.compiled.subject, messageId, mimeSha256: await sha256OfMime(signed.raw), dkimBodyHash: signed.bodyHash, idempotencyKey: reserved.idempotencyKey, deliverabilityScore: reserved.score, links: reserved.compiled.links };
    const envelope = [...reserved.recipients.to, ...reserved.recipients.cc, ...reserved.recipients.bcc];
    const wait = rateWait(rt);
    if (wait === 0) noteSend(rt);
    const result = wait > 0 ? null : await transmit(rt, signed.raw, reserved.recipients.fromEmail, envelope);

    const outcome = await exclusive(rt, async (): Promise<SendOutcome> => {
      if (result === null) {
        const limit = rt.project.config.limits.sendsPerMinute;
        const item: QueueItem = { id: randomBytes(8).toString("hex"), status: "queued", raw: signed.raw, from: reserved.recipients.fromEmail, recipients: envelope, attempts: 0, nextAttemptAtIso: new Date(Date.now() + wait).toISOString(), lastError: `Rate limited (${limit} per minute)`, createdAtIso: new Date().toISOString(), meta };
        await writeQueue(rt.project, [...(await readQueue(rt.project)), item]);
        release();
        return { status: "queued", preflight: reserved, messageId, rawMime: signed.raw, queueId: item.id, error: item.lastError };
      }
      const suppressed = await applyBounces(rt, result);
      if (result.ok) {
        const sealed = await sealDelivery(rt, meta, result);
        release();
        return { status: "delivered", preflight: reserved, messageId, rawMime: signed.raw, receipt: sealed.receipt, record: sealed.record, smtp: result, suppressed };
      }
      if (result.retryable) {
        const delay = retryDelayMs(1);
        const item: QueueItem = { id: randomBytes(8).toString("hex"), status: "queued", raw: signed.raw, from: reserved.recipients.fromEmail, recipients: envelope, attempts: 1, nextAttemptAtIso: new Date(Date.now() + (delay ?? 0)).toISOString(), lastError: result.error ?? result.finalResponse, createdAtIso: new Date().toISOString(), meta };
        await writeQueue(rt.project, [...(await readQueue(rt.project)), item]);
        release();
        return { status: "queued", preflight: reserved, messageId, rawMime: signed.raw, smtp: result, queueId: item.id, error: result.error, suppressed };
      }
      release();
      return { status: "failed", preflight: reserved, messageId, rawMime: signed.raw, smtp: result, error: result.error ?? result.finalResponse, suppressed };
    });
    const status = outcome.status === "blocked" ? "failed" : outcome.status;
    await logEvent(rt.project, { id: emailId }, status, { receiptId: outcome.receipt?.receiptId, error: outcome.error, detail: outcome.smtp?.finalResponse });
    for (const email of outcome.suppressed ?? []) await logEvent(rt.project, { id: emailId }, "bounced", { detail: `${email} hard-bounced`, source: "smtp" });
    announce(rt, meta, status, outcome.error, outcome.receipt?.receiptId, outcome.suppressed);
    return { ...outcome, emailId };
  } catch (e) {
    release();
    await logEvent(rt.project, { id: emailId }, "failed", { error: e instanceof Error ? e.message : "Send failed" }).catch(() => undefined);
    throw e;
  }
}

type Meta0 = QueueItem["meta"];

/** Tells subscribed webhook endpoints how a send ended. Never throws. */
function announce(rt: Runtime, meta: Meta0, status: "delivered" | "queued" | "failed", error: string | undefined, receiptId: string | undefined, suppressed: string[] = []): void {
  const base = { messageId: meta.messageId, to: meta.to, templateId: meta.templateId, domain: meta.domain ?? rt.project.config.domain.domain };
  emitSafely(rt, `email.${status}`, { ...base, receiptId, error });
  for (const email of suppressed) emitSafely(rt, "email.bounced", { ...base, email, source: "smtp" });
}

const LEASE_MS = 5 * 60_000;

export interface QueueRun {
  delivered: number;
  requeued: number;
  failed: number;
  waiting: number;
}

/** Retries every queued message whose time has come: 10 s → 1 min → 5 min, then it is marked failed. */
export async function processQueue(rt: Runtime, now = Date.now()): Promise<QueueRun> {
  const run: QueueRun = { delivered: 0, requeued: 0, failed: 0, waiting: 0 };
  // Claim each due item with a lease under the lock, so another worker (another process, with shared storage) skips it.
  const due = await exclusive(rt, async () => {
    const all = await readQueue(rt.project);
    const picked = all.filter((q) => q.status === "queued" && Date.parse(q.nextAttemptAtIso) <= now && !(q.leaseUntilIso && Date.parse(q.leaseUntilIso) > now));
    for (const q of picked) q.leaseUntilIso = new Date(now + LEASE_MS).toISOString();
    if (picked.length) await writeQueue(rt.project, all);
    return picked.map((q) => ({ ...q }));
  });
  for (const item of due) {
    if (rateWait(rt) > 0) {
      // still over the limit: give the lease back and leave the rest queued without spending an attempt
      await exclusive(rt, async () => {
        const all = await readQueue(rt.project);
        for (const q of all) if (due.some((d) => d.id === q.id)) q.leaseUntilIso = undefined;
        await writeQueue(rt.project, all);
      });
      break;
    }
    noteSend(rt);
    const result = await transmit(rt, item.raw, item.from, item.recipients).catch((e: unknown): SmtpDispatchResult => ({ ok: false, retryable: true, host: "", port: 0, banner: "", finalResponse: "", finalCode: 0, accepted: [], rejected: [], transcript: [], error: e instanceof Error ? e.message : "Transmit failed" }));
    const fin: { status?: "delivered" | "failed"; receiptId?: string; error?: string; suppressed: string[] } = { suppressed: [] };
    await exclusive(rt, async () => {
      const queue = await readQueue(rt.project);
      const cur = queue.find((q) => q.id === item.id);
      if (!cur) return;
      fin.suppressed = await applyBounces(rt, result);
      if (result.ok) {
        const sealed = await sealDelivery(rt, cur.meta, result);
        await writeQueue(rt.project, queue.filter((q) => q.id !== cur.id));
        run.delivered++;
        fin.status = "delivered";
        fin.receiptId = sealed.receipt.receiptId;
        return;
      }
      const attempts = cur.attempts + 1;
      const delay = result.retryable ? retryDelayMs(attempts) : null;
      const next: QueueItem = delay === null ? { ...cur, leaseUntilIso: undefined, status: "failed", attempts, lastError: result.error ?? result.finalResponse } : { ...cur, leaseUntilIso: undefined, attempts, nextAttemptAtIso: new Date(now + delay).toISOString(), lastError: result.error ?? result.finalResponse };
      await writeQueue(rt.project, queue.map((q) => (q.id === cur.id ? next : q)));
      if (delay === null) {
        run.failed++;
        fin.status = "failed";
        fin.error = result.error ?? result.finalResponse;
      } else run.requeued++;
    });
    if (fin.status) {
      await logEvent(rt.project, { messageId: item.meta.messageId }, fin.status, { receiptId: fin.receiptId, error: fin.error });
      announce(rt, item.meta, fin.status, fin.error, fin.receiptId, fin.suppressed);
    }
  }
  run.waiting = (await readQueue(rt.project)).filter((q) => q.status === "queued").length;
  return run;
}

export interface PrebuiltSend {
  /** The complete, DKIM-signed message. */
  raw: string;
  from: string;
  /** The SMTP envelope: to, cc and bcc. */
  recipients: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  meta: Meta;
  emailId: string;
  tags?: EmailTag[];
  metadata?: Record<string, string>;
}

export interface PrebuiltOutcome {
  status: "delivered" | "queued" | "failed";
  emailId: string;
  messageId: string;
  receipt?: DeliveryReceipt;
  record?: DeliveryLedgerRecord;
  smtp?: SmtpDispatchResult;
  queueId?: string;
  error?: string;
  suppressed?: string[];
}

/**
 * Delivers an already-signed message (the SMTP submission path) with the same bookkeeping as a template send: rate limit,
 * relay failover, hard-bounce suppression, receipt and ledger, retry queue, email log and webhooks.
 */
export async function deliverPrebuilt(rt: Runtime, p: PrebuiltSend): Promise<PrebuiltOutcome> {
  await logCreated(rt.project, p.emailId, { messageId: p.meta.messageId, from: p.from, to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, templateId: p.meta.templateId, domain: p.meta.domain ?? rt.project.config.domain.domain, tags: p.tags ?? [], metadata: p.metadata ?? {} });
  const wait = rateWait(rt);
  if (wait === 0) noteSend(rt);
  const result = wait > 0 ? null : await transmit(rt, p.raw, p.from, p.recipients);
  const queueItem = (attempts: number, delayMs: number, error: string): QueueItem => ({ id: randomBytes(8).toString("hex"), status: "queued", raw: p.raw, from: p.from, recipients: p.recipients, attempts, nextAttemptAtIso: new Date(Date.now() + delayMs).toISOString(), lastError: error, createdAtIso: new Date().toISOString(), meta: p.meta });
  const outcome = await exclusive(rt, async (): Promise<Omit<PrebuiltOutcome, "emailId" | "messageId">> => {
    if (result === null) {
      const item = queueItem(0, wait, `Rate limited (${rt.project.config.limits.sendsPerMinute} per minute)`);
      await writeQueue(rt.project, [...(await readQueue(rt.project)), item]);
      return { status: "queued", queueId: item.id, error: item.lastError };
    }
    const suppressed = await applyBounces(rt, result);
    if (result.ok) {
      const sealed = await sealDelivery(rt, p.meta, result);
      return { status: "delivered", receipt: sealed.receipt, record: sealed.record, smtp: result, suppressed };
    }
    if (result.retryable) {
      const item = queueItem(1, retryDelayMs(1) ?? 0, result.error ?? result.finalResponse);
      await writeQueue(rt.project, [...(await readQueue(rt.project)), item]);
      return { status: "queued", smtp: result, queueId: item.id, error: result.error, suppressed };
    }
    return { status: "failed", smtp: result, error: result.error ?? result.finalResponse, suppressed };
  });
  await logEvent(rt.project, { id: p.emailId }, outcome.status, { receiptId: outcome.receipt?.receiptId, error: outcome.error, detail: outcome.smtp?.finalResponse });
  for (const email of outcome.suppressed ?? []) await logEvent(rt.project, { id: p.emailId }, "bounced", { detail: `${email} hard-bounced`, source: "smtp" });
  announce(rt, p.meta, outcome.status, outcome.error, outcome.receipt?.receiptId, outcome.suppressed);
  return { ...outcome, emailId: p.emailId, messageId: p.meta.messageId };
}
