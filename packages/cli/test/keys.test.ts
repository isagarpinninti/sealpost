/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startServer, type RunningServer } from "../src";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-keys-"));
  expect(await run(["init", dir, "--name", "k", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  patch(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
async function serve(dir: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0, apiKey: "master" });
  closers.push(() => s.close());
  return s;
}
async function call(base: string, path: string, o: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: res.status, json: await res.json() };
}
const OTP = "magic_link_otp_verification";
const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
const mk = async (s: RunningServer, label: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<string> => (await call(s.url, "/api/keys", { method: "POST", token: "master", body: { label, scopes, ...extra } })).json.key as string;

describe("API key scopes", () => {
  it("enforces send, read and write scopes per route", async () => {
    const s = await serve(await project());
    const sendKey = await mk(s, "sender", ["send"]);
    const readKey = await mk(s, "reader", ["read"]);
    const writeKey = await mk(s, "writer", ["write"]);
    const body = { templateId: OTP, to: "a@example.org", variables: vars };

    expect((await call(s.url, "/api/send", { method: "POST", token: sendKey, body })).status).toBe(201);
    const blocked = await call(s.url, "/api/emails", { token: sendKey });
    expect([blocked.status, blocked.json.code, blocked.json.requiredScope]).toEqual([403, "insufficient_scope", "read"]);
    expect((await call(s.url, "/api/suppressions", { method: "POST", token: sendKey, body: { email: "x@y.io" } })).json.requiredScope).toBe("write");

    expect((await call(s.url, "/api/emails", { token: readKey })).status).toBe(200);
    expect((await call(s.url, "/api/stats", { token: readKey })).status).toBe(200);
    expect((await call(s.url, "/api/send", { method: "POST", token: readKey, body: { ...body, to: "b@example.org" } })).json.requiredScope).toBe("send");
    expect((await call(s.url, "/api/auth-check", { method: "POST", token: readKey, body: { raw: "Authentication-Results: x; dkim=pass\nFrom: a@b.co\n\nhi" } })).status).toBe(200);

    expect((await call(s.url, "/api/suppressions", { method: "POST", token: writeKey, body: { email: "x@y.io" } })).status).toBe(201);
    expect((await call(s.url, "/api/suppressions", { token: writeKey })).status).toBe(403);
    for (const k of [sendKey, readKey, writeKey]) {
      expect((await call(s.url, "/api/keys", { token: k })).status).toBe(403);
      expect((await call(s.url, "/api/audit", { token: k })).status).toBe(403);
      expect((await call(s.url, "/api/workspace", { method: "PUT", token: k, body: {} })).status).toBe(403);
    }
  });

  it("creates, lists, persists and revokes keys with immediate effect; secrets are only hashed", async () => {
    const dir = await project();
    const s = await serve(dir);
    const created = (await call(s.url, "/api/keys", { method: "POST", token: "master", body: { label: "ci", scopes: ["read"], expiresInDays: 30 } })).json;
    expect(created).toMatchObject({ ok: true, label: "ci", scopes: ["read"] });
    expect(created.key).toMatch(/^evk_/);
    expect(Date.parse(created.expiresAtIso) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const list = (await call(s.url, "/api/keys", { token: "master" })).json.keys;
    expect(list).toEqual([expect.objectContaining({ id: created.id, label: "ci", scopes: ["read"] })]);
    expect(JSON.stringify(list)).not.toContain(created.key);
    const onDisk = await readFile(join(dir, "sealpost.config.json"), "utf8");
    expect(onDisk).not.toContain(created.key);
    expect(onDisk).toContain(createHash("sha256").update(created.key).digest("hex"));

    expect((await call(s.url, "/api/emails", { token: created.key })).status).toBe(200);
    expect((await call(s.url, `/api/keys/${created.id}`, { method: "DELETE", token: "master" })).status).toBe(200);
    expect((await call(s.url, "/api/emails", { token: created.key })).status).toBe(401);
    expect((await call(s.url, "/api/keys/aaaaaaaaaaaa", { method: "DELETE", token: "master" })).status).toBe(404);
    expect((await call(s.url, "/api/keys", { method: "POST", token: "master", body: { label: "x", scopes: ["root"] } })).status).toBe(400);
  });

  it("rejects an expired key and keeps legacy label-only keys working with every scope", async () => {
    const legacy = "evk_legacy_token_value";
    const expired = "evk_expired_token_value";
    const h = (t: string): string => createHash("sha256").update(t).digest("hex");
    const s = await serve(await project((cfg) => {
      cfg.auth.keys = { [h(legacy)]: "old-ci", [h(expired)]: { label: "gone", scopes: ["read"], createdAtIso: "2020-01-01T00:00:00Z", expiresAtIso: "2021-01-01T00:00:00Z" } };
    }));
    expect((await call(s.url, "/api/emails", { token: expired })).status).toBe(401);
    expect((await call(s.url, "/api/send", { method: "POST", token: legacy, body: { templateId: OTP, to: "l@example.org", variables: vars } })).status).toBe(201);
    expect((await call(s.url, "/api/suppressions", { method: "POST", token: legacy, body: { email: "z@y.io" } })).status).toBe(201);
    expect((await call(s.url, "/api/keys", { token: legacy })).status).toBe(403);
  });
});

describe("audit log", () => {
  it("records writes and failed logins with the actor, never reads or query strings", async () => {
    const dir = await project();
    const s = await serve(dir);
    const key = await mk(s, "app", ["send", "read"]);
    await call(s.url, "/api/send", { method: "POST", token: key, body: { templateId: OTP, to: "audit@example.org", variables: vars } });
    await call(s.url, "/api/emails?to=secret@example.org", { token: key });
    await call(s.url, "/api/suppressions", { method: "POST", token: key, body: { email: "no@example.org" } });
    await call(s.url, "/api/stats", { token: "wrong-key" });
    let entries: any[] = [];
    for (let i = 0; i < 30 && entries.length < 6; i++) {
      await new Promise((r) => setTimeout(r, 50));
      entries = (await call(s.url, "/api/audit", { token: "master" })).json.entries as any[];
    }
    const brief = entries.map((e) => `${e.actor} ${e.method} ${e.path} ${e.status}`);
    expect(brief).toEqual(expect.arrayContaining(["master POST /api/keys 201", "key:app POST /api/send 201", "key:app POST /api/suppressions 403", "anonymous GET /api/stats 401"]));
    expect(brief.some((b) => b.includes("GET /api/emails"))).toBe(false);
    expect(JSON.stringify(entries)).not.toContain("secret@example.org");
    expect(entries[0]).toMatchObject({ ip: expect.any(String), requestId: expect.stringMatching(/^req_/) });
    expect((await call(s.url, "/api/audit?actor=key:app", { token: "master" })).json.entries.every((e: any) => e.actor === "key:app")).toBe(true);
  });

  it("manages keys and shows the audit trail from the CLI", async () => {
    const dir = await project();
    const out: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t) };
    expect(await run(["auth", "add-key", "deploy", "--scope", "send,read", "--expires", "90", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/\[send, read\] expires/);
    expect(await run(["auth", "add-key", "bad", "--scope", "root", "--dir", dir], io)).toBe(1);
    expect(await run(["auth", "add-key", "bad", "--expires", "0", "--dir", dir], io)).toBe(1);
    out.length = 0;
    expect(await run(["auth", "list", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/deploy\s+send,read/);
    expect(await run(["auth", "revoke", "deploy", "--dir", dir], cap)).toBe(0);
    expect(await run(["auth", "revoke", "deploy", "--dir", dir], io)).toBe(1);
    out.length = 0;
    expect(await run(["audit", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/No audit entries/);
  });
});
