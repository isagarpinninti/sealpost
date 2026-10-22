import { randomBytes } from "node:crypto";
import type { Project } from "./project";

/**
 * Append-only log of what happened to every accepted email. Records are folded from it on read, so there is
 * no second source of truth to drift, and a crash can at worst lose the entry being written.
 */

export type EmailStatus = "queued" | "delivered" | "failed" | "bounced" | "complained" | "deferred";
export type EmailEventType = EmailStatus | "opened" | "clicked" | "replied" | "unsubscribed";

export interface EmailTag {
  name: string;
  value: string;
}

export interface EmailCreated {
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  templateId: string;
  domain: string;
  tags: EmailTag[];
  metadata: Record<string, string>;
}

type Entry = { t: string; id: string; k: "created"; d: EmailCreated } | { t: string; id?: string; mid?: string; email?: string; k: EmailEventType; d?: Record<string, unknown> };

export interface EmailEvent {
  type: EmailEventType;
  atIso: string;
  detail?: string;
  url?: string;
}

export interface EmailRecord extends EmailCreated {
  id: string;
  createdAtIso: string;
  /** The latest of queued / delivered / failed / bounced / complained / deferred. */
  status: EmailStatus;
  opens: number;
  clicks: number;
  /** Inbound messages that replied to this email. */
  replies: number;
  /** The recipient used the hosted unsubscribe link. */
  unsubscribed?: boolean;
  receiptId?: string;
  events: EmailEvent[];
}

export const newEmailId = (): string => `em_${randomBytes(8).toString("hex")}`;

async function append(project: Project, e: Entry): Promise<void> {
  await project.storage.appendText(project.paths.emailLog, `${JSON.stringify(e)}\n`, 0o600);
}

export const logCreated = (project: Project, id: string, d: EmailCreated): Promise<void> => append(project, { t: new Date().toISOString(), id, k: "created", d });

/** Records an event against an email by its id, our Message-ID, or (relay feedback) the recipient address. */
export const logEvent = (project: Project, ref: { id?: string; messageId?: string; email?: string }, k: EmailEventType, d?: Record<string, unknown>): Promise<void> => append(project, { t: new Date().toISOString(), id: ref.id, mid: ref.messageId, email: ref.email?.toLowerCase(), k, d });

/** Folds the log into records, newest first. */
export async function readEmails(project: Project): Promise<EmailRecord[]> {
  let text = "";
  try {
    text = await project.storage.readText(project.paths.emailLog);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const records = new Map<string, EmailRecord>();
  const byMessage = new Map<string, string>();
  const latestByRecipient = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.k === "created") {
      const r: EmailRecord = { ...entry.d, id: entry.id, createdAtIso: entry.t, status: "queued", opens: 0, clicks: 0, replies: 0, events: [] };
      records.set(entry.id, r);
      byMessage.set(entry.d.messageId, entry.id);
      for (const addr of [...entry.d.to, ...entry.d.cc, ...entry.d.bcc]) latestByRecipient.set(addr.toLowerCase(), entry.id);
      continue;
    }
    const id = entry.id ?? (entry.mid ? byMessage.get(entry.mid) : undefined) ?? (entry.email ? latestByRecipient.get(entry.email) : undefined);
    const rec = id ? records.get(id) : undefined;
    if (!rec) continue;
    const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
    const detail = text(entry.d?.detail) ?? text(entry.d?.error);
    rec.events.push({ type: entry.k, atIso: entry.t, detail, url: typeof entry.d?.url === "string" ? entry.d.url : undefined });
    if (entry.k === "opened") rec.opens++;
    else if (entry.k === "clicked") rec.clicks++;
    else if (entry.k === "replied") rec.replies++;
    else if (entry.k === "unsubscribed") rec.unsubscribed = true;
    else rec.status = entry.k;
    if (typeof entry.d?.receiptId === "string") rec.receiptId = entry.d.receiptId;
  }
  return [...records.values()].sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : a.createdAtIso > b.createdAtIso ? -1 : a.id < b.id ? 1 : -1));
}

export interface EmailQuery {
  status?: EmailStatus;
  to?: string;
  templateId?: string;
  domain?: string;
  /** `name:value`, or just `name`. */
  tag?: string;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
  /** Return emails older than the one with this id. */
  before?: string;
}

export interface EmailPage {
  data: EmailRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function queryEmails(all: readonly EmailRecord[], q: EmailQuery): EmailPage {
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const to = q.to?.toLowerCase();
  const tagName = q.tag?.split(":")[0];
  const tagValue = q.tag?.includes(":") ? q.tag.slice(q.tag.indexOf(":") + 1) : undefined;
  let list = all.filter((r) => (!q.status || r.status === q.status) && (!q.templateId || r.templateId === q.templateId) && (!q.domain || r.domain.toLowerCase() === q.domain.toLowerCase()) && (!q.sinceIso || r.createdAtIso >= q.sinceIso) && (!q.untilIso || r.createdAtIso <= q.untilIso) && (!to || [...r.to, ...r.cc, ...r.bcc].some((a) => a.toLowerCase().includes(to))) && (!tagName || r.tags.some((t) => t.name === tagName && (tagValue === undefined || t.value === tagValue))));
  if (q.before) {
    const i = list.findIndex((r) => r.id === q.before);
    list = i < 0 ? [] : list.slice(i + 1);
  }
  const data = list.slice(0, limit);
  const hasMore = list.length > limit;
  return { data, hasMore, nextCursor: hasMore ? data[data.length - 1].id : null };
}

export interface DayStats {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  /** Emails accepted that day. */
  sent: number;
  /** Of those, how many ended `delivered`. */
  delivered: number;
  bounced: number;
  failed: number;
  /** Open events recorded that day (not tied to the send date). */
  opens: number;
  clicks: number;
}

/** One row per UTC day for the last `days` days, oldest first, zero-filled. */
export function timeseries(all: readonly EmailRecord[], days: number, now = Date.now()): DayStats[] {
  const n = Math.min(90, Math.max(1, Math.floor(days)));
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const out = new Map<string, DayStats>();
  for (let i = n - 1; i >= 0; i--) {
    const d = day(now - i * 86_400_000);
    out.set(d, { date: d, sent: 0, delivered: 0, bounced: 0, failed: 0, opens: 0, clicks: 0 });
  }
  for (const r of all) {
    const created = out.get(r.createdAtIso.slice(0, 10));
    if (created) {
      created.sent++;
      if (r.status === "delivered") created.delivered++;
      else if (r.status === "bounced" || r.status === "complained") created.bounced++;
      else if (r.status === "failed") created.failed++;
    }
    for (const e of r.events) {
      const d = out.get(e.atIso.slice(0, 10));
      if (!d) continue;
      if (e.type === "opened") d.opens++;
      else if (e.type === "clicked") d.clicks++;
    }
  }
  return [...out.values()];
}
