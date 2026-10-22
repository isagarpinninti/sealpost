import { randomBytes } from "node:crypto";
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from "@sealpost/core";
import type { WebhookEndpoint } from "./project";
import { exclusive, type Runtime } from "./runtime";
import { readOutbox, writeOutbox, type OutboxItem } from "./store";
import { deliverRaw } from "./webhook";

/** Seconds-scale back-off between attempts: 10 s, 1 min, 5 min, 30 min, 2 h. After the sixth failure the delivery is marked failed. */
export const WEBHOOK_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000] as const;
const KEEP_FINISHED = 500;

export const eventMatches = (patterns: readonly string[], type: string): boolean => patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));

export interface EmittedEvent {
  id: string;
  type: string;
  createdAt: string;
  data: unknown;
}

/**
 * Queues `type` for every endpoint that subscribed to it. Persisted before returning, so a crash cannot lose it.
 * Must not be called from inside `exclusive`.
 */
export async function emitEvent(rt: Runtime, type: string, data: unknown, only?: string): Promise<EmittedEvent | null> {
  const endpoints = rt.project.config.webhooks.filter((e) => (only ? e.id === only : eventMatches(e.events, type)));
  if (endpoints.length === 0) return null;
  const event: EmittedEvent = { id: `evt_${randomBytes(10).toString("hex")}`, type, createdAt: new Date().toISOString(), data };
  const body = JSON.stringify(event);
  await exclusive(rt, async () => {
    const box = await readOutbox(rt.project);
    for (const e of endpoints) box.push({ id: randomBytes(8).toString("hex"), endpointId: e.id, eventId: event.id, type, body, status: "pending", attempts: 0, nextAttemptAtIso: new Date().toISOString(), createdAtIso: event.createdAt });
    await writeOutbox(rt.project, prune(box));
  });
  return event;
}

/** Fire-and-forget wrapper for call sites where a webhook problem must never fail the send. */
export function emitSafely(rt: Runtime, type: string, data: unknown): void {
  void emitEvent(rt, type, data).catch((e: unknown) => process.stderr.write(`[sealpost] webhook: ${e instanceof Error ? e.message : String(e)}\n`));
}

function prune(box: OutboxItem[]): OutboxItem[] {
  const pending = box.filter((i) => i.status === "pending");
  const done = box.filter((i) => i.status !== "pending").slice(-KEEP_FINISHED);
  return [...done, ...pending];
}

export interface OutboxRun {
  delivered: number;
  retrying: number;
  failed: number;
}

/** Attempts every pending delivery that is due. Safe to call concurrently with sends. */
export async function processOutbox(rt: Runtime, now = Date.now()): Promise<OutboxRun> {
  const run: OutboxRun = { delivered: 0, retrying: 0, failed: 0 };
  const due = await exclusive(rt, async () => {
    const all = await readOutbox(rt.project);
    const picked = all.filter((i) => i.status === "pending" && Date.parse(i.nextAttemptAtIso) <= now && !(i.leaseUntilIso && Date.parse(i.leaseUntilIso) > now));
    for (const i of picked) i.leaseUntilIso = new Date(now + 120_000).toISOString();
    if (picked.length) await writeOutbox(rt.project, all);
    return picked.map((i) => ({ ...i }));
  });
  for (const item of due) {
    const endpoint: WebhookEndpoint | undefined = rt.project.config.webhooks.find((e) => e.id === item.endpointId);
    let result: { ok: boolean; status: number; note: string };
    let terminal = false;
    const secret = endpoint ? process.env[endpoint.secretEnv] : undefined;
    if (!endpoint) {
      result = { ok: false, status: 0, note: "Endpoint was removed from the configuration" };
      terminal = true;
    } else if (secret === undefined || secret === "") {
      result = { ok: false, status: 0, note: `Environment variable ${endpoint.secretEnv} is not set, so the delivery cannot be signed` };
      terminal = true;
    } else {
      const signature = await signWebhookPayload(secret, item.body);
      result = await deliverRaw(endpoint.url, item.body, { [WEBHOOK_SIGNATURE_HEADER]: signature, "Sealpost-Event-Id": item.eventId, "Sealpost-Event-Type": item.type }, rt.project.config.allowPrivateNetworks);
    }
    await exclusive(rt, async () => {
      const box = await readOutbox(rt.project);
      const cur = box.find((i) => i.id === item.id);
      if (!cur) return;
      cur.attempts += 1;
      cur.leaseUntilIso = undefined;
      cur.lastStatus = result.status;
      cur.lastNote = result.note;
      if (result.ok) {
        cur.status = "delivered";
        cur.deliveredAtIso = new Date().toISOString();
        run.delivered++;
      } else if (terminal || cur.attempts > WEBHOOK_RETRY_DELAYS_MS.length) {
        cur.status = "failed";
        run.failed++;
      } else {
        cur.nextAttemptAtIso = new Date(now + WEBHOOK_RETRY_DELAYS_MS[cur.attempts - 1]).toISOString();
        run.retrying++;
      }
      await writeOutbox(rt.project, prune(box));
    });
  }
  return run;
}
