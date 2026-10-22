import { randomBytes } from "node:crypto";
import type { PreflightResult } from "@sealpost/core";
import { previewEmail, sendEmail, type SendRequest } from "./dispatch";
import { exclusive, type Runtime } from "./runtime";
import { readScheduled, writeScheduled, type ScheduledSend } from "./store";

export const MAX_SCHEDULE_DAYS = 90;
const KEEP_FINISHED = 500;

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly preflight?: PreflightResult,
  ) {
    super(message);
  }
}

/**
 * Accepts a send for later. The gate runs now, so a bad template, address or missing variable is refused immediately
 * instead of failing silently at 3 a.m.; it runs again at the scheduled time, so a recipient who unsubscribes in between
 * is still honoured.
 */
export async function scheduleEmail(rt: Runtime, req: SendRequest, atIso: string, now = Date.now()): Promise<ScheduledSend> {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new ScheduleError("scheduledAt is not a valid date");
  if (at > now + MAX_SCHEDULE_DAYS * 86_400_000) throw new ScheduleError(`scheduledAt can be at most ${MAX_SCHEDULE_DAYS} days ahead`);
  const preview = await previewEmail(rt, req, { mime: false });
  const blockers = preview.preflight.checks.filter((c) => c.severity === "block" && c.code !== "EW-108");
  if (blockers.length > 0) throw new ScheduleError("Blocked by the pre-flight gate", 403, preview.preflight);
  const item: ScheduledSend = { id: `sch_${randomBytes(5).toString("hex")}`, request: { ...req } as Record<string, unknown>, scheduledAtIso: new Date(at).toISOString(), createdAtIso: new Date(now).toISOString(), status: "scheduled" };
  await exclusive(rt, async () => writeScheduled(rt.project, [...(await readScheduled(rt.project)), item]));
  return item;
}

export async function cancelScheduled(rt: Runtime, id: string): Promise<ScheduledSend> {
  return exclusive(rt, async () => {
    const all = await readScheduled(rt.project);
    const item = all.find((x) => x.id === id);
    if (!item) throw new ScheduleError(`No scheduled send '${id}'`, 404);
    if (item.status !== "scheduled") throw new ScheduleError(`It is already ${item.status}`, 409);
    item.status = "cancelled";
    await writeScheduled(rt.project, all);
    return item;
  });
}

function prune(all: ScheduledSend[]): ScheduledSend[] {
  const open = all.filter((x) => x.status === "scheduled" || x.status === "sending");
  return [...all.filter((x) => x.status !== "scheduled" && x.status !== "sending").slice(-KEEP_FINISHED), ...open];
}

/** Sends everything that is due. Each item is claimed under the lock first, so it is never sent twice. */
export async function processScheduled(rt: Runtime, now = Date.now()): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const claimed = await exclusive(rt, async () => {
    const all = await readScheduled(rt.project);
    const due = all.filter((x) => x.status === "scheduled" && Date.parse(x.scheduledAtIso) <= now);
    for (const d of due) d.status = "sending";
    if (due.length) await writeScheduled(rt.project, all);
    return due;
  });
  for (const item of claimed) {
    let result: ScheduledSend["result"];
    let failed = false;
    try {
      const o = await sendEmail(rt, item.request as unknown as SendRequest);
      result = { status: o.status, emailId: o.emailId, messageId: o.messageId, error: o.error ?? (o.status === "blocked" ? o.preflight.checks.find((c) => c.severity === "block")?.message : undefined) };
      failed = o.status === "blocked" || o.status === "failed";
    } catch (e) {
      result = { status: "failed", error: e instanceof Error ? e.message : "Send failed" };
      failed = true;
    }
    await exclusive(rt, async () => {
      const all = await readScheduled(rt.project);
      const cur = all.find((x) => x.id === item.id);
      if (!cur) return;
      cur.status = failed ? "failed" : "sent";
      cur.result = result;
      await writeScheduled(rt.project, prune(all));
    });
    if (failed) out.failed++;
    else out.sent++;
  }
  return out;
}
