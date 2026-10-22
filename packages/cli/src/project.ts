import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createStorage } from "./storage-factory";
import type { Storage } from "./storage";
import { DomainProfileSchema, EmailTemplateSchema, MailboxSchema, validateTemplate, type DomainProfile, type EmailTemplate, type Mailbox } from "@sealpost/core";

/** Events an outbound webhook endpoint can subscribe to. `*` matches all; `email.*` matches a family. */
export const WEBHOOK_EVENTS = ["email.delivered", "email.queued", "email.failed", "email.bounced", "email.deferred", "email.complained", "email.opened", "email.clicked", "email.received", "email.unsubscribed", "broadcast.started", "broadcast.completed", "webhook.ping"] as const;

const eventPattern = z.string().refine((e) => e === "*" || (WEBHOOK_EVENTS as readonly string[]).includes(e) || WEBHOOK_EVENTS.some((w) => e.endsWith(".*") && w.startsWith(e.slice(0, -1))), "unknown event");

/** An HTTPS endpoint in your app that Sealpost notifies. The signing secret lives in the environment variable named by `secretEnv`, never in this file. */
export const WebhookEndpointSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
    url: z.string().url().max(2000),
    events: z.array(eventPattern).min(1).max(20).default(["*"]),
    secretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(80),
  })
  .strict();
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/** Receiving mail: a public SMTP listener (the MX target) for your domains. Off by default. */
export const InboundSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("0.0.0.0"),
    /** Senders always connect to port 25; use 25 directly or redirect it here. */
    port: z.number().int().min(0).max(65535).default(2525),
    /** The public hostname of this server, published as the MX record. */
    mxHost: z.string().max(253).optional(),
    /** Domains to accept mail for. Empty means every sending domain. */
    domains: z.array(z.string().max(253)).max(20).default([]),
    maxMessageMb: z.number().min(1).max(50).default(25),
    /** PEM files for STARTTLS (for example from Let's Encrypt). */
    tls: z.object({ keyFile: z.string(), certFile: z.string() }).strict().optional(),
    /** Delete received mail older than this many days. 0 keeps everything. */
    retentionDays: z.number().int().min(0).max(3650).default(0),
  })
  .strict();
export type InboundConfig = z.infer<typeof InboundSchema>;

/** What an API key may do. `send`: send and preview mail. `read`: every GET plus verify and import previews. `write`: change suppressions, audiences, broadcasts and the like. The master key (SEALPOST_API_KEY) is also admin. */
export const KEY_SCOPES = ["send", "read", "write"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export const ApiKeyRecordSchema = z
  .object({
    label: z.string().min(1).max(80),
    scopes: z.array(z.enum(KEY_SCOPES)).min(1),
    createdAtIso: z.string(),
    expiresAtIso: z.string().optional(),
  })
  .strict();
export type ApiKeyRecord = z.infer<typeof ApiKeyRecordSchema>;

/** A key entry as stored: the legacy form is just a label and means every scope. */
export function keyRecord(v: string | ApiKeyRecord): ApiKeyRecord {
  return typeof v === "string" ? { label: v, scopes: [...KEY_SCOPES], createdAtIso: "" } : v;
}

/** Accept mail from your apps over SMTP (AUTH with an API key as the password) and send it through Sealpost: DKIM, relay failover, suppression, receipts and the ledger. */
export const SubmissionSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(2587),
    /** TLS from the first byte (port 465 style) instead of STARTTLS. */
    implicitTls: z.boolean().default(false),
    maxMessageMb: z.number().min(1).max(50).default(25),
    tls: z.object({ keyFile: z.string(), certFile: z.string() }).strict().optional(),
  })
  .strict();
export type SubmissionConfig = z.infer<typeof SubmissionSchema>;

/** Where state lives. `postgres` lets several Sealpost processes share it; the connection string comes from the environment variable `urlEnv`, never from this file. */
export const StorageSchema = z
  .object({
    type: z.enum(["disk", "postgres"]).default("disk"),
    urlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(80).default("DATABASE_URL"),
    /** Postgres schema holding Sealpost's tables. */
    schema: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).default("sealpost"),
    /** Separates projects that share one database. */
    namespace: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}$/).default("default"),
  })
  .strict();
export type StorageConfig = z.infer<typeof StorageSchema>;

export const ConfigSchema = z.object({
  name: z.string().min(1),
  /** The default sending domain. */
  domain: DomainProfileSchema,
  /** Additional sending domains. Select one per send with `domain`; each gets its own DKIM key. */
  domains: z.array(DomainProfileSchema).max(20).default([]),
  /** `sink`: capture every message in the local test inbox. `smtp`: dispatch through `mailboxes`, primary first. */
  transport: z.enum(["sink", "smtp"]).default("sink"),
  mailboxes: z.array(MailboxSchema).max(8).default([]),
  /** sha256(key) → label. Created with `sealpost auth add-key`. */
  auth: z.object({ keys: z.record(z.string(), z.union([z.string(), ApiKeyRecordSchema])) }).default({ keys: {} }),
  /** Legacy single receipt webhook (`sealpost.delivery.sealed`). Prefer `webhooks`. */
  webhookUrl: z.string().default(""),
  storage: StorageSchema.default(() => ({ type: "disk" as const, urlEnv: "DATABASE_URL", schema: "sealpost", namespace: "default" })),
  submission: SubmissionSchema.default(() => ({ enabled: false, host: "127.0.0.1", port: 2587, implicitTls: false, maxMessageMb: 25 })),
  inbound: InboundSchema.default(() => ({ enabled: false, host: "0.0.0.0", port: 2525, domains: [], maxMessageMb: 25, retentionDays: 0 })),
  /** Protects your relay and your reputation. Sends above the limit are queued, not dropped. */
  limits: z.object({ sendsPerMinute: z.number().int().min(0).max(100_000).default(0) }).strict().default(() => ({ sendsPerMinute: 0 })),
  /** Hosted one-click unsubscribe pages (`/u/<token>`). */
  unsubscribe: z.object({ hosted: z.boolean().default(false) }).strict().default(() => ({ hosted: false })),
  /** Signed, retried event webhooks to your own app. */
  webhooks: z.array(WebhookEndpointSchema).max(10).default([]),
  /** Allow webhooks and private / loopback SMTP relays (off by default: SSRF guard). */
  allowPrivateNetworks: z.boolean().default(false),
  /** How long an identical send (template + recipient + variables) is treated as a duplicate. */
  dedupeWindowMinutes: z.number().int().min(0).max(525600).default(1440),
});
export type ProjectConfig = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = "sealpost.config.json";
export const TEMPLATES_DIR = "templates";
export const STATE_DIR = ".sealpost";

export interface Project {
  dir: string;
  config: ProjectConfig;
  templates: EmailTemplate[];
  paths: ReturnType<typeof projectPaths>;
  /** State (keys, ledger, queues, logs, received mail). Config and templates always stay on disk. */
  storage: Storage;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export function projectPaths(dir: string) {
  const root = resolve(dir);
  const state = join(root, STATE_DIR);
  return {
    config: join(root, CONFIG_FILE),
    templates: join(root, TEMPLATES_DIR),
    state,
    ledger: join(state, "ledger.jsonl"),
    suppressions: join(state, "suppressions.json"),
    queue: join(state, "queue.json"),
    tracking: join(state, "tracking.json"),
    events: join(state, "events.jsonl"),
    inbox: join(state, "inbox"),
    dkimKey: join(state, "dkim-key.json"),
    audiences: join(state, "audiences.json"),
    broadcasts: join(state, "broadcasts.json"),
    outbox: join(state, "webhook-outbox.json"),
    emailLog: join(state, "emails.jsonl"),
    inboundDir: join(state, "inbound"),
    audit: join(state, "audit.jsonl"),
    secret: join(state, "secret.key"),
    scheduled: join(state, "scheduled.json"),
    idempotency: join(state, "idempotency.json"),
    inflight: join(state, "inflight.json"),
    receiptKey: join(state, "receipt-key.json"),
  };
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

/** Key file for an additional sending domain. Domain names are validated by the schema, so this cannot escape the state directory. */
export const dkimKeyPathFor = (project: Pick<Project, "paths">, domain: string): string => join(project.paths.state, `dkim-${domain.toLowerCase()}.json`);

export const allDomains = (config: ProjectConfig): DomainProfile[] => [config.domain, ...config.domains];

const SAFE_ID = /^[a-z][a-z0-9_]{1,63}$/;

/** Loads and validates a project. Throws `ProjectError` listing every problem. */
export async function loadProject(dir: string): Promise<Project> {
  const paths = projectPaths(dir);
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch {
    throw new ProjectError(`No ${CONFIG_FILE} found in ${resolve(dir)}. Run \`sealpost init\` first.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new ProjectError(`${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) throw new ProjectError(`${CONFIG_FILE} is invalid`, parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`));
  const config = parsed.data;

  const issues: string[] = [];
  const templates: EmailTemplate[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(paths.templates)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    /* no templates directory yet */
  }
  for (const file of files) {
    try {
      const v = validateTemplate(JSON.parse(await readFile(join(paths.templates, file), "utf8")));
      if (v.ok && v.template) {
        if (`${v.template.id}.json` !== file) issues.push(`templates/${file}: id '${v.template.id}' must match the file name`);
        else templates.push(v.template);
      } else issues.push(...v.errors.map((m) => `templates/${file}: ${m}`));
    } catch (e) {
      issues.push(`templates/${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const ids = new Set(config.mailboxes.map((m) => m.id));
  if (ids.size !== config.mailboxes.length) issues.push("mailboxes: ids must be unique");
  const names = allDomains(config).map((d) => d.domain.toLowerCase());
  if (new Set(names).size !== names.length) issues.push("domains: every sending domain must be unique");
  const hooks = config.webhooks.map((w) => w.id);
  if (new Set(hooks).size !== hooks.length) issues.push("webhooks: ids must be unique");
  if (config.transport === "smtp" && config.mailboxes.length === 0) issues.push("transport is 'smtp' but no mailbox is configured");
  if (templates.length === 0 && issues.length === 0) issues.push(`No templates found in ${TEMPLATES_DIR}/. Add one or run \`sealpost init\`.`);
  if (issues.length > 0) throw new ProjectError(`Project has ${issues.length} issue${issues.length === 1 ? "" : "s"}`, issues);
  return { dir: resolve(dir), config, templates, paths, storage: await createStorage(config.storage, paths.state, process.env) };
}

export interface WorkspaceUpdate {
  templates: EmailTemplate[];
  domain?: DomainProfile;
  domains?: DomainProfile[];
  webhooks?: WebhookEndpoint[];
  transport?: "sink" | "smtp";
  mailboxes?: Mailbox[];
}

/** Replaces templates (and optionally the domain, transport and mailboxes). Validates everything before touching a file. */
export async function saveWorkspace(project: Project, next: WorkspaceUpdate): Promise<Project> {
  const errors: string[] = [];
  for (const t of next.templates) {
    if (!SAFE_ID.test(t.id)) errors.push(`Unsafe template id '${t.id}'`);
    const v = validateTemplate(t);
    if (!v.ok) errors.push(...v.errors.map((m) => `${t.id}: ${m}`));
  }
  if (errors.length) throw new ProjectError("Invalid workspace", errors);
  const config: ProjectConfig = ConfigSchema.parse({ ...project.config, ...(next.domain ? { domain: next.domain } : {}), ...(next.domains ? { domains: next.domains } : {}), ...(next.webhooks ? { webhooks: next.webhooks } : {}), ...(next.transport ? { transport: next.transport } : {}), ...(next.mailboxes ? { mailboxes: next.mailboxes } : {}) });
  await mkdir(project.paths.templates, { recursive: true });
  const keep = new Set(next.templates.map((t) => `${t.id}.json`));
  for (const file of await readdir(project.paths.templates)) if (file.endsWith(".json") && !keep.has(file)) await rm(join(project.paths.templates, file));
  for (const t of next.templates) await writeFileAtomic(join(project.paths.templates, `${t.id}.json`), `${JSON.stringify(EmailTemplateSchema.parse(t), null, 2)}\n`);
  await writeFileAtomic(project.paths.config, `${JSON.stringify(config, null, 2)}\n`);
  return loadProject(project.dir);
}

export async function saveConfig(project: Project, config: ProjectConfig): Promise<void> {
  await writeFileAtomic(project.paths.config, `${JSON.stringify(config, null, 2)}\n`);
}
