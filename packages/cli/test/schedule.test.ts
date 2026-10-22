/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSuppression } from "@sealpost/core";
import { loadProject, openRuntime, processQueue, run, sendEmail, startServer, type RunningServer } from "../src";
import { cancelScheduled, processScheduled, scheduleEmail, ScheduleError } from "../src/scheduled";
import { listInbox, readQueue, readScheduled, writeSuppressions } from "../src/store";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-sched-"));
  expect(await run(["init", dir, "--name", "s", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  patch(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
const OTP = "magic_link_otp_verification";
const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
const req = (to: string, extra: Record<string, unknown> = {}) => ({ templateId: OTP, to, variables: vars, ...extra });

describe("scheduled sends", () => {
  it("refuses a bad request now, accepts a good one, and sends it when due", async () => {
    const rt = await openRuntime(await loadProject(await project()));
    const now = Date.now();
    await expect(scheduleEmail(rt, { ...req("a@example.org"), variables: {} }, new Date(now + 60_000).toISOString(), now)).rejects.toMatchObject({ status: 403, message: "Blocked by the pre-flight gate" });
    await expect(scheduleEmail(rt, req("a@example.org"), "nope", now)).rejects.toThrow(/valid date/);
    await expect(scheduleEmail(rt, req("a@example.org"), new Date(now + 91 * 86_400_000).toISOString(), now)).rejects.toThrow(/at most 90 days/);

    const item = await scheduleEmail(rt, req("a@example.org"), new Date(now + 3_600_000).toISOString(), now);
    expect(item).toMatchObject({ status: "scheduled", id: expect.stringMatching(/^sch_[0-9a-f]{10}$/) });
    expect(await processScheduled(rt, now + 1_000)).toEqual({ sent: 0, failed: 0 });
    expect(await listInbox(rt.project)).toHaveLength(0);
    expect(await processScheduled(rt, now + 3_600_001)).toEqual({ sent: 1, failed: 0 });
    expect(await processScheduled(rt, now + 3_700_000)).toEqual({ sent: 0, failed: 0 }); // never twice
    const done = (await readScheduled(rt.project))[0];
    expect(done).toMatchObject({ status: "sent", result: { status: "delivered", emailId: expect.stringMatching(/^em_/) } });
    expect(await listInbox(rt.project)).toHaveLength(1);
  });

  it("re-runs the gate at send time: an unsubscribe in between is honoured, and cancel works", async () => {
    const rt = await openRuntime(await loadProject(await project()));
    const now = Date.now();
    const a = await scheduleEmail(rt, req("later@example.org"), new Date(now + 1000).toISOString(), now);
    const b = await scheduleEmail(rt, req("cancel@example.org", { variables: { ...vars, otpCode: "111111" } }), new Date(now + 1000).toISOString(), now);
    await writeSuppressions(rt.project, addSuppression([], { email: "later@example.org", reason: "unsubscribed", atIso: new Date().toISOString() }));
    expect((await cancelScheduled(rt, b.id)).status).toBe("cancelled");
    await expect(cancelScheduled(rt, b.id)).rejects.toThrow(/already cancelled/);
    await expect(cancelScheduled(rt, "sch_0000000000")).rejects.toBeInstanceOf(ScheduleError);
    expect(await processScheduled(rt, now + 5_000)).toEqual({ sent: 0, failed: 1 });
    const all = await readScheduled(rt.project);
    expect(all.find((x) => x.id === a.id)).toMatchObject({ status: "failed", result: { status: "blocked", error: expect.stringContaining("Suppressed recipient") } });
    expect(all.find((x) => x.id === b.id)?.status).toBe("cancelled");
    expect(await listInbox(rt.project)).toHaveLength(0);
  });

  it("works through the API and is delivered by the server's worker", async () => {
    const dir = await project();
    const s: RunningServer = await startServer({ dir, port: 0 });
    closers.push(() => s.close());
    const post = async (body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${s.url}/api/send`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const at = new Date(Date.now() + 1500).toISOString();
    const r = await post(req("api@example.org", { scheduledAt: at }), { "Idempotency-Key": "sched-1" });
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ status: "scheduled", scheduledAt: at, id: expect.stringMatching(/^sch_/) });
    expect((await post(req("api@example.org", { scheduledAt: at }), { "Idempotency-Key": "sched-1" })).json.id).toBe(r.json.id);
    const list = (await (await fetch(`${s.url}/api/scheduled`)).json()) as any;
    expect(list.scheduled).toHaveLength(1);
    expect((await post({ ...req("api@example.org", { scheduledAt: at }), variables: {} })).json.code).toBe("preflight_blocked");
    expect((await post(req("x@example.org", { scheduledAt: new Date(Date.now() + 200 * 86_400_000).toISOString() }))).status).toBe(400);
    const cancelMe = await post(req("c@example.org", { scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), variables: { ...vars, otpCode: "999999" } }));
    expect((await fetch(`${s.url}/api/scheduled/${cancelMe.json.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${s.url}/api/scheduled/${cancelMe.json.id}`, { method: "DELETE" })).status).toBe(409);

    let inbox = 0;
    for (let i = 0; i < 40 && inbox === 0; i++) {
      await new Promise((r2) => setTimeout(r2, 200));
      inbox = ((await (await fetch(`${s.url}/api/inbox`)).json()) as any).messages.length;
    }
    expect(inbox).toBe(1);
    expect(((await (await fetch(`${s.url}/api/emails`)).json()) as any).data).toHaveLength(1);
    const past = await post(req("p@example.org", { scheduledAt: new Date(Date.now() - 60_000).toISOString(), variables: { ...vars, otpCode: "555555" } }));
    expect([past.status, past.json.status]).toEqual([201, "delivered"]); // a time in the past just sends now
  });

  it("schedules from the CLI", async () => {
    const dir = await project();
    const out: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t) };
    const at = new Date(Date.now() + 3_600_000).toISOString();
    expect(await run(["send", OTP, "--to", "cli@example.org", "--auto-fill", "--at", at, "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/Scheduled sch_/);
    out.length = 0;
    expect(await run(["scheduled", "list", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toContain("cli@example.org");
    const id = /sch_[0-9a-f]{10}/.exec(out.join("\n"))?.[0] ?? "";
    expect(await run(["scheduled", "cancel", id, "--dir", dir], io)).toBe(0);
    expect(await run(["scheduled", "cancel", id, "--dir", dir], io)).toBe(1);
  });
});

describe("send rate limit", () => {
  it("queues sends above the limit instead of dropping them, and releases them when the window opens", async () => {
    const rt = await openRuntime(await loadProject(await project((cfg) => { cfg.limits = { sendsPerMinute: 2 }; })));
    const sends = [];
    for (let i = 0; i < 4; i++) sends.push(await sendEmail(rt, { templateId: OTP, to: `u${i}@example.org`, variables: { ...vars, otpCode: `10000${i}` } }));
    expect(sends.map((x) => x.status)).toEqual(["delivered", "delivered", "queued", "queued"]);
    expect(sends[2].error).toBe("Rate limited (2 per minute)");
    expect((await listInbox(rt.project)).length).toBe(2);
    const queued = await readQueue(rt.project);
    expect(queued).toHaveLength(2);
    expect(queued.every((q) => q.attempts === 0)).toBe(true);

    const later = Date.now() + 120_000;
    expect(await processQueue(rt, later)).toMatchObject({ delivered: 0, waiting: 2 }); // still inside the real-time window
    expect((await readQueue(rt.project)).every((q) => q.attempts === 0)).toBe(true); // no attempt was spent
    rt.sendTimes = [];
    expect(await processQueue(rt, later)).toMatchObject({ delivered: 2, waiting: 0 });
    expect((await listInbox(rt.project)).length).toBe(4);
  });

  it("is off by default", async () => {
    const rt = await openRuntime(await loadProject(await project()));
    for (let i = 0; i < 5; i++) expect((await sendEmail(rt, { templateId: OTP, to: `v${i}@example.org`, variables: { ...vars, otpCode: `20000${i}` } })).status).toBe("delivered");
  });
});
