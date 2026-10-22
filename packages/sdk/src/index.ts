export type Scalar = string | number | boolean;
export type Variables = Record<string, Scalar>;

export interface Attachment {
  filename: string;
  contentType: string;
  /** Base64 of the file bytes. */
  contentBase64: string;
}

export interface SendEmailOptions {
  /** Stored template id (see `GET /api/workspace`). */
  template: string;
  /** Sending domain (one of the project's configured domains). Defaults to the primary domain. */
  domain?: string;
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  variables?: Variables;
  /** Fill missing variables from each variable's default or sample value. */
  autoFill?: boolean;
  attachments?: Attachment[];
  /** Return the DKIM-signed raw message in the response. */
  includeMime?: boolean;
  /**
   * Send as a reply: a Message-ID, or the `in_…` id of a received message (`inbound.list`). Adds In-Reply-To and
   * References, signed by DKIM, so mail clients thread it.
   */
  inReplyTo?: string;
  /** ISO 8601 time or a Date: send later (up to 90 days ahead). The gate runs now, so a bad request is refused immediately, and again at that time. */
  scheduledAt?: string | Date;
  /** Labels to filter logs by (up to 10). */
  tags?: EmailTag[];
  /** Your own key/value data, stored with the email record (up to 20 keys). */
  metadata?: Record<string, string>;
  /**
   * Sent as the `Idempotency-Key` header. Retrying with the same key and body within 24 h returns the original
   * result (`replayed: true`) instead of sending again; the same key with a different body is a 409.
   */
  idempotencyKey?: string;
}

export interface EmailTag {
  name: string;
  value: string;
}

export type EmailStatus = "queued" | "delivered" | "failed" | "bounced" | "complained" | "deferred";

export interface EmailEvent {
  type: EmailStatus | "opened" | "clicked" | "replied" | "unsubscribed";
  atIso: string;
  detail?: string;
  url?: string;
}

/** One email as stored by the server, with its timeline. */
export interface EmailRecord {
  id: string;
  messageId: string;
  createdAtIso: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  templateId: string;
  domain: string;
  tags: EmailTag[];
  metadata: Record<string, string>;
  /** The latest of queued / delivered / failed / bounced / complained / deferred. */
  status: EmailStatus;
  opens: number;
  clicks: number;
  /** Received messages that replied to this email. */
  replies: number;
  receiptId?: string;
  events: EmailEvent[];
}

export interface ListEmailsOptions {
  status?: EmailStatus;
  /** Substring of any recipient address. */
  to?: string;
  template?: string;
  domain?: string;
  /** `name` or `name:value`. */
  tag?: string;
  since?: string | Date;
  until?: string | Date;
  /** 1 to 100 (default 20). */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  before?: string;
}

export interface EmailPage {
  data: EmailRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PreflightCheck {
  /** `EW-101` … `EW-108`. */
  code: string;
  severity: "ok" | "warn" | "block";
  message: string;
}

export interface Preflight {
  gate: "CLEAR" | "WARN" | "BLOCKED";
  score: number;
  checks: PreflightCheck[];
  idempotencyKey: string;
}

export interface ScheduledSend {
  /** `sch_…` */
  id: string;
  scheduledAtIso: string;
  createdAtIso: string;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  result?: { status: string; emailId?: string; messageId?: string; error?: string };
}

export interface SendResult {
  /** `em_…`: use with `emails.get`. */
  id: string;
  /** True when this response was replayed from an earlier request with the same idempotency key. */
  replayed: boolean;
  status: "delivered" | "queued" | "scheduled";
  messageId: string;
  /** Set when `status` is `scheduled`. */
  scheduledAt?: string;
  /** The evw_ receipt token (present when delivered). */
  receipt?: string;
  receiptId?: string;
  queueId?: string;
  preflight: Preflight;
  rawMime?: string;
}

export interface BatchItemResult {
  ok: boolean;
  status: "delivered" | "queued" | "failed" | "blocked";
  messageId?: string;
  receiptId?: string;
  queueId?: string;
  error?: string;
  preflight?: Preflight;
}

export interface BatchResult {
  accepted: number;
  rejected: number;
  results: BatchItemResult[];
}

export interface Stats {
  sent: number;
  queued: number;
  suppressed: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  bounces: number;
  complaints: number;
  delivered: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
}

export interface SealpostEvent {
  atIso: string;
  type: "open" | "click" | "delivered" | "bounce" | "deferred" | "complaint";
  messageId: string;
  email?: string;
  url?: string;
  detail?: string;
  provider?: string;
}

export interface Suppression {
  email: string;
  reason: "hard_bounce" | "unsubscribed" | "complaint";
  detail?: string;
  atIso: string;
}

export interface Contact {
  email: string;
  name?: string;
  variables?: Record<string, Scalar>;
  addedAtIso?: string;
}

export interface AudienceSummary {
  id: string;
  name: string;
  createdAtIso: string;
  contacts: number;
}

export interface BroadcastCounts {
  total: number;
  delivered: number;
  queued: number;
  suppressed: number;
  duplicate: number;
  blocked: number;
  failed: number;
}

export interface Broadcast {
  id: string;
  name: string;
  audienceId: string;
  templateId: string;
  domain?: string;
  variables: Record<string, Scalar>;
  scheduledAtIso: string;
  ratePerMinute: number;
  status: "scheduled" | "sending" | "completed" | "cancelled";
  createdAtIso: string;
  startedAtIso?: string;
  completedAtIso?: string;
  cursor: number;
  counts: BroadcastCounts;
}

export interface CreateBroadcastOptions {
  name: string;
  audienceId: string;
  template: string;
  domain?: string;
  variables?: Record<string, Scalar>;
  /** ISO 8601 time or a Date. Omit to start immediately. */
  scheduledAt?: string | Date;
  ratePerMinute?: number;
}

export interface DnsRecord {
  purpose: "SPF" | "DKIM" | "DMARC" | "MX";
  type: "TXT" | "MX";
  name: string;
  fqdn: string;
  value: string;
  zoneValue: string;
  note: string;
}

export interface DomainInfo {
  domain: string;
  fromName: string;
  fromEmail: string;
  dkimSelector: string;
  dmarcPolicy: string;
  primary: boolean;
  records: DnsRecord[];
}

export interface DnsCheckResult {
  purpose: DnsRecord["purpose"];
  fqdn: string;
  status: "ok" | "missing" | "mismatch" | "skipped";
  detail: string;
  found: string[];
}

export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  createdAt: string;
  data: T;
}

export interface WebhookVerification {
  ok: boolean;
  reason?: "malformed" | "stale" | "mismatch";
}

export interface InboundAttachment {
  index: number;
  filename: string;
  contentType: string;
  disposition: "attachment" | "inline";
  contentId?: string;
  size: number;
}

export interface InboundAddress {
  name?: string;
  address: string;
}

/** A received message. `bounce` and `complaint` reports are only acted on when they match mail this server sent. */
export interface InboundRecord {
  /** `in_…` */
  id: string;
  receivedAtIso: string;
  source: "smtp" | "webhook" | "import";
  envelope: { from: string; to: string[] };
  remoteAddress?: string;
  secure?: boolean;
  from?: InboundAddress;
  to: InboundAddress[];
  cc: InboundAddress[];
  replyTo: InboundAddress[];
  subject: string;
  dateIso?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  snippet: string;
  hasText: boolean;
  hasHtml: boolean;
  attachments: InboundAttachment[];
  size: number;
  dkim: { result: "pass" | "fail" | "none" | "temperror"; domain?: string; selector?: string; detail?: string };
  kind: "message" | "bounce" | "complaint";
  /** An out-of-office or other automatic reply: do not answer it. */
  autoReply: boolean;
  bounce?: { recipients: Array<{ email: string; status?: string; action: string; diagnostic?: string; hard: boolean }>; originalMessageId?: string; unparsed: boolean };
  complaint?: { recipient?: string; feedbackType?: string; originalMessageId?: string };
  /** The `em_…` email this answers or reports on. */
  threadEmailId?: string;
  reportVerified?: boolean;
  problems: string[];
}

/** `html` is untrusted: show it only in a sandboxed frame with remote content blocked. */
export interface InboundMessage extends InboundRecord {
  text?: string;
  html?: string;
  headers: Array<{ name: string; value: string }>;
}

export interface ListInboundOptions {
  from?: string;
  to?: string;
  /** Substring of the subject or snippet. */
  q?: string;
  kind?: InboundRecord["kind"];
  since?: string | Date;
  until?: string | Date;
  limit?: number;
  before?: string;
}

export interface InboundPage {
  data: InboundRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SealpostError {
  /** HTTP status, or 0 for a network failure. */
  status: number;
  /** Machine code when the API supplies one: `preflight_blocked`, `smtp_failed`, … */
  code?: string;
  message: string;
  /** Matches the server's `x-request-id` header; quote it when reporting a problem. */
  requestId?: string;
  /** Present on `preflight_blocked`. */
  preflight?: Preflight;
}

/** Resend-style result: exactly one of `data` and `error` is set. Methods never throw for API or network errors. */
export type Result<T> = { data: T; error: null } | { data: null; error: SealpostError };

export interface SealpostOptions {
  apiKey: string;
  /** Default `http://127.0.0.1:4320`. */
  baseUrl?: string;
  /** Inject a fetch implementation (tests, proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export class Sealpost {
  private readonly base: string;
  private readonly key: string;
  private readonly doFetch: typeof fetch;
  private readonly timeout: number;

  constructor(options: SealpostOptions) {
    if (!options.apiKey) throw new Error("Sealpost: apiKey is required");
    this.key = options.apiKey;
    this.base = (options.baseUrl ?? "http://127.0.0.1:4320").replace(/\/+$/, "");
    this.doFetch = options.fetch ?? ((...a) => fetch(...a));
    this.timeout = options.timeoutMs ?? 30_000;
  }

  private async call<T>(method: string, path: string, body?: unknown, pick: (json: Obj, res: Response) => T = (j) => j as T, extraHeaders: Record<string, string> = {}): Promise<Result<T>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      const o: Obj = isObj(json) ? json : {};
      if (!res.ok) {
        return { data: null, error: { status: res.status, code: typeof o.code === "string" ? o.code : undefined, message: typeof o.error === "string" ? o.error : `HTTP ${res.status}`, requestId: typeof o.requestId === "string" ? o.requestId : (res.headers.get("x-request-id") ?? undefined), preflight: isObj(o.preflight) ? (o.preflight as unknown as Preflight) : undefined } };
      }
      return { data: pick(o, res), error: null };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return { data: null, error: { status: 0, message: aborted ? `Request timed out after ${this.timeout} ms` : e instanceof Error ? e.message : "Network error" } };
    } finally {
      clearTimeout(timer);
    }
  }

  private async bytes(path: string): Promise<Result<{ bytes: Uint8Array; contentType: string; filename?: string }>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await this.doFetch(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.key}` }, signal: ctl.signal });
      if (!res.ok) {
        let o: Obj = {};
        try {
          const j: unknown = await res.json();
          if (isObj(j)) o = j;
        } catch {
          /* not JSON */
        }
        return { data: null, error: { status: res.status, code: typeof o.code === "string" ? o.code : undefined, message: typeof o.error === "string" ? o.error : `HTTP ${res.status}`, requestId: typeof o.requestId === "string" ? o.requestId : (res.headers.get("x-request-id") ?? undefined) } };
      }
      const disposition = res.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      return { data: { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream", filename: encoded ? decodeURIComponent(encoded) : undefined }, error: null };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return { data: null, error: { status: 0, message: aborted ? `Request timed out after ${this.timeout} ms` : e instanceof Error ? e.message : "Network error" } };
    } finally {
      clearTimeout(timer);
    }
  }

  readonly inbound = {
    /** Received mail, newest first. Page with `before: page.nextCursor`. */
    list: (o: ListInboundOptions = {}): Promise<Result<InboundPage>> => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries({ from: o.from, to: o.to, q: o.q, kind: o.kind, since: o.since instanceof Date ? o.since.toISOString() : o.since, until: o.until instanceof Date ? o.until.toISOString() : o.until, limit: o.limit, before: o.before })) if (v !== undefined) q.set(k, String(v));
      return this.call("GET", `/api/inbound?${q.toString()}`, undefined, (j) => ({ data: (Array.isArray(j.data) ? j.data : []) as InboundRecord[], hasMore: j.hasMore === true, nextCursor: typeof j.nextCursor === "string" ? j.nextCursor : null }));
    },
    /** One message with decoded `text`, `html` and headers. */
    get: (id: string): Promise<Result<InboundMessage>> => this.call("GET", `/api/inbound/${encodeURIComponent(id)}`, undefined, (j) => j as unknown as InboundMessage),
    /** The original bytes as received. */
    raw: (id: string): Promise<Result<{ bytes: Uint8Array; contentType: string; filename?: string }>> => this.bytes(`/api/inbound/${encodeURIComponent(id)}/raw`),
    /** One attachment (`InboundRecord.attachments[n].index`). */
    attachment: (id: string, index: number): Promise<Result<{ bytes: Uint8Array; contentType: string; filename?: string }>> => this.bytes(`/api/inbound/${encodeURIComponent(id)}/attachments/${index}`),
    delete: (id: string): Promise<Result<true>> => this.call("DELETE", `/api/inbound/${encodeURIComponent(id)}`, undefined, () => true as const),
  };

  readonly emails = {
    /** Send one email. A `403 preflight_blocked` means nothing was sent; inspect `error.preflight`. */
    send: (o: SendEmailOptions): Promise<Result<SendResult>> =>
      this.call("POST", "/api/send", toBody(o), (j, res) => ({
        id: String(j.id ?? ""),
        replayed: res.headers.get("idempotent-replayed") === "true",
        status: j.status === "queued" ? "queued" : j.status === "scheduled" ? "scheduled" : "delivered",
        scheduledAt: typeof j.scheduledAt === "string" ? j.scheduledAt : undefined,
        messageId: String(j.messageId ?? ""),
        receipt: isObj(j.receipt) && typeof j.receipt.token === "string" ? j.receipt.token : undefined,
        receiptId: isObj(j.receipt) && typeof j.receipt.receiptId === "string" ? j.receipt.receiptId : undefined,
        queueId: typeof j.queueId === "string" ? j.queueId : undefined,
        preflight: j.preflight as Preflight,
        rawMime: typeof j.rawMime === "string" ? j.rawMime : undefined,
      }), o.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : {}),
    /** One email with its status timeline (opens, clicks, bounces, …). */
    get: (id: string): Promise<Result<EmailRecord>> => this.call("GET", `/api/emails/${encodeURIComponent(id)}`, undefined, (j) => j as unknown as EmailRecord),
    /** Newest first. Page with `before: page.nextCursor`. */
    list: (o: ListEmailsOptions = {}): Promise<Result<EmailPage>> => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries({ status: o.status, to: o.to, template: o.template, domain: o.domain, tag: o.tag, since: o.since instanceof Date ? o.since.toISOString() : o.since, until: o.until instanceof Date ? o.until.toISOString() : o.until, limit: o.limit, before: o.before })) if (v !== undefined) q.set(k, String(v));
      return this.call("GET", `/api/emails?${q.toString()}`, undefined, (j) => ({ data: (Array.isArray(j.data) ? j.data : []) as EmailRecord[], hasMore: j.hasMore === true, nextCursor: typeof j.nextCursor === "string" ? j.nextCursor : null }));
    },
    /** Send up to 100 emails in one call; failures are reported per item. */
    batch: (items: SendEmailOptions[]): Promise<Result<BatchResult>> => this.call("POST", "/api/send/batch", { emails: items.map(toBody) }, (j) => ({ accepted: Number(j.accepted ?? 0), rejected: Number(j.rejected ?? 0), results: (Array.isArray(j.results) ? j.results : []) as BatchItemResult[] })),
    /** Compile and run the deliverability gate without sending. */
    preview: (o: SendEmailOptions): Promise<Result<{ preflight: Preflight; messageId: string; rawMime?: string }>> =>
      this.call("POST", "/api/compile", toBody(o), (j) => ({ preflight: j.preflight as Preflight, messageId: String(j.messageId ?? ""), rawMime: typeof j.rawMime === "string" ? j.rawMime : undefined })),
  };

  readonly scheduled = {
    list: (): Promise<Result<ScheduledSend[]>> => this.call("GET", "/api/scheduled", undefined, (j) => (Array.isArray(j.scheduled) ? (j.scheduled as ScheduledSend[]) : [])),
    /** Cancel a scheduled send that has not run yet. */
    cancel: (id: string): Promise<Result<ScheduledSend>> => this.call("DELETE", `/api/scheduled/${encodeURIComponent(id)}`, undefined, (j) => j.scheduled as ScheduledSend),
  };

  /** A hosted one-click unsubscribe URL for an address (needs `unsubscribe.hosted` and a `trackingBaseUrl` on the server). */
  unsubscribeLink = (email: string, domain?: string): Promise<Result<string>> => this.call("POST", "/api/unsubscribe-link", { email, domain }, (j) => String(j.url ?? ""));

  readonly suppressions = {
    list: (): Promise<Result<Suppression[]>> => this.call("GET", "/api/suppressions", undefined, (j) => (Array.isArray(j.suppressions) ? (j.suppressions as Suppression[]) : [])),
    add: (email: string, reason: Suppression["reason"] = "unsubscribed", detail?: string): Promise<Result<Suppression[]>> => this.call("POST", "/api/suppressions", { email, reason, detail }, (j) => (Array.isArray(j.suppressions) ? (j.suppressions as Suppression[]) : [])),
    remove: (email: string): Promise<Result<Suppression[]>> => this.call("DELETE", `/api/suppressions?email=${encodeURIComponent(email)}`, undefined, (j) => (Array.isArray(j.suppressions) ? (j.suppressions as Suppression[]) : [])),
  };

  readonly events = {
    list: (): Promise<Result<SealpostEvent[]>> => this.call("GET", "/api/events", undefined, (j) => (Array.isArray(j.events) ? (j.events as SealpostEvent[]) : [])),
  };

  readonly stats = {
    get: (): Promise<Result<Stats>> => this.call("GET", "/api/stats", undefined, (j) => j as unknown as Stats),
  };

  readonly receipts = {
    /** Verify an `evw_` token; pass `inboxId` to also check it against the stored message bytes. */
    verify: (token: string, inboxId?: string): Promise<Result<{ ok: boolean; reasons: string[] }>> => this.call("POST", "/api/verify", { token, inboxId }, (j) => ({ ok: j.ok === true, reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [] })),
  };

  readonly domains = {
    list: (): Promise<Result<DomainInfo[]>> => this.call("GET", "/api/domains", undefined, (j) => (Array.isArray(j.domains) ? (j.domains as DomainInfo[]) : [])),
    /** Live DNS lookup of SPF, DKIM and DMARC against what Sealpost expects. */
    check: (domain: string): Promise<Result<{ domain: string; ok: boolean; results: DnsCheckResult[] }>> => this.call("GET", `/api/domains/${encodeURIComponent(domain)}/check`, undefined, (j) => ({ domain: String(j.domain ?? domain), ok: j.ok === true, results: (Array.isArray(j.results) ? j.results : []) as DnsCheckResult[] })),
  };

  readonly audiences = {
    create: (name: string): Promise<Result<AudienceSummary>> => this.call("POST", "/api/audiences", { name }, (j) => j.audience as AudienceSummary),
    list: (): Promise<Result<AudienceSummary[]>> => this.call("GET", "/api/audiences", undefined, (j) => (Array.isArray(j.audiences) ? (j.audiences as AudienceSummary[]) : [])),
    get: (id: string, page: { offset?: number; limit?: number } = {}): Promise<Result<{ id: string; name: string; total: number; contacts: Contact[] }>> =>
      this.call("GET", `/api/audiences/${encodeURIComponent(id)}?offset=${page.offset ?? 0}&limit=${page.limit ?? 100}`, undefined, (j) => ({ id: String(j.id), name: String(j.name), total: Number(j.total ?? 0), contacts: (Array.isArray(j.contacts) ? j.contacts : []) as Contact[] })),
    /** Adds or updates up to 10,000 contacts. Invalid addresses come back in `rejected`. */
    addContacts: (id: string, contacts: Contact[]): Promise<Result<{ added: number; updated: number; total: number; rejected: Array<{ email: string; reason: string }> }>> =>
      this.call("POST", `/api/audiences/${encodeURIComponent(id)}/contacts`, { contacts: contacts.map(({ email, name, variables }) => ({ email, name, variables })) }, (j) => ({ added: Number(j.added ?? 0), updated: Number(j.updated ?? 0), total: Number(j.total ?? 0), rejected: (Array.isArray(j.rejected) ? j.rejected : []) as Array<{ email: string; reason: string }> })),
    removeContact: (id: string, email: string): Promise<Result<{ total: number }>> => this.call("DELETE", `/api/audiences/${encodeURIComponent(id)}/contacts?email=${encodeURIComponent(email)}`, undefined, (j) => ({ total: Number(j.total ?? 0) })),
    delete: (id: string): Promise<Result<true>> => this.call("DELETE", `/api/audiences/${encodeURIComponent(id)}`, undefined, () => true as const),
  };

  readonly broadcasts = {
    /** Sends a template to every contact in an audience, now or at `scheduledAt`, throttled to `ratePerMinute`. */
    create: (o: CreateBroadcastOptions): Promise<Result<Broadcast>> =>
      this.call("POST", "/api/broadcasts", { name: o.name, audienceId: o.audienceId, templateId: o.template, domain: o.domain, variables: o.variables, scheduledAtIso: o.scheduledAt === undefined ? undefined : o.scheduledAt instanceof Date ? o.scheduledAt.toISOString() : o.scheduledAt, ratePerMinute: o.ratePerMinute }, (j) => j.broadcast as Broadcast),
    list: (): Promise<Result<Broadcast[]>> => this.call("GET", "/api/broadcasts", undefined, (j) => (Array.isArray(j.broadcasts) ? (j.broadcasts as Broadcast[]) : [])),
    get: (id: string): Promise<Result<Broadcast>> => this.call("GET", `/api/broadcasts/${encodeURIComponent(id)}`, undefined, (j) => j as unknown as Broadcast),
    cancel: (id: string): Promise<Result<Broadcast>> => this.call("POST", `/api/broadcasts/${encodeURIComponent(id)}/cancel`, {}, (j) => j.broadcast as Broadcast),
  };

  readonly webhooks = {
    /** Same as the exported `verifyWebhook`. */
    verify: verifyWebhook,
    /** Queue a `webhook.ping` to one configured endpoint (admin key). */
    test: (endpointId: string): Promise<Result<{ eventId?: string }>> => this.call("POST", `/api/webhooks/${encodeURIComponent(endpointId)}/test`, {}, (j) => ({ eventId: typeof j.eventId === "string" ? j.eventId : undefined })),
    deliveries: (): Promise<Result<Array<{ id: string; endpointId: string; eventId: string; type: string; status: "pending" | "delivered" | "failed"; attempts: number; lastStatus?: number; lastNote?: string }>>> => this.call("GET", "/api/webhooks/deliveries", undefined, (j) => (Array.isArray(j.deliveries) ? j.deliveries : [])),
  };

  readonly ledger = {
    verify: (): Promise<Result<{ ok: boolean; count: number; reason: string }>> => this.call("GET", "/api/ledger/verify", undefined, (j) => ({ ok: j.ok === true, count: Number(j.count ?? 0), reason: String(j.reason ?? "") })),
  };
}

/**
 * Verifies a `Sealpost-Signature` header against the RAW request body (before JSON parsing).
 * Uses Web Crypto, so it works in Node 18+, Deno, Bun, browsers and edge runtimes.
 */
export async function verifyWebhook(secret: string, rawBody: string, signatureHeader: string | null | undefined, opts: { toleranceSeconds?: number; nowSeconds?: number } = {}): Promise<WebhookVerification> {
  const parts: Record<string, string> = {};
  for (const p of (signatureHeader ?? "").split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return { ok: false, reason: "malformed" };
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return { ok: false, reason: "stale" };
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "mismatch" };
}

function toBody(o: SendEmailOptions): Obj {
  const { template, idempotencyKey: _ignored, scheduledAt, ...rest } = o;
  void _ignored;
  return { templateId: template, ...rest, ...(scheduledAt === undefined ? {} : { scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt }) };
}
