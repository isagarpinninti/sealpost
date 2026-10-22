/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startServer, type RunningServer } from "../src";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-api-"));
  expect(await run(["init", dir, "--name", "api", "--domain", "mail.example.com"], io)).toBe(0);
  return dir;
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function serve(dir: string, apiKey?: string, webhookSecret?: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0, apiKey, webhookSecret });
  closers.push(() => s.close());
  return s;
}
interface Res {
  status: number;
  json: any;
  headers: Headers;
}
async function call(base: string, path: string, o: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: res.status, json: await res.json(), headers: res.headers };
}
const OTP = "magic_link_otp_verification";
const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
const send = (base: string, to: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Res> => call(base, "/api/send", { method: "POST", body: { templateId: OTP, to, variables: vars, ...extra }, headers });

describe("email records, tags and the timeline", () => {
  it("returns an id, stores tags and metadata, and exposes the timeline", async () => {
    const s = await serve(await project());
    const r = await send(s.url, "a@example.org", { tags: [{ name: "campaign", value: "welcome" }], metadata: { userId: "u_42" } });
    expect(r.status).toBe(201);
    expect(r.json.id).toMatch(/^em_[0-9a-f]{16}$/);
    const rec = await call(s.url, `/api/emails/${r.json.id}`);
    expect(rec.json).toMatchObject({ id: r.json.id, status: "delivered", to: ["a@example.org"], templateId: OTP, domain: "mail.example.com", tags: [{ name: "campaign", value: "welcome" }], metadata: { userId: "u_42" }, receiptId: r.json.receipt.receiptId });
    expect(rec.json.events.map((e: any) => e.type)).toEqual(["delivered"]);

    await fetch(`${s.url}/o/${encodeURIComponent(r.json.messageId)}.gif`);
    await call(s.url, "/hooks/relay/postmark?token=x", { method: "POST", body: {} });
    const after = (await call(s.url, `/api/emails/${r.json.id}`)).json;
    expect(after).toMatchObject({ status: "delivered", opens: 1, clicks: 0 });
    expect(after.events.map((e: any) => e.type)).toEqual(["delivered", "opened"]);
  });

  it("applies relay bounces and complaints to the latest email for that recipient", async () => {
    const s = await serve(await project(), undefined, "relay-secret");
    const r = await send(s.url, "gone@example.org");
    await call(s.url, "/hooks/relay/postmark?token=relay-secret", { method: "POST", body: { RecordType: "Bounce", Type: "HardBounce", Email: "gone@example.org", Details: "no such user" } });
    const rec = (await call(s.url, `/api/emails/${r.json.id}`)).json;
    expect(rec.status).toBe("bounced");
    expect(rec.events.at(-1)).toMatchObject({ type: "bounced", detail: "no such user" });
  });

  it("validates tags and metadata", async () => {
    const s = await serve(await project());
    for (const bad of [{ tags: [{ name: "bad name!", value: "x" }] }, { tags: Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, value: "v" })) }, { metadata: { "bad key": "x" } }, { metadata: { ok: "x".repeat(501) } }]) {
      const r = await send(s.url, "t@example.org", bad);
      expect([r.status, r.json.code]).toEqual([400, "invalid_request"]);
    }
  });

  it("lists newest first with filters and cursor pagination", async () => {
    const s = await serve(await project());
    for (let i = 0; i < 5; i++) await send(s.url, `u${i}@example.org`, { tags: [{ name: "batch", value: i % 2 ? "odd" : "even" }] });
    const page1 = (await call(s.url, "/api/emails?limit=2")).json;
    expect(page1.data.map((e: any) => e.to[0])).toEqual(["u4@example.org", "u3@example.org"]);
    expect(page1).toMatchObject({ hasMore: true });
    const page2 = (await call(s.url, `/api/emails?limit=2&before=${page1.nextCursor}`)).json;
    expect(page2.data.map((e: any) => e.to[0])).toEqual(["u2@example.org", "u1@example.org"]);
    const page3 = (await call(s.url, `/api/emails?limit=2&before=${page2.nextCursor}`)).json;
    expect(page3).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page3.data.map((e: any) => e.to[0])).toEqual(["u0@example.org"]);
    expect((await call(s.url, "/api/emails?tag=batch:odd")).json.data).toHaveLength(2);
    expect((await call(s.url, "/api/emails?tag=batch")).json.data).toHaveLength(5);
    expect((await call(s.url, "/api/emails?to=U3@")).json.data).toHaveLength(1);
    expect((await call(s.url, "/api/emails?status=bounced")).json.data).toHaveLength(0);
    expect((await call(s.url, "/api/emails?template=nope")).json.data).toHaveLength(0);
    expect((await call(s.url, "/api/emails?status=weird")).status).toBe(400);
    expect((await call(s.url, "/api/emails?since=not-a-date")).status).toBe(400);
    expect((await call(s.url, "/api/emails/em_0000000000000000")).json.code).toBe("not_found");
  });
});

describe("Idempotency-Key", () => {
  it("replays the original response instead of sending again", async () => {
    const dir = await project();
    const s = await serve(dir);
    const a = await send(s.url, "idem@example.org", {}, { "Idempotency-Key": "order-1001" });
    const b = await send(s.url, "idem@example.org", {}, { "Idempotency-Key": "order-1001" });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json.id).toBe(a.json.id);
    expect(b.json.messageId).toBe(a.json.messageId);
    expect(a.headers.get("idempotent-replayed")).toBeNull();
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await call(s.url, "/api/inbox")).json.messages).toHaveLength(1);
    expect((await call(s.url, "/api/emails")).json.data).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, ".sealpost", "idempotency.json"), "utf8"))["order-1001"].status).toBe(201);
  });

  it("rejects the same key with a different body, and a malformed key", async () => {
    const s = await serve(await project());
    await send(s.url, "one@example.org", {}, { "Idempotency-Key": "k1" });
    const clash = await send(s.url, "two@example.org", {}, { "Idempotency-Key": "k1" });
    expect([clash.status, clash.json.code]).toEqual([409, "idempotency_key_reuse"]);
    const bad = await send(s.url, "x@example.org", {}, { "Idempotency-Key": "has space" });
    expect([bad.status, bad.json.code]).toEqual([400, "invalid_request"]);
  });

  it("collapses concurrent requests with one key into a single delivery", async () => {
    const s = await serve(await project());
    const rs = await Promise.all(Array.from({ length: 6 }, () => send(s.url, "race@example.org", {}, { "Idempotency-Key": "race-1" })));
    expect(new Set(rs.map((r) => r.json.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect((await call(s.url, "/api/inbox")).json.messages).toHaveLength(1);
  });

  it("does not remember a blocked attempt, so the retry can succeed", async () => {
    const s = await serve(await project());
    const blocked = await call(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "r@example.org", variables: {} }, headers: { "Idempotency-Key": "retry-1" } });
    expect([blocked.status, blocked.json.code]).toEqual([403, "preflight_blocked"]);
    const ok = await send(s.url, "r@example.org", {}, { "Idempotency-Key": "retry-1" });
    expect(ok.status).toBe(201);
  });
});

describe("errors, setup and tools", () => {
  it("gives every error a stable code and a request id", async () => {
    const s = await serve(await project(), "master");
    const unauth = await call(s.url, "/api/stats");
    expect(unauth.status).toBe(401);
    expect(unauth.json).toMatchObject({ ok: false, code: "unauthorized" });
    expect(unauth.json.requestId).toBe(unauth.headers.get("x-request-id"));
    expect(unauth.json.requestId).toMatch(/^req_[0-9a-f]{12}$/);
    expect((await call(s.url, "/api/nothing", { token: "master" })).json.code).toBe("not_found");
    expect((await call(s.url, "/api/send", { method: "POST", token: "master", body: { to: "a@b.co" } })).json.code).toBe("invalid_request");
  });

  it("reports an auth-check and saves the setup immediately (admin only)", async () => {
    const dir = await project();
    const s = await serve(dir, "master");
    const raw = "Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass\nDKIM-Signature: v=1; d=mail.example.com; s=sealpost; b=x\nFrom: A <a@mail.example.com>\n\nhi";
    expect((await call(s.url, "/api/auth-check", { method: "POST", token: "master", body: { raw } })).json.report.ok).toBe(true);

    const cfg = JSON.parse(await readFile(join(dir, "sealpost.config.json"), "utf8"));
    const saved = await call(s.url, "/api/setup", { method: "PUT", token: "master", body: { domain: { ...cfg.domain, domain: "news.acme.io", fromEmail: "hi@news.acme.io" } } });
    expect(saved.status).toBe(200);
    expect(JSON.parse(await readFile(join(dir, "sealpost.config.json"), "utf8")).domain.domain).toBe("news.acme.io");
    expect((await call(s.url, "/api/setup", { method: "PUT", token: "master", body: { domain: { domain: "x" } } })).json.code).toBe("validation_error");

    const key = (await (async () => { const out: string[] = []; await run(["auth", "add-key", "ci", "--dir", dir], { ...io, out: (t) => out.push(t) }); return out.join("\n").match(/evk_[A-Za-z0-9_-]+/)?.[0] ?? ""; })());
    expect(key).toMatch(/^evk_/);
  });
});

describe("sealpost logs", () => {
  it("lists and shows what happened to emails from the CLI", async () => {
    const dir = await project();
    const s = await serve(dir);
    const r = await send(s.url, "log@example.org", { tags: [{ name: "campaign", value: "welcome" }] });
    const out: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t) };
    expect(await run(["logs", "--dir", dir, "--tag", "campaign:welcome"], cap)).toBe(0);
    expect(out.join("\n")).toContain(r.json.id);
    out.length = 0;
    expect(await run(["logs", "show", r.json.id, "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/delivered/);
    expect(await run(["logs", "show", "em_nope", "--dir", dir], io)).toBe(1);
    expect(await run(["logs", "--status", "weird", "--dir", dir], io)).toBe(1);
  });
});

describe("timeseries", () => {
  it("returns zero-filled UTC days with sent, delivered and opens", async () => {
    const s = await serve(await project());
    const a = await send(s.url, "a@example.org");
    await send(s.url, "b@example.org");
    await fetch(`${s.url}/o/${encodeURIComponent(a.json.messageId)}.gif`);
    const r = (await call(s.url, "/api/stats/timeseries?days=7")).json;
    expect(r.days).toHaveLength(7);
    const today = r.days.at(-1);
    expect(today).toMatchObject({ date: new Date().toISOString().slice(0, 10), sent: 2, delivered: 2, bounced: 0, opens: 1 });
    expect(r.days.slice(0, 6).every((d: any) => d.sent === 0 && d.opens === 0)).toBe(true);
    expect((await call(s.url, "/api/stats/timeseries?days=0")).status).toBe(400);
    expect((await call(s.url, "/api/stats/timeseries?days=999")).status).toBe(400);
    expect((await call(s.url, "/api/stats/timeseries")).json.days).toHaveLength(14);
  });
});
