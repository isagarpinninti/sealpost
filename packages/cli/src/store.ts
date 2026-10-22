import { join } from "node:path";
import type { SuppressionEntry } from "@sealpost/core";
import type { Project } from "./project";
import type { SinkMessage } from "./smtp/sink";

async function readJson<T>(project: Project, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await project.storage.readText(path)) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const writeJson = (project: Project, path: string, value: unknown): Promise<void> => project.storage.writeText(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);

/* ───────────────────────── suppressions ───────────────────────── */

export const readSuppressions = (project: Project): Promise<SuppressionEntry[]> => readJson(project, project.paths.suppressions, []);
export const writeSuppressions = (project: Project, list: readonly SuppressionEntry[]): Promise<void> => writeJson(project, project.paths.suppressions, list);

/* ───────────────────────── retry queue ───────────────────────── */

export interface QueueItem {
  id: string;
  status: "queued" | "failed";
  /** The complete DKIM-signed message, so a retry sends byte-identical mail. */
  raw: string;
  from: string;
  recipients: string[];
  attempts: number;
  nextAttemptAtIso: string;
  lastError: string;
  createdAtIso: string;
  /** Another worker has claimed this item until then. */
  leaseUntilIso?: string;
  meta: {
    templateId: string;
    templateVersion: string;
    to: string;
    fromEmail: string;
    domain?: string;
    subject: string;
    messageId: string;
    mimeSha256: string;
    dkimBodyHash: string;
    idempotencyKey: string;
    deliverabilityScore: number;
    links: string[];
  };
}

export const readQueue = (project: Project): Promise<QueueItem[]> => readJson(project, project.paths.queue, []);
export const writeQueue = (project: Project, items: readonly QueueItem[]): Promise<void> => writeJson(project, project.paths.queue, items);

/* ───────────────────────── tracking ───────────────────────── */

export interface TrackedMessage {
  templateId: string;
  to: string;
  sentAtIso: string;
  /** The only URLs a click redirect is ever allowed to send a visitor to. */
  links: string[];
}

export const readTracking = (project: Project): Promise<Record<string, TrackedMessage>> => readJson(project, project.paths.tracking, {});
export const writeTracking = (project: Project, t: Record<string, TrackedMessage>): Promise<void> => writeJson(project, project.paths.tracking, t);

export interface TrackingEvent {
  atIso: string;
  type: "open" | "click" | "delivered" | "bounce" | "deferred" | "complaint";
  messageId: string;
  url?: string;
  userAgent?: string;
  /** Set on events reported by an upstream relay. */
  email?: string;
  detail?: string;
  provider?: string;
}

export async function appendEvent(project: Project, e: TrackingEvent): Promise<void> {
  await project.storage.appendText(project.paths.events, `${JSON.stringify(e)}\n`, 0o600);
}

export async function readEvents(project: Project, limit = 500): Promise<TrackingEvent[]> {
  try {
    return (await project.storage.readText(project.paths.events)).split("\n").filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as TrackingEvent).reverse();
  } catch {
    return [];
  }
}

/* ───────────────────────── test inbox ───────────────────────── */

export type InboxMeta = Omit<SinkMessage, "raw">;

export async function saveInboxMessage(project: Project, m: SinkMessage): Promise<void> {
  const { raw, ...meta } = m;
  await project.storage.writeText(join(project.paths.inbox, `${m.id}.eml`), raw, 0o600);
  await project.storage.writeText(join(project.paths.inbox, `${m.id}.json`), JSON.stringify(meta), 0o600);
}

export async function listInbox(project: Project): Promise<InboxMeta[]> {
  const files = (await project.storage.list(project.paths.inbox)).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
  const out: InboxMeta[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await project.storage.readText(join(project.paths.inbox, f))) as InboxMeta);
    } catch {
      /* skip unreadable entry */
    }
  }
  return out.sort((a, b) => b.receivedAtIso.localeCompare(a.receivedAtIso));
}

/** Ids are validated as 16 hex characters, so a request can never reach outside the inbox directory. */
export async function readInboxRaw(project: Project, id: string): Promise<string | null> {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  try {
    return await project.storage.readText(join(project.paths.inbox, `${id}.eml`));
  } catch {
    return null;
  }
}

export async function clearInbox(project: Project): Promise<void> {
  await project.storage.removeTree(project.paths.inbox);
}

/* ───────────────────────── outbound webhook outbox ───────────────────────── */

export interface OutboxItem {
  id: string;
  endpointId: string;
  eventId: string;
  type: string;
  /** The exact serialised event; the signature covers these bytes. */
  body: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAtIso: string;
  createdAtIso: string;
  deliveredAtIso?: string;
  lastStatus?: number;
  lastNote?: string;
  /** Another worker has claimed this delivery until then. */
  leaseUntilIso?: string;
}

export const readOutbox = (project: Project): Promise<OutboxItem[]> => readJson(project, project.paths.outbox, []);
export const writeOutbox = (project: Project, items: readonly OutboxItem[]): Promise<void> => writeJson(project, project.paths.outbox, items);

/* ───────────────────────── audiences and broadcasts ───────────────────────── */

export interface Contact {
  email: string;
  name?: string;
  /** Per-contact template variables; they override the broadcast's. */
  variables?: Record<string, string | number | boolean>;
  addedAtIso: string;
}

export interface Audience {
  id: string;
  name: string;
  createdAtIso: string;
  contacts: Contact[];
}

export type BroadcastStatus = "scheduled" | "sending" | "completed" | "cancelled";

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
  variables: Record<string, string | number | boolean>;
  scheduledAtIso: string;
  /** Sends per minute while this broadcast runs. */
  ratePerMinute: number;
  status: BroadcastStatus;
  createdAtIso: string;
  startedAtIso?: string;
  completedAtIso?: string;
  /** Contacts snapshotted at start, so later edits to the audience do not change a running broadcast. */
  recipients?: string[];
  /** Index of the next recipient to process: a restart resumes here. */
  cursor: number;
  /** Another worker is sending this broadcast until then. */
  leaseUntilIso?: string;
  counts: BroadcastCounts;
}

export const readAudiences = (project: Project): Promise<Audience[]> => readJson(project, project.paths.audiences, []);
export const writeAudiences = (project: Project, list: readonly Audience[]): Promise<void> => writeJson(project, project.paths.audiences, list);
export const readBroadcasts = (project: Project): Promise<Broadcast[]> => readJson(project, project.paths.broadcasts, []);
export const writeBroadcasts = (project: Project, list: readonly Broadcast[]): Promise<void> => writeJson(project, project.paths.broadcasts, list);

/** A broadcast without its (potentially huge) recipient snapshot. */
export function publicBroadcast(b: Broadcast): Omit<Broadcast, "recipients"> {
  const copy: Broadcast = { ...b };
  delete copy.recipients;
  return copy;
}

/** An outbox row without the serialised event body. */
export function publicDelivery(i: OutboxItem): Omit<OutboxItem, "body"> {
  const { id, endpointId, eventId, type, status, attempts, nextAttemptAtIso, createdAtIso, deliveredAtIso, lastStatus, lastNote } = i;
  return { id, endpointId, eventId, type, status, attempts, nextAttemptAtIso, createdAtIso, deliveredAtIso, lastStatus, lastNote };
}

/* ───────────────────────── API idempotency keys ───────────────────────── */

export interface StoredIdempotency {
  fingerprint: string;
  atIso: string;
  status: number;
  body: Record<string, unknown>;
}

export const readIdempotency = (project: Project): Promise<Record<string, StoredIdempotency>> => readJson(project, project.paths.idempotency, {});
export const writeIdempotency = (project: Project, v: Record<string, StoredIdempotency>): Promise<void> => writeJson(project, project.paths.idempotency, v);

/* ───────────────────────── audit log ───────────────────────── */

export interface AuditEntry {
  atIso: string;
  /** `master`, `key:<label>`, or `anonymous` for a request that failed to authenticate. */
  actor: string;
  method: string;
  /** Path only: query strings can carry addresses and are not logged. */
  path: string;
  status: number;
  ip: string;
  requestId: string;
}

export async function appendAudit(project: Project, e: AuditEntry): Promise<void> {
  await project.storage.appendText(project.paths.audit, `${JSON.stringify(e)}\n`, 0o600);
}

/** Newest first. */
export async function readAudit(project: Project, limit = 100, actor?: string): Promise<AuditEntry[]> {
  try {
    const rows = (await project.storage.readText(project.paths.audit)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditEntry).reverse();
    return (actor ? rows.filter((r) => r.actor === actor) : rows).slice(0, Math.min(1000, Math.max(1, limit)));
  } catch {
    return [];
  }
}

/* ───────────────────────── scheduled sends ───────────────────────── */

export interface ScheduledSend {
  /** `sch_…` */
  id: string;
  /** The send request, re-run through the full gate at the scheduled time. */
  request: Record<string, unknown>;
  scheduledAtIso: string;
  createdAtIso: string;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  /** What happened when it ran. */
  result?: { status: string; emailId?: string; messageId?: string; error?: string };
}

export const readScheduled = (project: Project): Promise<ScheduledSend[]> => readJson(project, project.paths.scheduled, []);
export const writeScheduled = (project: Project, list: readonly ScheduledSend[]): Promise<void> => writeJson(project, project.paths.scheduled, list);
