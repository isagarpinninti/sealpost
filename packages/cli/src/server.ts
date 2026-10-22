import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RELAY_PROVIDERS, ImportError, isSuppressed, analyzeAuthenticationResults, importTemplate, parseMimeMessage, checkDnsRecords, parseRelayEvents, type RelayProvider, DomainProfileSchema, EmailTemplateSchema, MailboxSchema, addSuppression, decodeDeliveryReceipt, removeSuppression, validateTemplate, verifyDeliveryReceipt, buildRegistry, type EmailTemplate } from "@sealpost/core";
import { readFileSync } from "node:fs";
import { runDoctor, defaultProbe } from "./doctor";
import { ingestInbound } from "./inbound/ingest";
import { startInboundSmtp, type RunningInboundSmtp } from "./inbound/smtp";
import { deleteInbound, listInboundAll, pruneInbound, queryInbound, readInbound, readInboundRaw } from "./inbound/store";
import { extractRawMessage } from "./inbound/webhook";
import { logEvent, queryEmails, readEmails, timeseries, type EmailStatus } from "./emaillog";
import { BroadcastError, addContacts, cancelBroadcast, createAudience, createBroadcast, deleteAudience, processBroadcasts, removeContact } from "./broadcast";
import { previewEmail, processQueue, sendEmail } from "./dispatch";
import { emitEvent, emitSafely, processOutbox } from "./outbound";
import { SubmissionError, submitMessage } from "./submission";
import { ALL_SCOPES, principalForToken, safeEqual, sha256, type Principal } from "./auth";
import { ScheduleError, cancelScheduled, processScheduled, scheduleEmail } from "./scheduled";
import { hostedUnsubUrl, verifyUnsubToken } from "./unsub";
import { dkimFor, dnsCheckOptions, dnsRecordsFor, domainFor, exclusive, openRuntime, resolveDkimPublicKey, type Runtime } from "./runtime";
import { resolveTxt } from "node:dns/promises";
import { buildOpenApi } from "./openapi";
import { readLedger, verifyLedgerFile } from "./ledger";
import { KEY_SCOPES, WebhookEndpointSchema, allDomains, keyRecord, loadProject, saveConfig, saveWorkspace, type ApiKeyRecord, type KeyScope, type Project } from "./project";
import { startSmtpSink, type RunningSink } from "./smtp/sink";
import { readScheduled, appendAudit, readAudit, appendEvent, clearInbox, readIdempotency, writeIdempotency, listInbox, readAudiences, readBroadcasts, readEvents, readInboxRaw, readOutbox, publicBroadcast, publicDelivery, readQueue, readSuppressions, readTracking, saveInboxMessage, writeSuppressions } from "./store";
import { VERSION } from "./version";
import { deliver } from "./webhook";

export interface ServerOptions {
  dir: string;
  host?: string;
  port?: number;
  /** Directory with the prebuilt Studio. Defaults to the one bundled in the package. */
  studioDir?: string;
  /** Master key (admin): may edit the workspace. Also read from SEALPOST_API_KEY. */
  apiKey?: string;
  /** Shared secret for `POST /hooks/relay/<provider>?token=`. Also read from SEALPOST_WEBHOOK_SECRET. The endpoint is disabled without one. */
  webhookSecret?: string;
}

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  fingerprint: string;
  /** Port of the built-in loopback SMTP sink. */
  sinkPort: number;
  /** The MX listener's port, when `inbound.enabled`. */
  inboundPort: number | null;
  /** The SMTP submission listener's port, when `submission.enabled`. */
  submissionPort: number | null;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const MAX_BODY = 1_000_000;

/** Machine-readable `code` for every error response; handlers may override it (`preflight_blocked`, `smtp_failed`, …). */
const DEFAULT_CODES: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 413: "payload_too_large", 422: "validation_error", 429: "rate_limited", 500: "internal_error", 502: "bad_gateway" };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const issues = (e: z.ZodError): string[] => e.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

/** Content types that are safe to hand back as-is; everything else (HTML, SVG, scripts, unknown) is served as an opaque download. */
const SAFE_DOWNLOAD_TYPES = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf|text\/plain|text\/csv|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|message\/rfc822|application\/zip|application\/json)$/i;

/** Sends received bytes as a download that a browser cannot interpret as a page. */
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, filename: string): void {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": SAFE_DOWNLOAD_TYPES.test(contentType) ? contentType : "application/octet-stream", "content-length": body.length, "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`, "content-security-policy": "sandbox", "cache-control": "no-store" });
  res.end(body);
}

function defaultStudioDir(): string {
  return fileURLToPath(new URL("../studio-dist", import.meta.url));
}

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const AttachmentSchema = z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(3).max(100), contentBase64: z.string().max(7_000_000) }).strict();
const EmailList = z.union([z.string(), z.array(z.string()).max(100)]);
const SendSchema = z.object({
  templateId: z.string().min(1).optional(),
  /** Sending domain; defaults to the project's primary domain. */
  domain: z.string().min(3).max(253).optional(),
  /** A Message-ID, or the `in_…` id of a received message, to reply to. */
  inReplyTo: z.string().max(400).optional(),
  /** ISO 8601. Send later (up to 90 days ahead). The gate runs now and again at that time. */
  scheduledAt: z.string().max(40).optional(),
  tags: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, _ and - only (max 64)"), value: z.string().regex(/^[A-Za-z0-9_.@ -]{1,256}$/, "letters, digits, spaces and _ . @ - only (max 256)") }).strict()).max(10).optional(),
  metadata: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.string().max(500)).optional().refine((m) => m === undefined || Object.keys(m).length <= 20, "at most 20 keys"),
  /** Compile/preview only: an inline working copy (the Studio sends its editor state). Never used to send. */
  template: z.unknown().optional(),
  to: EmailList.default([]),
  cc: z.array(z.string()).max(100).optional(),
  bcc: z.array(z.string()).max(100).optional(),
  variables: z.record(z.string(), ScalarSchema).default({}),
  autoFill: z.boolean().default(false),
  includeMime: z.boolean().default(false),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  fromEmail: z.string().optional(),
  fromName: z.string().optional(),
  replyTo: z.string().optional(),
});

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  let project: Project = await loadProject(options.dir);
  let sink: RunningSink | null = null;
  const rtRef: { rt: Runtime | null } = { rt: null };
  const getRt = (): Runtime => {
    if (!rtRef.rt) throw new Error("Runtime not ready");
    return rtRef.rt;
  };
  sink = await startSmtpSink({
    resolveDkimKey: (d, s) => (rtRef.rt ? resolveDkimPublicKey(rtRef.rt, d, s) : undefined),
    onMessage: (m) => saveInboxMessage(rtRef.rt?.project ?? project, m),
  });
  rtRef.rt = await openRuntime(project, { sink });
  const masterKey = options.apiKey ?? process.env.SEALPOST_API_KEY ?? "";
  const authRequired = (): boolean => masterKey !== "" || Object.keys(project.config.auth.keys).length > 0;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && !authRequired()) {
    await sink.close();
    throw new Error(`Refusing to listen on ${host} without authentication. Set SEALPOST_API_KEY or run \`sealpost auth add-key <label>\`.`);
  }
  const studioDir = resolve(options.studioDir ?? defaultStudioDir());

  /* ───── rate limiting (per IP, fixed window) ───── */
  const windows = new Map<string, { count: number; reset: number }>();
  const limited = (ip: string, bucket: string, max: number): boolean => {
    const now = Date.now();
    const k = `${bucket}:${ip}`;
    const w = windows.get(k);
    if (!w || w.reset < now) {
      windows.set(k, { count: 1, reset: now + 60_000 });
      return false;
    }
    w.count++;
    return w.count > max;
  };

  const actors = new WeakMap<IncomingMessage, string>();

  /** The caller, or null. The master key is admin; stored keys carry their scopes and may expire. */
  const authenticate = (req: IncomingMessage): Principal | null => {
    if (!authRequired()) return { admin: true, scopes: ALL_SCOPES, actor: "open" };
    const header = req.headers.authorization ?? "";
    return principalForToken(project.config, masterKey, header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  };

  /** The scope a request needs. `admin` means the master key only. */
  const requiredScope = (method: string, path: string): KeyScope | "admin" => {
    if (method === "GET") return path === "/api/audit" || path === "/api/keys" ? "admin" : "read";
    if (path === "/api/send" || path === "/api/send/batch" || path === "/api/compile" || path === "/api/unsubscribe-link") return "send";
    if (path === "/api/verify" || path === "/api/auth-check" || path === "/api/import") return "read";
    if (path === "/api/keys" || path.startsWith("/api/keys/")) return "admin";
    return "write";
  };

  const setKeys = async (keys: Record<string, string | ApiKeyRecord>): Promise<void> => {
    const config = { ...project.config, auth: { keys } };
    await saveConfig(project, config);
    project = { ...project, config };
    getRt().project = project;
  };

  const dnsFor = async (name?: string) => {
    return dnsRecordsFor(getRt(), domainFor(getRt(), name));
  };
  const requireDomain = (name: string | undefined): void => {
    try {
      domainFor(getRt(), name);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : "Unknown domain");
    }
  };
  const workspace = async () => ({
    project: project.config.name,
    templates: project.templates,
    domain: project.config.domain,
    domains: project.config.domains,
    webhooks: project.config.webhooks.map((w) => ({ ...w, secretEnvSet: process.env[w.secretEnv] !== undefined })),
    transport: project.config.transport,
    mailboxes: project.config.mailboxes.map((m) => ({ ...m, passwordEnvSet: m.passwordEnv ? process.env[m.passwordEnv] !== undefined : false })),
    dns: await dnsFor(),
    dkimPublicKeyJwk: getRt().dkim.publicKeyJwk,
    sinkPort: sink?.port ?? null,
  });

  async function bc<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BroadcastError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  type SendBody = z.infer<typeof SendSchema>;
  interface Reply {
    status: number;
    body: Record<string, unknown>;
    replayed?: boolean;
  }

  /** One send, reported as a status and body rather than thrown, so it can be stored for idempotent replay. */
  async function sendOne(data: SendBody): Promise<Reply> {
    const rt = getRt();
    if (data.scheduledAt !== undefined && Date.parse(data.scheduledAt) > Date.now() + 1000) {
      const { scheduledAt, ...request } = data;
      try {
        const item = await scheduleEmail(rt, { ...request, templateId: request.templateId ?? "", to: request.to }, scheduledAt);
        return { status: 202, body: { ok: true, status: "scheduled", id: item.id, scheduledAt: item.scheduledAtIso } };
      } catch (e) {
        if (e instanceof ScheduleError) {
          if (e.preflight) return { status: 403, body: { ok: false, error: e.message, code: "preflight_blocked", status: "blocked", preflight: e.preflight } };
          throw new HttpError(e.status, e.message);
        }
        throw e;
      }
    }
    let outcome;
    try {
      outcome = await sendEmail(rt, { ...data, templateId: data.templateId ?? "", to: data.to });
    } catch (e) {
      if (e instanceof Error && /inReplyTo|received message/.test(e.message)) throw new HttpError(400, e.message);
      throw e;
    }
    const webhook = outcome.status === "delivered" && outcome.receipt ? await deliver(project.config.webhookUrl, { event: "sealpost.delivery.sealed", receiptId: outcome.receipt.receiptId, templateId: data.templateId, to: outcome.receipt.payload.to, messageId: outcome.messageId, token: outcome.receipt.token }, project.config.allowPrivateNetworks) : undefined;
    const shown = { ...outcome, id: outcome.emailId, webhook };
    if (outcome.status === "blocked") return { status: 403, body: { ok: false, error: "Blocked by the pre-flight gate", code: "preflight_blocked", ...shown } };
    if (outcome.status === "failed") return { status: 502, body: { ok: false, error: outcome.error ?? "SMTP delivery failed", code: "smtp_failed", ...shown } };
    return { status: outcome.status === "queued" ? 202 : 201, body: { ok: true, ...shown } };
  }

  const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
  const idemPending = new Map<string, { fingerprint: string; promise: Promise<Reply> }>();
  const stable = (v: unknown): string => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));

  const idempotencyKeyOf = (req: IncomingMessage): string | undefined => {
    const h = req.headers["idempotency-key"];
    if (h === undefined) return undefined;
    const key = String(h).trim();
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(key)) throw new HttpError(400, "Idempotency-Key must be 1 to 255 characters from A-Z a-z 0-9 _ . : -");
    return key;
  };

  /**
   * Same key + same body within 24 h returns the original response (`Idempotent-Replayed: true`) without sending again;
   * same key + different body is a 409. Only successful results are remembered, so a blocked or failed attempt can be retried.
   */
  async function withIdempotency(key: string | undefined, body: unknown, run: () => Promise<Reply>): Promise<Reply> {
    if (!key) return run();
    const fingerprint = sha256(stable(body));
    const clash = (): HttpError => new HttpError(409, "This Idempotency-Key was already used with a different request body", { code: "idempotency_key_reuse" });
    const inflight = idemPending.get(key);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) throw clash();
      return { ...(await inflight.promise), replayed: true };
    }
    // Registered before the first await, so a concurrent request with the same key always finds it.
    const promise = (async (): Promise<Reply> => {
      const stored = await exclusive(getRt(), async () => (await readIdempotency(project))[key]);
      if (stored && Date.now() - Date.parse(stored.atIso) < IDEMPOTENCY_TTL_MS) {
        if (stored.fingerprint !== fingerprint) throw clash();
        return { status: stored.status, body: stored.body, replayed: true };
      }
      const reply = await run();
      if (reply.status >= 200 && reply.status < 300) {
        await exclusive(getRt(), async () => {
          const all = await readIdempotency(project);
          const fresh = Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - Date.parse(v.atIso) < IDEMPOTENCY_TTL_MS));
          fresh[key] = { fingerprint, atIso: new Date().toISOString(), status: reply.status, body: reply.body };
          await writeIdempotency(project, fresh);
        });
      }
      return reply;
    })();
    idemPending.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      idemPending.delete(key);
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const method = req.method ?? "GET";
    const rt = getRt();
    if (path === "/api/health" && method === "GET") {
      return send(res, 200, { name: "sealpost", version: VERSION, mode: "server", project: project.config.name, domain: project.config.domain.domain, fromEmail: project.config.domain.fromEmail, transport: project.config.transport, authRequired: authRequired(), keyFingerprint: rt.issuer.fingerprint, dkimSelector: project.config.domain.dkimSelector, sinkPort: sink?.port ?? null });
    }
    if (path === "/api/openapi.json" && method === "GET") return send(res, 200, buildOpenApi(VERSION));
    if (limited(ip, "api", 600)) throw new HttpError(429, "Too many requests");
    const principal = authenticate(req);
    if (!principal) throw new HttpError(401, "Authentication required: send `Authorization: Bearer <key>` (an evk_ API key)");
    actors.set(req, principal.actor);
    const need = requiredScope(method, path);
    if (need === "admin" ? !principal.admin : !principal.scopes.has(need)) throw new HttpError(403, need === "admin" ? "Only the admin key can do this" : `This API key lacks the '${need}' scope`, { code: "insufficient_scope", requiredScope: need });

    if (path === "/api/audit" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      return send(res, 200, { ok: true, entries: await readAudit(project, Number(q.get("limit") ?? 100) || 100, q.get("actor") ?? undefined) });
    }
    if (path === "/api/keys" && method === "GET") return send(res, 200, { ok: true, keys: Object.entries(project.config.auth.keys).map(([hash, v]) => ({ id: hash.slice(0, 12), ...keyRecord(v) })) });
    if (path === "/api/keys" && method === "POST") {
      const body = z.object({ label: z.string().min(1).max(80), scopes: z.array(z.enum(KEY_SCOPES)).min(1).optional(), expiresInDays: z.number().int().min(1).max(3650).optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { label, scopes?, expiresInDays? }", { issues: issues(body.error) });
      const token = `evk_${randomBytes(24).toString("base64url")}`;
      const rec: ApiKeyRecord = { label: body.data.label, scopes: body.data.scopes ?? [...KEY_SCOPES], createdAtIso: new Date().toISOString(), ...(body.data.expiresInDays ? { expiresAtIso: new Date(Date.now() + body.data.expiresInDays * 86_400_000).toISOString() } : {}) };
      const hash = sha256(token);
      await setKeys({ ...project.config.auth.keys, [hash]: rec });
      return send(res, 201, { ok: true, id: hash.slice(0, 12), key: token, ...rec });
    }
    const keyMatch = /^\/api\/keys\/([0-9a-f]{12})$/.exec(path);
    if (keyMatch && method === "DELETE") {
      const hash = Object.keys(project.config.auth.keys).find((h) => h.startsWith(keyMatch[1]));
      if (!hash) throw new HttpError(404, "No such key");
      const { [hash]: _gone, ...rest } = project.config.auth.keys;
      void _gone;
      await setKeys(rest);
      return send(res, 200, { ok: true });
    }

    if (path === "/api/workspace" && method === "GET") return send(res, 200, await workspace());
    if (path === "/api/workspace" && method === "PUT") {
      if (!principal.admin) throw new HttpError(403, "Only the admin key can change the workspace");
      const body = z.object({ templates: z.array(EmailTemplateSchema).min(1), domain: DomainProfileSchema.optional(), domains: z.array(DomainProfileSchema).max(20).optional(), webhooks: z.array(WebhookEndpointSchema).max(10).optional(), transport: z.enum(["sink", "smtp"]).optional(), mailboxes: z.array(MailboxSchema).max(8).optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(422, "Invalid workspace", { issues: issues(body.error) });
      try {
        project = await saveWorkspace(project, body.data);
        rt.project = project;
      } catch (e) {
        throw new HttpError(422, e instanceof Error ? e.message : "Invalid workspace", { issues: (e as { issues?: string[] }).issues });
      }
      return send(res, 200, { ok: true, ...(await workspace()) });
    }
    if (path === "/api/compile" && method === "POST") {
      const body = SendSchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Invalid request", { issues: issues(body.error) });
      let template: EmailTemplate | undefined;
      if (body.data.template !== undefined) {
        const v = validateTemplate(body.data.template);
        if (!v.ok || !v.template) throw new HttpError(422, "Invalid template", { issues: v.errors });
        template = v.template;
      }
      if (!template && !body.data.templateId) throw new HttpError(400, "Send a templateId or an inline template");
      requireDomain(body.data.domain);
      try {
        const p = await previewEmail(rt, { ...body.data, templateId: body.data.templateId ?? template?.id ?? "", template, to: body.data.to }, { mime: body.data.includeMime });
        return send(res, 200, { ok: true, preflight: p.preflight, messageId: p.messageId, rawMime: p.rawMime, dkim: p.dkim });
      } catch (e) {
        throw new HttpError(404, e instanceof Error ? e.message : "Could not compile");
      }
    }
    if (path === "/api/send/batch" && method === "POST") {
      if (limited(ip, "send", 120)) throw new HttpError(429, "Too many sends");
      const body = z.object({ emails: z.array(SendSchema).min(1).max(100) }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { emails: [ …1 to 100 send requests ] }", { issues: issues(body.error) });
      const results: Array<Record<string, unknown>> = [];
      for (const item of body.data.emails) {
        if (!item.templateId || !project.templates.some((t) => t.id === item.templateId)) {
          results.push({ ok: false, status: "failed", error: item.templateId ? `No template '${item.templateId}'` : "templateId is required" });
          continue;
        }
        try {
          domainFor(rt, item.domain);
        } catch (e) {
          results.push({ ok: false, status: "failed", error: e instanceof Error ? e.message : "Unknown domain" });
          continue;
        }
        const o = await sendEmail(rt, { ...item, templateId: item.templateId, to: item.to });
        results.push({ ok: o.status === "delivered" || o.status === "queued", status: o.status, id: o.emailId, messageId: o.messageId, receiptId: o.receipt?.receiptId, queueId: o.queueId, error: o.error, preflight: o.status === "blocked" ? o.preflight : undefined });
      }
      const accepted = results.filter((r) => r.ok === true).length;
      return send(res, 200, { ok: true, accepted, rejected: results.length - accepted, results });
    }
    if (path === "/api/stats/timeseries" && method === "GET") {
      const days = Number(new URL(req.url ?? "/", "http://x").searchParams.get("days") ?? 14);
      if (!Number.isFinite(days) || days < 1 || days > 90) throw new HttpError(400, "days must be between 1 and 90");
      return send(res, 200, { ok: true, days: timeseries(await readEmails(project), days) });
    }
    if (path === "/api/stats" && method === "GET") {
      const [records, events, suppressions, queue] = await Promise.all([readLedger(project.paths.ledger, project.storage), readEvents(project, 100_000), readSuppressions(project), readQueue(project)]);
      const count = (t: string): number => events.filter((e) => e.type === t).length;
      const uniq = (t: string): number => new Set(events.filter((e) => e.type === t).map((e) => e.messageId)).size;
      const sent = records.length;
      return send(res, 200, { sent, queued: queue.length, suppressed: suppressions.length, opens: count("open"), uniqueOpens: uniq("open"), clicks: count("click"), uniqueClicks: uniq("click"), bounces: count("bounce"), complaints: count("complaint"), delivered: count("delivered"), openRate: sent ? uniq("open") / sent : 0, clickRate: sent ? uniq("click") / sent : 0, bounceRate: sent ? count("bounce") / sent : 0 });
    }
    if (path === "/api/send" && method === "POST") {
      if (limited(ip, "send", 120)) throw new HttpError(429, "Too many sends", { retryAfterSeconds: 60 });
      const raw = await readJson(req);
      const body = SendSchema.safeParse(raw);
      if (!body.success || !body.data.templateId) throw new HttpError(400, "Invalid request: a stored templateId is required", { issues: body.success ? ["templateId: required"] : issues(body.error) });
      if (!project.templates.some((t) => t.id === body.data.templateId)) throw new HttpError(404, `No template '${body.data.templateId}'`);
      requireDomain(body.data.domain);
      const key = idempotencyKeyOf(req);
      const result = await withIdempotency(key, raw, () => sendOne(body.data));
      return send(res, result.status, result.body, result.replayed ? { "idempotent-replayed": "true" } : {});
    }
    if (path === "/api/emails" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const status = q.get("status") ?? undefined;
      if (status && !["queued", "delivered", "failed", "bounced", "complained", "deferred"].includes(status)) throw new HttpError(400, "status must be queued, delivered, failed, bounced, complained or deferred");
      const since = q.get("since") ?? undefined;
      const until = q.get("until") ?? undefined;
      for (const d of [since, until]) if (d && Number.isNaN(Date.parse(d))) throw new HttpError(400, "since and until must be ISO 8601 dates");
      const page = queryEmails(await readEmails(project), { status: status as EmailStatus | undefined, to: q.get("to") ?? undefined, templateId: q.get("template") ?? undefined, domain: q.get("domain") ?? undefined, tag: q.get("tag") ?? undefined, sinceIso: since, untilIso: until, limit: Number(q.get("limit") ?? 20) || 20, before: q.get("before") ?? undefined });
      return send(res, 200, { ok: true, ...page });
    }
    const emailMatch = /^\/api\/emails\/(em_[0-9a-f]{16})$/.exec(path);
    if (emailMatch && method === "GET") {
      const rec = (await readEmails(project)).find((r) => r.id === emailMatch[1]);
      if (!rec) throw new HttpError(404, "No such email");
      return send(res, 200, { ok: true, ...rec });
    }
    if (path === "/api/unsubscribe-link" && method === "POST") {
      const body = z.object({ email: z.string().min(3).max(254), domain: z.string().optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { email, domain? }", { issues: issues(body.error) });
      requireDomain(body.data.domain);
      const url = hostedUnsubUrl(rt, domainFor(rt, body.data.domain), body.data.email);
      if (!url) throw new HttpError(409, "Hosted unsubscribe is off or the domain has no trackingBaseUrl. Set unsubscribe.hosted and domain.trackingBaseUrl.", { code: "unsubscribe_not_enabled" });
      return send(res, 200, { ok: true, url });
    }
    if (path === "/api/import" && method === "POST") {
      const raw = await readBody(req, 2_500_000);
      let json: unknown;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON body");
      }
      const body = z.object({ source: z.string().min(1).max(2_000_000), format: z.enum(["mjml", "html", "react"]).optional(), id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(), name: z.string().min(1).max(120).optional(), category: z.enum(["Auth", "Billing", "Incidents", "Growth", "Transactional"]).optional() }).safeParse(json);
      if (!body.success) throw new HttpError(400, "Body must be { source, format?, id?, name?, category? }", { issues: issues(body.error) });
      try {
        const r = importTemplate(body.data.source, { format: body.data.format, id: body.data.id, name: body.data.name, category: body.data.category });
        return send(res, 200, { ok: true, format: r.format, template: r.template, warnings: r.warnings });
      } catch (e) {
        if (e instanceof ImportError) throw new HttpError(422, e.message, { code: "import_failed", issues: e.issues });
        throw e;
      }
    }
    if (path === "/api/doctor" && method === "POST") {
      if (!principal.admin) throw new HttpError(403, "Only the admin key can run the doctor");
      const checks = await runDoctor(rt, { resolveTxt: (n) => resolveTxt(n), probe: defaultProbe, env: process.env });
      return send(res, 200, { ok: checks.every((c) => c.status !== "fail"), checks });
    }
    if (path === "/api/auth-check" && method === "POST") {
      const body = z.object({ raw: z.string().min(20).max(2_000_000) }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { raw: '<the original message or its headers>' }", { issues: issues(body.error) });
      return send(res, 200, { ok: true, report: analyzeAuthenticationResults(body.data.raw) });
    }
    if (path === "/api/setup" && method === "PUT") {
      if (!principal.admin) throw new HttpError(403, "Only the admin key can change the setup");
      const body = z.object({ domain: DomainProfileSchema.optional(), transport: z.enum(["sink", "smtp"]).optional(), mailboxes: z.array(MailboxSchema).max(8).optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(422, "Invalid setup", { issues: issues(body.error) });
      try {
        project = await saveWorkspace(project, { templates: project.templates, ...body.data });
        rt.project = project;
      } catch (e) {
        throw new HttpError(422, e instanceof Error ? e.message : "Invalid setup", { issues: (e as { issues?: string[] }).issues });
      }
      return send(res, 200, { ok: true, ...(await workspace()) });
    }
    if (path === "/api/scheduled" && method === "GET") return send(res, 200, { ok: true, scheduled: (await readScheduled(project)).slice().reverse() });
    const schedMatch = /^\/api\/scheduled\/(sch_[0-9a-f]{10})$/.exec(path);
    if (schedMatch && method === "DELETE") {
      try {
        return send(res, 200, { ok: true, scheduled: await cancelScheduled(rt, schedMatch[1]) });
      } catch (e) {
        if (e instanceof ScheduleError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    if (path === "/api/inbound" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const kind = q.get("kind") ?? undefined;
      if (kind && !["message", "bounce", "complaint"].includes(kind)) throw new HttpError(400, "kind must be message, bounce or complaint");
      for (const d of [q.get("since"), q.get("until")]) if (d && Number.isNaN(Date.parse(d))) throw new HttpError(400, "since and until must be ISO 8601 dates");
      const page = queryInbound(await listInboundAll(project), { from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, q: q.get("q") ?? undefined, kind: kind as "message" | "bounce" | "complaint" | undefined, sinceIso: q.get("since") ?? undefined, untilIso: q.get("until") ?? undefined, limit: Number(q.get("limit") ?? 20) || 20, before: q.get("before") ?? undefined });
      return send(res, 200, { ok: true, ...page });
    }
    const inMatch = /^\/api\/inbound\/(in_[0-9a-f]{16})(?:\/(raw)|\/attachments\/(\d{1,4}))?$/.exec(path);
    if (inMatch) {
      const id = inMatch[1];
      const record = await readInbound(project, id);
      if (!record) throw new HttpError(404, "No such received message");
      if (!inMatch[2] && inMatch[3] === undefined && method === "GET") {
        const raw = await readInboundRaw(project, id);
        const parsed = raw ? parseMimeMessage(raw) : null;
        return send(res, 200, { ok: true, ...record, text: parsed?.text, html: parsed?.html, headers: parsed?.headers.map((h) => ({ name: h.name, value: h.value })) ?? [] });
      }
      if (inMatch[2] && method === "GET") {
        const raw = await readInboundRaw(project, id);
        if (!raw) throw new HttpError(404, "The raw message is gone");
        return sendBytes(res, 200, raw, "message/rfc822", `${id}.eml`);
      }
      if (inMatch[3] !== undefined && method === "GET") {
        const raw = await readInboundRaw(project, id);
        const att = raw ? parseMimeMessage(raw).attachments[Number(inMatch[3])] : undefined;
        if (!att) throw new HttpError(404, "No such attachment");
        return sendBytes(res, 200, Buffer.from(att.content), att.contentType, att.filename);
      }
      if (!inMatch[2] && inMatch[3] === undefined && method === "DELETE") {
        if (!principal.admin) throw new HttpError(403, "Only the admin key can delete received mail");
        await deleteInbound(project, id);
        return send(res, 200, { ok: true });
      }
    }
    if (path === "/api/inbox" && method === "GET") return send(res, 200, { messages: await listInbox(project) });
    if (path === "/api/inbox" && method === "DELETE") {
      if (!principal.admin) throw new HttpError(403, "Only the admin key can clear the inbox");
      await clearInbox(project);
      sink?.clear();
      return send(res, 200, { ok: true });
    }
    const inboxMatch = /^\/api\/inbox\/([0-9a-f]{16})$/.exec(path);
    if (inboxMatch && method === "GET") {
      const raw = await readInboxRaw(project, inboxMatch[1]);
      if (raw === null) throw new HttpError(404, "No such message");
      const meta = (await listInbox(project)).find((m) => m.id === inboxMatch[1]);
      return send(res, 200, { ok: true, meta, raw });
    }
    if (path === "/api/suppressions" && method === "GET") return send(res, 200, { suppressions: await readSuppressions(project) });
    if (path === "/api/suppressions" && method === "POST") {
      const body = z.object({ email: z.string().min(3).max(254), reason: z.enum(["hard_bounce", "unsubscribed", "complaint"]).default("unsubscribed"), detail: z.string().max(300).optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Invalid request", { issues: issues(body.error) });
      const next = addSuppression(await readSuppressions(project), { email: body.data.email, reason: body.data.reason, detail: body.data.detail, atIso: new Date().toISOString() });
      await writeSuppressions(project, next);
      return send(res, 201, { ok: true, suppressions: next });
    }
    if (path === "/api/suppressions" && method === "DELETE") {
      const email = new URL(req.url ?? "/", "http://x").searchParams.get("email") ?? "";
      const next = removeSuppression(await readSuppressions(project), email);
      await writeSuppressions(project, next);
      return send(res, 200, { ok: true, suppressions: next });
    }
    if (path === "/api/ledger" && method === "GET") {
      const limit = Math.min(1000, Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 500) || 500);
      const records = await readLedger(project.paths.ledger, project.storage);
      return send(res, 200, { records: records.slice(0, limit), total: records.length });
    }
    if (path === "/api/ledger/verify" && method === "GET") return send(res, 200, await verifyLedgerFile(project.paths.ledger, project.storage));
    if (path === "/api/verify" && method === "POST") {
      const body = z.object({ token: z.string().min(8), inboxId: z.string().regex(/^[0-9a-f]{16}$/).optional() }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { token: 'evw_…', inboxId?: string }", { issues: issues(body.error) });
      const raw = body.data.inboxId ? await readInboxRaw(project, body.data.inboxId) : null;
      const verification = await verifyDeliveryReceipt(body.data.token, { issuerRegistry: await buildRegistry([rt.issuer.publicKeyJwk]), rawMime: raw ?? undefined });
      let payload;
      try {
        payload = decodeDeliveryReceipt(body.data.token).payload;
      } catch {
        payload = null;
      }
      return send(res, 200, { ...verification, payload });
    }
    if (path === "/api/dns" && method === "GET") {
      const name = new URL(req.url ?? "/", "http://x").searchParams.get("domain") ?? undefined;
      requireDomain(name);
      const profile = domainFor(rt, name);
      return send(res, 200, { domain: profile.domain, records: await dnsFor(name), dkimPublicKeyJwk: (await dkimFor(rt, profile)).publicKeyJwk });
    }
    if (path === "/api/domains" && method === "GET") {
      const list = [];
      for (const d of allDomains(project.config)) list.push({ ...d, primary: d.domain === project.config.domain.domain, records: await dnsFor(d.domain) });
      return send(res, 200, { domains: list });
    }
    const checkMatch = /^\/api\/domains\/([a-z0-9.-]+)\/check$/i.exec(path);
    if (checkMatch && method === "GET") {
      requireDomain(checkMatch[1]);
      const profile = domainFor(rt, checkMatch[1]);
      const results = await checkDnsRecords(await dnsFor(profile.domain), (name) => resolveTxt(name), dnsCheckOptions(rt, profile));
      return send(res, 200, { domain: profile.domain, ok: results.every((r) => r.status === "ok" || r.status === "skipped"), results });
    }
    if (path === "/api/webhooks" && method === "GET") {
      const box = await readOutbox(project);
      return send(res, 200, { endpoints: project.config.webhooks.map((w) => ({ id: w.id, url: w.url, events: w.events, secretEnvSet: process.env[w.secretEnv] !== undefined, pending: box.filter((i) => i.endpointId === w.id && i.status === "pending").length, delivered: box.filter((i) => i.endpointId === w.id && i.status === "delivered").length, failed: box.filter((i) => i.endpointId === w.id && i.status === "failed").length })) });
    }
    if (path === "/api/webhooks/deliveries" && method === "GET") return send(res, 200, { deliveries: (await readOutbox(project)).slice(-100).reverse().map(publicDelivery) });
    const hookTest = /^\/api\/webhooks\/([a-z][a-z0-9_-]{1,40})\/test$/.exec(path);
    if (hookTest && method === "POST") {
      if (!principal.admin) throw new HttpError(403, "Only the admin key can send test events");
      if (!project.config.webhooks.some((w) => w.id === hookTest[1])) throw new HttpError(404, "No such webhook endpoint");
      const event = await emitEvent(rt, "webhook.ping", { message: "Hello from Sealpost" }, hookTest[1]);
      await processOutbox(rt);
      return send(res, 202, { ok: true, eventId: event?.id });
    }
    if (path === "/api/audiences" && method === "GET") return send(res, 200, { audiences: (await readAudiences(project)).map((a) => ({ id: a.id, name: a.name, createdAtIso: a.createdAtIso, contacts: a.contacts.length })) });
    if (path === "/api/audiences" && method === "POST") {
      const body = z.object({ name: z.string().min(1).max(120) }).safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Body must be { name }", { issues: issues(body.error) });
      return send(res, 201, { ok: true, audience: await bc(() => createAudience(rt, body.data.name)) });
    }
    const audMatch = /^\/api\/audiences\/(aud_[0-9a-f]{10})(\/contacts)?$/.exec(path);
    if (audMatch) {
      const aid = audMatch[1];
      if (!audMatch[2] && method === "GET") {
        const a = (await readAudiences(project)).find((x) => x.id === aid);
        if (!a) throw new HttpError(404, "No such audience");
        const q = new URL(req.url ?? "/", "http://x").searchParams;
        const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
        const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 100) || 100));
        return send(res, 200, { id: a.id, name: a.name, createdAtIso: a.createdAtIso, total: a.contacts.length, contacts: a.contacts.slice(offset, offset + limit) });
      }
      if (!audMatch[2] && method === "DELETE") {
        await bc(() => deleteAudience(rt, aid));
        return send(res, 200, { ok: true });
      }
      if (audMatch[2] && method === "POST") {
        const body = z.object({ contacts: z.array(z.object({ email: z.string().min(3).max(254), name: z.string().max(200).optional(), variables: z.record(z.string(), ScalarSchema).optional() }).strict()).min(1).max(10_000) }).safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, "Body must be { contacts: [{ email, name?, variables? }] } (1 to 10000)", { issues: issues(body.error) });
        const r = await bc(() => addContacts(rt, aid, body.data.contacts));
        return send(res, 200, { ok: true, added: r.added, updated: r.updated, rejected: r.rejected, total: r.audience.contacts.length });
      }
      if (audMatch[2] && method === "DELETE") {
        const email = new URL(req.url ?? "/", "http://x").searchParams.get("email") ?? "";
        const a = await bc(() => removeContact(rt, aid, email));
        return send(res, 200, { ok: true, total: a.contacts.length });
      }
    }
    if (path === "/api/broadcasts" && method === "GET") return send(res, 200, { broadcasts: (await readBroadcasts(project)).map(publicBroadcast).reverse() });
    if (path === "/api/broadcasts" && method === "POST") {
      const body = z.object({ name: z.string().min(1).max(120), audienceId: z.string(), templateId: z.string(), domain: z.string().optional(), variables: z.record(z.string(), ScalarSchema).optional(), scheduledAtIso: z.string().optional(), ratePerMinute: z.number().int().optional() }).strict().safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "Invalid broadcast", { issues: issues(body.error) });
      requireDomain(body.data.domain);
      return send(res, 201, { ok: true, broadcast: await bc(() => createBroadcast(rt, body.data)) });
    }
    const brdMatch = /^\/api\/broadcasts\/(brd_[0-9a-f]{10})(\/cancel)?$/.exec(path);
    if (brdMatch) {
      if (!brdMatch[2] && method === "GET") {
        const b = (await readBroadcasts(project)).find((x) => x.id === brdMatch[1]);
        if (!b) throw new HttpError(404, "No such broadcast");
        return send(res, 200, publicBroadcast(b));
      }
      if (brdMatch[2] && method === "POST") return send(res, 200, { ok: true, broadcast: await bc(() => cancelBroadcast(rt, brdMatch[1])) });
    }
    if (path === "/api/queue" && method === "GET") return send(res, 200, { items: (await readQueue(project)).map((q) => ({ ...q, raw: undefined })) });
    if (path === "/api/queue/run" && method === "POST") return send(res, 200, { ok: true, ...(await processQueue(rt)) });
    if (path === "/api/events" && method === "GET") return send(res, 200, { events: await readEvents(project), tracked: Object.keys(await readTracking(project)).length });
    throw new HttpError(404, "Not found");
  }

  /** Public endpoints hit by mail clients: the open pixel and the click redirect. They never reveal whether an id exists. */
  async function handleTracking(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    if (limited(ip, "track", 300)) throw new HttpError(429, "Too many requests");
    const tracking = await readTracking(project);
    const ua = String(req.headers["user-agent"] ?? "").slice(0, 200);
    const open = /^\/o\/(.+)\.gif$/.exec(path);
    if (open) {
      const id = decodeURIComponent(open[1]);
      if (tracking[id]) {
        await appendEvent(project, { atIso: new Date().toISOString(), type: "open", messageId: id, userAgent: ua });
        await logEvent(project, { messageId: id }, "opened", { userAgent: ua });
        emitSafely(getRt(), "email.opened", { messageId: id, to: tracking[id].to, templateId: tracking[id].templateId });
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/gif", "content-length": PIXEL.length, "cache-control": "no-store" });
      res.end(PIXEL);
      return;
    }
    const click = /^\/c\/(.+)$/.exec(path);
    if (click) {
      const id = decodeURIComponent(click[1]);
      const url = new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? "";
      // Only a URL that was in this message may be redirected to: this is never an open redirect.
      if (tracking[id] && tracking[id].links.includes(url) && /^https?:\/\//i.test(url)) {
        await appendEvent(project, { atIso: new Date().toISOString(), type: "click", messageId: id, url, userAgent: ua });
        await logEvent(project, { messageId: id }, "clicked", { url });
        emitSafely(getRt(), "email.clicked", { messageId: id, to: tracking[id].to, templateId: tracking[id].templateId, url });
        res.writeHead(302, { ...SECURITY_HEADERS, location: url, "cache-control": "no-store" });
        res.end();
        return;
      }
      throw new HttpError(404, "Unknown link");
    }
    throw new HttpError(404, "Not found");
  }

  /** Bounce / complaint feedback pushed by the upstream relay. Disabled unless a shared secret is configured. */
  async function handleRelayHook(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const secret = options.webhookSecret ?? process.env.SEALPOST_WEBHOOK_SECRET ?? "";
    if (secret === "") throw new HttpError(404, "Not found");
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    if (limited(ip, "hook", 600)) throw new HttpError(429, "Too many requests");
    const provider = /^\/hooks\/relay\/([a-z]+)$/.exec(path)?.[1];
    if (!provider || !RELAY_PROVIDERS.includes(provider as RelayProvider)) throw new HttpError(404, "Unknown relay provider");
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
    if (!safeEqual(token, secret)) throw new HttpError(401, "Invalid webhook token");
    const parsed = parseRelayEvents(provider as RelayProvider, await readJson(req));
    const rt = getRt();
    let suppressed = 0;
    const kinds: Record<string, string> = { delivered: "email.delivered", hard_bounce: "email.bounced", soft_bounce: "email.deferred", complaint: "email.complained" };
    await exclusive(rt, async () => {
      let list = await readSuppressions(project);
      for (const e of parsed.events) {
        const type = e.kind === "delivered" ? "delivered" : e.kind === "complaint" ? "complaint" : e.kind === "hard_bounce" ? "bounce" : "deferred";
        await appendEvent(project, { atIso: new Date().toISOString(), type, messageId: e.relayMessageId ?? "", email: e.email, detail: e.detail, provider });
        if (e.kind === "hard_bounce" || e.kind === "complaint") {
          list = addSuppression(list, { email: e.email, reason: e.kind === "complaint" ? "complaint" : "hard_bounce", detail: e.detail ?? `reported by ${provider}`, atIso: new Date().toISOString() });
          suppressed++;
        }
      }
      if (suppressed > 0) await writeSuppressions(project, list);
    });
    const logKinds = { delivered: "delivered", hard_bounce: "bounced", soft_bounce: "deferred", complaint: "complained" } as const;
    for (const e of parsed.events) {
      await logEvent(project, { email: e.email }, logKinds[e.kind], { detail: e.detail, source: provider });
      emitSafely(rt, kinds[e.kind], { email: e.email, messageId: e.relayMessageId, detail: e.detail, source: provider });
    }
    send(res, 200, { ok: true, received: parsed.events.length, suppressed, confirmationUrl: parsed.confirmationUrl });
  }

  /** Mail pushed by a relay's inbound webhook (SES→SNS, SendGrid raw, Mailgun MIME, or a plain POST of the message). */
  async function handleInboundHook(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const secret = options.webhookSecret ?? process.env.SEALPOST_WEBHOOK_SECRET ?? "";
    if (secret === "") throw new HttpError(404, "Not found");
    if (path !== "/hooks/inbound/raw") throw new HttpError(404, "Not found");
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    if (limited(ip, "inhook", 600)) throw new HttpError(429, "Too many requests");
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
    if (!safeEqual(token, secret)) throw new HttpError(401, "Invalid webhook token");
    const limit = project.config.inbound.maxMessageMb * 1024 * 1024 + 65_536;
    const raw = extractRawMessage(req.headers["content-type"], await readBody(req, limit));
    if (!raw) throw new HttpError(400, "No message found: post the raw message, JSON { raw }, an SES/SNS notification with content, or a form with an 'email' or 'body-mime' field");
    if (raw.length > project.config.inbound.maxMessageMb * 1024 * 1024) throw new HttpError(413, "Message too large");
    const record = await ingestInbound(getRt(), raw, { source: "webhook" });
    send(res, 200, { ok: true, id: record.id, kind: record.kind });
  }

  /** The page a recipient lands on from an unsubscribe link. GET only shows it; only POST (a button, or an RFC 8058 one-click) changes anything. */
  async function handleUnsub(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (limited(ip, "unsub", 60)) throw new HttpError(429, "Too many requests");
    const m = /^\/u\/([A-Za-z0-9_.-]+?)(\/resubscribe)?$/.exec(path);
    const claims = m ? verifyUnsubToken(getRt().secret, m[1]) : null;
    const page = (status: number, title: string, body: string, form?: { action: string; label: string }): void => {
      const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#fafafa;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;max-width:420px;width:calc(100% - 32px)}h1{font-size:20px;margin:0 0 8px}p{color:#52525b;line-height:1.5;margin:8px 0}button{margin-top:16px;background:#18181b;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}</style></head><body><main><h1>${esc(title)}</h1><p>${body}</p>${form ? `<form method="post" action="${esc(form.action)}"><button type="submit">${esc(form.label)}</button></form>` : ""}</main></body></html>`;
      res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    };
    if (!m || !claims) return page(404, "Link not valid", "This unsubscribe link is not valid. If you copied it, make sure the whole link was included.");
    const email = claims.e;
    const base = `/u/${m[1]}`;
    const rt = getRt();
    if (req.method === "GET" || req.method === "HEAD") return page(200, "Unsubscribe", `Stop emails to <b>${email.replace(/[&<>]/g, "")}</b> from this sender?`, { action: base, label: "Unsubscribe" });
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    await readBody(req, 4096); // drain; RFC 8058 posts `List-Unsubscribe=One-Click`
    if (m[2]) {
      await exclusive(rt, async () => {
        const list = await readSuppressions(project);
        const hit = list.find((x) => x.email === email && x.reason === "unsubscribed");
        if (hit) await writeSuppressions(project, removeSuppression(list, email));
      });
      return page(200, "You're subscribed again", "You will receive emails from this sender again.", { action: base, label: "Unsubscribe again" });
    }
    let first = false;
    await exclusive(rt, async () => {
      const list = await readSuppressions(project);
      if (!list.some((x) => x.email === email)) {
        first = true;
        await writeSuppressions(project, addSuppression(list, { email, reason: "unsubscribed", detail: "hosted unsubscribe link", atIso: new Date().toISOString() }));
      }
    });
    if (first) {
      if (claims.i) await logEvent(project, { id: claims.i }, "unsubscribed", { detail: email, source: "hosted-link" });
      emitSafely(rt, "email.unsubscribed", { email, domain: claims.d, emailId: claims.i, source: "hosted-link" });
    }
    page(200, "You're unsubscribed", `<b>${email.replace(/[&<>]/g, "")}</b> will not receive further emails from this sender.`, { action: `${base}/resubscribe`, label: "Undo: subscribe again" });
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    if (!existsSync(studioDir)) {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Sealpost</title><body style=\"font-family:system-ui;padding:2rem\"><h1>Sealpost gateway is running</h1><p>The Studio UI is not bundled in this build. The JSON API is available under <code>/api</code>.</p></body>");
      return;
    }
    const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
    let file = resolve(studioDir, clean === "" ? "index.html" : clean);
    if (file !== studioDir && !file.startsWith(studioDir + sep)) throw new HttpError(403, "Forbidden");
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) file = existsSync(`${file}.html`) ? `${file}.html` : join(studioDir, "index.html");
    const data = await readFile(file);
    const immutable = file.includes(`${sep}_next${sep}static${sep}`);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(data);
  }

  let lastPrune = 0;
  let working = false;
  const worker = setInterval(() => {
    if (Date.now() - lastPrune > 600_000) {
      lastPrune = Date.now();
      void pruneInbound(getRt().project, getRt().project.config.inbound.retentionDays).catch(() => undefined);
    }
    if (working) return;
    working = true;
    void Promise.all([processQueue(getRt()), processScheduled(getRt()), processBroadcasts(getRt()), processOutbox(getRt())])
      .catch((e: unknown) => process.stderr.write(`[sealpost] queue: ${e instanceof Error ? e.message : String(e)}\n`))
      .finally(() => {
        working = false;
      });
  }, 1000);
  worker.unref();

  const server = createServer((req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const requestId = `req_${randomBytes(6).toString("hex")}`;
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      if (!path.startsWith("/api/")) return;
      const failedAuth = res.statusCode === 401 || res.statusCode === 403;
      if ((req.method ?? "GET") === "GET" && !failedAuth) return;
      void appendAudit(project, { atIso: new Date().toISOString(), actor: actors.get(req) ?? "anonymous", method: req.method ?? "GET", path, status: res.statusCode, ip, requestId }).catch(() => undefined);
    });
    const path = (req.url ?? "/").split("?")[0];
    const run = path.startsWith("/api/") ? handleApi(req, res, path, ip) : path.startsWith("/hooks/relay/") ? handleRelayHook(req, res, path, ip) : path.startsWith("/hooks/inbound/") ? handleInboundHook(req, res, path, ip) : path.startsWith("/u/") ? handleUnsub(req, res, path, ip) : path.startsWith("/o/") || path.startsWith("/c/") ? handleTracking(req, res, path, ip) : req.method === "GET" || req.method === "HEAD" ? serveStatic(res, path) : Promise.reject(new HttpError(405, "Method not allowed"));
    run.catch((e: unknown) => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message, code: DEFAULT_CODES[e.status] ?? "error", requestId, ...e.extra }, e.status === 429 ? { "retry-after": "60" } : {});
      process.stderr.write(`[sealpost] ${requestId} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      return send(res, 500, { ok: false, error: "Internal server error", code: "internal_error", requestId });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4320, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 4320);

  let inbound: RunningInboundSmtp | null = null;
  const inCfg = project.config.inbound;
  if (inCfg.enabled) {
    try {
      const dir = project.dir;
      const tls = inCfg.tls ? { key: readFileSync(resolve(dir, inCfg.tls.keyFile), "utf8"), cert: readFileSync(resolve(dir, inCfg.tls.certFile), "utf8") } : undefined;
      inbound = await startInboundSmtp({
        host: inCfg.host,
        port: inCfg.port,
        hostname: inCfg.mxHost ?? project.config.domain.domain,
        maxMessageBytes: inCfg.maxMessageMb * 1024 * 1024,
        tls,
        acceptRecipient: (addr) => {
          const cfg = getRt().project.config;
          const accepted = (cfg.inbound.domains.length > 0 ? cfg.inbound.domains : allDomains(cfg).map((d) => d.domain)).map((d) => d.toLowerCase());
          return accepted.includes(addr.slice(addr.lastIndexOf("@") + 1).toLowerCase()) ? true : { code: 550, text: "5.7.1 Relay access denied" };
        },
        onMessage: async (raw, env) => {
          await ingestInbound(getRt(), raw, { source: "smtp", envelopeFrom: env.from, envelopeTo: env.to, remoteAddress: env.remoteAddress, secure: env.secure });
        },
      });
    } catch (e) {
      clearInterval(worker);
      await new Promise<void>((r) => server.close(() => r()));
      await sink?.close();
      throw new Error(`Could not start the inbound SMTP listener on ${inCfg.host}:${inCfg.port}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let submission: RunningInboundSmtp | null = null;
  const subCfg = project.config.submission;
  if (subCfg.enabled) {
    try {
      const loop = ["127.0.0.1", "localhost", "::1"].includes(subCfg.host);
      if (!loop && !subCfg.tls) throw new Error("submission on a non-loopback address needs submission.tls, because clients send their API key as the SMTP password");
      if (!authRequired()) throw new Error("submission needs an API key: set SEALPOST_API_KEY or create one with `sealpost auth add-key`");
      const tls = subCfg.tls ? { key: readFileSync(resolve(project.dir, subCfg.tls.keyFile), "utf8"), cert: readFileSync(resolve(project.dir, subCfg.tls.certFile), "utf8") } : undefined;
      submission = await startInboundSmtp({
        host: subCfg.host,
        port: subCfg.port,
        hostname: project.config.domain.domain,
        maxMessageBytes: subCfg.maxMessageMb * 1024 * 1024,
        tls,
        implicitTls: subCfg.implicitTls,
        requireAuth: true,
        addReceived: false,
        maxRecipients: 100,
        auth: (_user, password) => {
          const principal = principalForToken(getRt().project.config, masterKey, password);
          return principal && principal.scopes.has("send") ? principal.actor : null;
        },
        acceptRecipient: async (addr) => (isSuppressed(await readSuppressions(project), addr) ? { code: 550, text: "5.7.1 Recipient is on the suppression list" } : true),
        onMessage: async (raw, env) => {
          try {
            await submitMessage(getRt(), raw, env);
          } catch (e) {
            if (e instanceof SubmissionError) throw e;
            process.stderr.write(`[sealpost] submission: ${e instanceof Error ? e.message : String(e)}\n`);
            throw e;
          }
        },
      });
    } catch (e) {
      clearInterval(worker);
      await inbound?.close();
      await new Promise<void>((r) => server.close(() => r()));
      await sink?.close();
      throw new Error(`Could not start the SMTP submission listener: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    server,
    port,
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    fingerprint: getRt().issuer.fingerprint,
    sinkPort: sink?.port ?? 0,
    inboundPort: inbound?.port ?? null,
    submissionPort: submission?.port ?? null,
    close: async () => {
      clearInterval(worker);
      await inbound?.close();
      await submission?.close();
      await new Promise<void>((r) => server.close(() => r()));
      await sink?.close();
    },
  };
}
