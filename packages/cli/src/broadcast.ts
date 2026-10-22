import { randomBytes } from "node:crypto";
import { isValidEmail } from "@sealpost/core";
import { sendEmail } from "./dispatch";
import { emitSafely } from "./outbound";
import { exclusive, type Runtime } from "./runtime";
import { readAudiences, readBroadcasts, writeAudiences, writeBroadcasts, type Audience, type Broadcast, type Contact } from "./store";

export const MAX_CONTACTS_PER_AUDIENCE = 100_000;
export const MAX_RATE_PER_MINUTE = 6000;

const id = (prefix: string): string => `${prefix}_${randomBytes(5).toString("hex")}`;
const norm = (email: string): string => email.trim().toLowerCase();

export interface ContactInput {
  email: string;
  name?: string;
  variables?: Record<string, string | number | boolean>;
}

export class BroadcastError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

/* ───────────── audiences ───────────── */

export async function createAudience(rt: Runtime, name: string): Promise<Audience> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 120) throw new BroadcastError("Audience name must be 1 to 120 characters");
  return exclusive(rt, async () => {
    const all = await readAudiences(rt.project);
    const a: Audience = { id: id("aud"), name: trimmed, createdAtIso: new Date().toISOString(), contacts: [] };
    await writeAudiences(rt.project, [...all, a]);
    return a;
  });
}

export async function addContacts(rt: Runtime, audienceId: string, input: readonly ContactInput[]): Promise<{ audience: Audience; added: number; updated: number; rejected: Array<{ email: string; reason: string }> }> {
  return exclusive(rt, async () => {
    const all = await readAudiences(rt.project);
    const a = all.find((x) => x.id === audienceId);
    if (!a) throw new BroadcastError(`No audience '${audienceId}'`, 404);
    const byEmail = new Map(a.contacts.map((c) => [c.email, c]));
    let added = 0;
    let updated = 0;
    const rejected: Array<{ email: string; reason: string }> = [];
    for (const raw of input) {
      const email = norm(raw.email);
      if (!isValidEmail(email)) {
        rejected.push({ email: raw.email, reason: "Not a valid email address" });
        continue;
      }
      const existing = byEmail.get(email);
      if (existing) {
        if (raw.name !== undefined) existing.name = raw.name;
        if (raw.variables) existing.variables = { ...existing.variables, ...raw.variables };
        updated++;
        continue;
      }
      if (byEmail.size >= MAX_CONTACTS_PER_AUDIENCE) {
        rejected.push({ email, reason: `Audience is full (${MAX_CONTACTS_PER_AUDIENCE} contacts)` });
        continue;
      }
      const c: Contact = { email, name: raw.name, variables: raw.variables, addedAtIso: new Date().toISOString() };
      byEmail.set(email, c);
      a.contacts.push(c);
      added++;
    }
    await writeAudiences(rt.project, all);
    return { audience: a, added, updated, rejected };
  });
}

export async function removeContact(rt: Runtime, audienceId: string, email: string): Promise<Audience> {
  return exclusive(rt, async () => {
    const all = await readAudiences(rt.project);
    const a = all.find((x) => x.id === audienceId);
    if (!a) throw new BroadcastError(`No audience '${audienceId}'`, 404);
    a.contacts = a.contacts.filter((c) => c.email !== norm(email));
    await writeAudiences(rt.project, all);
    return a;
  });
}

export async function deleteAudience(rt: Runtime, audienceId: string): Promise<void> {
  await exclusive(rt, async () => {
    const all = await readAudiences(rt.project);
    if (!all.some((x) => x.id === audienceId)) throw new BroadcastError(`No audience '${audienceId}'`, 404);
    const busy = (await readBroadcasts(rt.project)).some((b) => b.audienceId === audienceId && (b.status === "scheduled" || b.status === "sending"));
    if (busy) throw new BroadcastError("This audience has a scheduled or running broadcast; cancel it first", 409);
    await writeAudiences(rt.project, all.filter((x) => x.id !== audienceId));
  });
}

/* ───────────── broadcasts ───────────── */

export interface BroadcastInput {
  name: string;
  audienceId: string;
  templateId: string;
  domain?: string;
  variables?: Record<string, string | number | boolean>;
  /** ISO time. Omit to start on the next scheduler tick. */
  scheduledAtIso?: string;
  ratePerMinute?: number;
}

const zeroCounts = (total: number): Broadcast["counts"] => ({ total, delivered: 0, queued: 0, suppressed: 0, duplicate: 0, blocked: 0, failed: 0 });

export async function createBroadcast(rt: Runtime, input: BroadcastInput, now = Date.now()): Promise<Broadcast> {
  const name = input.name.trim();
  if (name === "" || name.length > 120) throw new BroadcastError("Broadcast name must be 1 to 120 characters");
  if (!rt.project.templates.some((t) => t.id === input.templateId)) throw new BroadcastError(`No template '${input.templateId}'`, 404);
  const rate = input.ratePerMinute ?? 600;
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE_PER_MINUTE) throw new BroadcastError(`ratePerMinute must be an integer from 1 to ${MAX_RATE_PER_MINUTE}`);
  let at = now;
  if (input.scheduledAtIso !== undefined) {
    at = Date.parse(input.scheduledAtIso);
    if (Number.isNaN(at)) throw new BroadcastError("scheduledAtIso is not a valid date");
  }
  return exclusive(rt, async () => {
    const audience = (await readAudiences(rt.project)).find((a) => a.id === input.audienceId);
    if (!audience) throw new BroadcastError(`No audience '${input.audienceId}'`, 404);
    if (audience.contacts.length === 0) throw new BroadcastError("The audience has no contacts");
    const b: Broadcast = { id: id("brd"), name, audienceId: audience.id, templateId: input.templateId, domain: input.domain, variables: input.variables ?? {}, scheduledAtIso: new Date(at).toISOString(), ratePerMinute: rate, status: "scheduled", createdAtIso: new Date(now).toISOString(), cursor: 0, counts: zeroCounts(audience.contacts.length) };
    await writeBroadcasts(rt.project, [...(await readBroadcasts(rt.project)), b]);
    return b;
  });
}

export async function cancelBroadcast(rt: Runtime, broadcastId: string): Promise<Broadcast> {
  return exclusive(rt, async () => {
    const all = await readBroadcasts(rt.project);
    const b = all.find((x) => x.id === broadcastId);
    if (!b) throw new BroadcastError(`No broadcast '${broadcastId}'`, 404);
    if (b.status === "completed" || b.status === "cancelled") throw new BroadcastError(`Broadcast is already ${b.status}`, 409);
    b.status = "cancelled";
    b.completedAtIso = new Date().toISOString();
    await writeBroadcasts(rt.project, all);
    return b;
  });
}

export interface BroadcastTick {
  started: number;
  sent: number;
  completed: number;
}

/**
 * One scheduler pass. Starts due broadcasts (snapshotting the audience), then sends up to `ratePerMinute / 60`
 * emails per running broadcast, so ticking once a second yields the configured rate. Progress is saved after
 * every email; a crash resumes at the cursor, and the idempotency gate prevents any double send.
 */
export async function processBroadcasts(rt: Runtime, now = Date.now()): Promise<BroadcastTick> {
  const tick: BroadcastTick = { started: 0, sent: 0, completed: 0 };
  const started = await exclusive(rt, async () => {
    const all = await readBroadcasts(rt.project);
    const audiences = await readAudiences(rt.project);
    const begun: Broadcast[] = [];
    for (const b of all) {
      if (b.status !== "scheduled" || Date.parse(b.scheduledAtIso) > now) continue;
      const aud = audiences.find((a) => a.id === b.audienceId);
      b.status = "sending";
      b.startedAtIso = new Date(now).toISOString();
      b.recipients = aud ? aud.contacts.map((c) => c.email) : [];
      b.counts = zeroCounts(b.recipients.length);
      begun.push(b);
    }
    if (begun.length) await writeBroadcasts(rt.project, all);
    return begun;
  });
  for (const b of started) {
    tick.started++;
    emitSafely(rt, "broadcast.started", { broadcastId: b.id, name: b.name, total: b.counts.total });
  }

  // One process at a time works on a given broadcast: claim it with a lease, release it when this pass is done.
  const claimed = await exclusive(rt, async () => {
    const all = await readBroadcasts(rt.project);
    const mine = all.filter((b) => b.status === "sending" && !(b.leaseUntilIso && Date.parse(b.leaseUntilIso) > now));
    for (const b of mine) b.leaseUntilIso = new Date(now + 60_000).toISOString();
    if (mine.length) await writeBroadcasts(rt.project, all);
    return mine.map((b) => b.id);
  });
  const running = claimed;
  for (const bid of running) {
    const perTick = Math.max(1, Math.floor((await currentRate(rt, bid)) / 60));
    for (let i = 0; i < perTick; i++) {
      const step = await sendNext(rt, bid);
      if (step === "idle") break;
      if (step === "sent") tick.sent++;
      if (step === "completed") {
        tick.completed++;
        break;
      }
    }
  }
  if (claimed.length) {
    await exclusive(rt, async () => {
      const all = await readBroadcasts(rt.project);
      for (const b of all) if (claimed.includes(b.id)) b.leaseUntilIso = undefined;
      await writeBroadcasts(rt.project, all);
    });
  }
  return tick;
}

async function currentRate(rt: Runtime, bid: string): Promise<number> {
  return (await readBroadcasts(rt.project)).find((b) => b.id === bid)?.ratePerMinute ?? 60;
}

async function sendNext(rt: Runtime, bid: string): Promise<"sent" | "completed" | "idle"> {
  type Pick = { kind: "done"; b: Broadcast } | { kind: "next"; b: Broadcast; email: string; contact: Contact | undefined };
  const pick = await exclusive(rt, async (): Promise<Pick | null> => {
    const all = await readBroadcasts(rt.project);
    const b = all.find((x) => x.id === bid);
    if (!b || b.status !== "sending") return null;
    const recipients = b.recipients ?? [];
    if (b.cursor >= recipients.length) {
      b.status = "completed";
      b.completedAtIso = new Date().toISOString();
      await writeBroadcasts(rt.project, all);
      return { kind: "done", b };
    }
    const email = recipients[b.cursor];
    const contact = (await readAudiences(rt.project)).find((a) => a.id === b.audienceId)?.contacts.find((c) => c.email === email);
    return { kind: "next", b, email, contact };
  });
  if (!pick) return "idle";
  if (pick.kind === "done") {
    emitSafely(rt, "broadcast.completed", { broadcastId: pick.b.id, name: pick.b.name, counts: pick.b.counts });
    return "completed";
  }
  const { b, email, contact } = pick;
  const variables = { ...b.variables, ...(contact?.name !== undefined ? { name: contact.name } : {}), email, ...contact?.variables };
  let kind: keyof Omit<Broadcast["counts"], "total"> = "failed";
  try {
    const outcome = await sendEmail(rt, { templateId: b.templateId, domain: b.domain, to: email, variables });
    if (outcome.status === "delivered") kind = "delivered";
    else if (outcome.status === "queued") kind = "queued";
    else if (outcome.status === "blocked") {
      const codes = outcome.preflight.checks.filter((c) => c.severity === "block").map((c) => c.code);
      kind = codes.includes("EW-107") ? "suppressed" : codes.length > 0 && codes.every((c) => c === "EW-108") ? "duplicate" : "blocked";
    }
  } catch {
    kind = "failed";
  }
  await exclusive(rt, async () => {
    const all = await readBroadcasts(rt.project);
    const cur = all.find((x) => x.id === bid);
    if (!cur) return;
    cur.counts[kind]++;
    cur.cursor += 1;
    await writeBroadcasts(rt.project, all);
  });
  return "sent";
}
