import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { BounceRecipient, InboundKind, ParsedAddress } from "@sealpost/core";
import type { Project } from "../project";

export interface InboundAttachmentMeta {
  index: number;
  filename: string;
  contentType: string;
  disposition: "attachment" | "inline";
  contentId?: string;
  size: number;
}

export interface InboundDkim {
  result: "pass" | "fail" | "none" | "temperror";
  domain?: string;
  selector?: string;
  detail?: string;
}

export interface InboundRecord {
  id: string;
  receivedAtIso: string;
  source: "smtp" | "webhook" | "import";
  envelope: { from: string; to: string[] };
  remoteAddress?: string;
  /** Delivered over TLS. */
  secure?: boolean;
  from?: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  replyTo: ParsedAddress[];
  subject: string;
  dateIso?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  snippet: string;
  hasText: boolean;
  hasHtml: boolean;
  attachments: InboundAttachmentMeta[];
  size: number;
  dkim: InboundDkim;
  kind: InboundKind;
  autoReply: boolean;
  bounce?: { recipients: BounceRecipient[]; originalMessageId?: string; unparsed: boolean };
  complaint?: { recipient?: string; feedbackType?: string; originalMessageId?: string };
  /** The `em_…` email this message answers or reports on (matched by Message-ID against mail this server sent). */
  threadEmailId?: string;
  /** A bounce or complaint report was matched to mail we really sent, so it was acted on. */
  reportVerified?: boolean;
  problems: string[];
}

export const INBOUND_ID = /^in_[0-9a-f]{16}$/;
export const newInboundId = (): string => `in_${randomBytes(8).toString("hex")}`;

const paths = (project: Project, id: string): { eml: string; json: string } => ({ eml: join(project.paths.inboundDir, `${id}.eml`), json: join(project.paths.inboundDir, `${id}.json`) });

export async function saveInbound(project: Project, record: InboundRecord, raw: Buffer): Promise<void> {
  const p = paths(project, record.id);
  await project.storage.writeBytes(p.eml, raw, 0o600);
  await project.storage.writeText(p.json, `${JSON.stringify(record)}\n`, 0o600);
}

export async function readInbound(project: Project, id: string): Promise<InboundRecord | null> {
  if (!INBOUND_ID.test(id)) return null;
  try {
    return JSON.parse(await project.storage.readText(paths(project, id).json)) as InboundRecord;
  } catch {
    return null;
  }
}

export async function readInboundRaw(project: Project, id: string): Promise<Buffer | null> {
  if (!INBOUND_ID.test(id)) return null;
  try {
    return await project.storage.readBytes(paths(project, id).eml);
  } catch {
    return null;
  }
}

export async function deleteInbound(project: Project, id: string): Promise<boolean> {
  if (!INBOUND_ID.test(id)) return false;
  const p = paths(project, id);
  const had = await project.storage.exists(p.json);
  await project.storage.remove(p.eml);
  await project.storage.remove(p.json);
  return had;
}

/** Every record, newest first. */
export async function listInboundAll(project: Project): Promise<InboundRecord[]> {
  const files = (await project.storage.list(project.paths.inboundDir)).filter((f) => f.endsWith(".json"));
  const out: InboundRecord[] = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(await project.storage.readText(join(project.paths.inboundDir, f))) as InboundRecord);
    } catch {
      /* a half-written file is skipped */
    }
  }
  return out.sort((a, b) => (a.receivedAtIso < b.receivedAtIso ? 1 : a.receivedAtIso > b.receivedAtIso ? -1 : a.id < b.id ? 1 : -1));
}

export interface InboundQuery {
  from?: string;
  to?: string;
  /** Substring of the subject or snippet. */
  q?: string;
  kind?: InboundKind;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
  before?: string;
}

export function queryInbound(all: readonly InboundRecord[], q: InboundQuery): { data: InboundRecord[]; hasMore: boolean; nextCursor: string | null } {
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const from = q.from?.toLowerCase();
  const to = q.to?.toLowerCase();
  const text = q.q?.toLowerCase();
  let list = all.filter((r) => (!q.kind || r.kind === q.kind) && (!q.sinceIso || r.receivedAtIso >= q.sinceIso) && (!q.untilIso || r.receivedAtIso <= q.untilIso) && (!from || (r.from?.address ?? "").toLowerCase().includes(from) || r.envelope.from.toLowerCase().includes(from)) && (!to || [...r.to, ...r.cc].some((a) => a.address.toLowerCase().includes(to)) || r.envelope.to.some((a) => a.toLowerCase().includes(to))) && (!text || r.subject.toLowerCase().includes(text) || r.snippet.toLowerCase().includes(text)));
  if (q.before) {
    const i = list.findIndex((r) => r.id === q.before);
    list = i < 0 ? [] : list.slice(i + 1);
  }
  const data = list.slice(0, limit);
  const hasMore = list.length > limit;
  return { data, hasMore, nextCursor: hasMore ? data[data.length - 1].id : null };
}

/** Deletes received mail older than `retentionDays`. Returns how many were removed. */
export async function pruneInbound(project: Project, retentionDays: number, now = Date.now()): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
  let n = 0;
  for (const r of await listInboundAll(project)) if (r.receivedAtIso < cutoff && (await deleteInbound(project, r.id))) n++;
  return n;
}
