/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadProject, openRuntime, processQueue, run, sendEmail, startServer, type RunningServer, type Runtime } from "../src";
import { addContacts, createAudience, createBroadcast, processBroadcasts } from "../src/broadcast";
import { readLedger, verifyLedgerFile } from "../src/ledger";
import { startSmtpSink } from "../src/smtp/sink";
import { diskStorage, type Storage } from "../src/storage";
import { closeAllPostgres, openPostgresStorage } from "../src/storage-pg";
import { listInbox, readQueue } from "../src/store";
import type { Io } from "../src/ui";

/** A throwaway Postgres cluster, if this machine has one. These tests are skipped otherwise. */
const BIN = ["/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@14/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/14/bin"].find((d) => existsSync(join(d, "initdb")) && existsSync(join(d, "pg_ctl")));
const LOCALE = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
const PG_ENV = { ...process.env, LC_ALL: LOCALE, LANG: LOCALE };
let pgDir = "";
let url = "";

beforeAll(() => {
  if (!BIN) return;
  pgDir = mkdtempSync(join(tmpdir(), "sealpost-pg-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  execFileSync(join(BIN, "initdb"), ["-D", join(pgDir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore", env: PG_ENV });
  execFileSync(join(BIN, "pg_ctl"), ["-D", join(pgDir, "data"), "-o", `-p ${port} -k ${pgDir} -c listen_addresses=127.0.0.1 -c fsync=off`, "-l", join(pgDir, "log"), "-w", "start"], { stdio: "ignore", env: PG_ENV });
  url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  process.env.SEALPOST_TEST_DATABASE_URL = url;
}, 60_000);

afterAll(async () => {
  await closeAllPostgres();
  if (BIN && pgDir) {
    execFileSync(join(BIN, "pg_ctl"), ["-D", join(pgDir, "data"), "-m", "fast", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
    rmSync(pgDir, { recursive: true, force: true });
  }
});

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
let ns = 0;
const namespace = (): string => `t${Date.now().toString(36)}${ns++}`;

async function project(opts: { postgres?: string; patch?: (cfg: any) => void } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-pgp-"));
  expect(await run(["init", dir, "--name", "pg", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  if (opts.postgres) cfg.storage = { type: "postgres", urlEnv: "SEALPOST_TEST_DATABASE_URL", schema: "sealpost_test", namespace: opts.postgres };
  opts.patch?.(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
const OTP = "magic_link_otp_verification";
const vars = (n: number): Record<string, string> => ({ userName: "Ada", otpCode: String(100000 + n), signInUrl: "https://app.example.com/in" });

describe.skipIf(!BIN)("Postgres storage", () => {
  const backends: Array<[string, () => Promise<Storage>]> = [
    ["disk", async () => diskStorage],
    ["postgres", async () => openPostgresStorage({ url, urlEnv: "X", schema: "sealpost_test", namespace: namespace(), root: "/state" })],
  ];

  for (const [name, make] of backends) {
    it(`${name}: honours the storage contract (text, bytes, logs, listing, removal)`, async () => {
      const st = await make();
      const root = name === "disk" ? await mkdtemp(join(tmpdir(), "sealpost-st-")) : "/state";
      const p = (rel: string): string => `${root}/${rel}`;
      await expect(st.readText(p("missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(st.readBytes(p("missing.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await st.exists(p("a.json"))).toBe(false);

      await st.writeText(p("a.json"), '{"a":1}\n', 0o600);
      await st.writeText(p("a.json"), '{"a":2}\n', 0o600); // atomic replace
      expect(await st.readText(p("a.json"))).toBe('{"a":2}\n');
      expect(await st.exists(p("a.json"))).toBe(true);

      const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80, 0x0d, 0x0a]);
      await st.writeBytes(p("inbound/in_1.eml"), bytes);
      await st.writeText(p("inbound/in_1.json"), "{}");
      await st.writeText(p("inbound/in_2.json"), "{}");
      await st.writeText(p("inbound/nested/deep.json"), "{}");
      expect(Array.from(await st.readBytes(p("inbound/in_1.eml")))).toEqual(Array.from(bytes));
      expect((await st.list(p("inbound"))).sort()).toEqual(name === "disk" ? ["in_1.eml", "in_1.json", "in_2.json", "nested"] : ["in_1.eml", "in_1.json", "in_2.json"]);
      expect(await st.list(p("nothing-here"))).toEqual([]);

      await expect(st.readText(p("log.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      await Promise.all(Array.from({ length: 40 }, (_, i) => st.appendText(p("log.jsonl"), `${JSON.stringify({ i })}\n`, 0o600)));
      const lines = (await st.readText(p("log.jsonl"))).split("\n").filter(Boolean).map((l) => JSON.parse(l).i as number);
      expect(lines.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
      expect(await st.exists(p("log.jsonl"))).toBe(true);

      await st.remove(p("inbound/in_2.json"));
      await st.remove(p("inbound/in_2.json")); // removing twice is fine
      await st.removeTree(p("inbound"));
      expect(await st.exists(p("inbound/in_1.json"))).toBe(false);
      await st.removeTree(root);
      expect(await st.exists(p("log.jsonl"))).toBe(false);
      await expect(st.readText(p("log.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await st.withLock(async () => 42)).toBe(42);
      await expect(st.withLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      expect(await st.withLock(async () => "still usable")).toBe("still usable");
    });
  }

  it("keeps namespaces apart", async () => {
    const a = await openPostgresStorage({ url, urlEnv: "X", schema: "sealpost_test", namespace: namespace(), root: "/s" });
    const b = await openPostgresStorage({ url, urlEnv: "X", schema: "sealpost_test", namespace: namespace(), root: "/s" });
    await a.writeText("/s/x.json", "A");
    await expect(b.readText("/s/x.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains a missing connection string and a bad schema name", async () => {
    const dir = await project({ patch: (cfg) => { cfg.storage = { type: "postgres", urlEnv: "SEALPOST_NOT_SET_ANYWHERE", schema: "sealpost", namespace: "x" }; } });
    await expect(loadProject(dir)).rejects.toThrow(/SEALPOST_NOT_SET_ANYWHERE is not set/);
    const bad = await project({ patch: (cfg) => { cfg.storage = { type: "postgres", urlEnv: "SEALPOST_TEST_DATABASE_URL", schema: "x; drop table y", namespace: "x" }; } });
    await expect(loadProject(bad)).rejects.toMatchObject({ issues: [expect.stringContaining("storage")] });
  });

  it("runs the whole pipeline on Postgres and survives a restart with the same keys", async () => {
    const dir = await project({ postgres: namespace() });
    const start = async (): Promise<RunningServer> => {
      const s = await startServer({ dir, port: 0 });
      closers.push(() => s.close());
      return s;
    };
    const post = async (s: RunningServer, path: string, body: unknown): Promise<any> => (await fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const get = async (s: RunningServer, path: string): Promise<any> => (await fetch(`${s.url}${path}`)).json();

    const s1 = await start();
    const sent = await post(s1, "/api/send", { templateId: OTP, to: "ada@example.org", variables: vars(1), tags: [{ name: "t", value: "pg" }] });
    expect(sent).toMatchObject({ ok: true, status: "delivered" });
    const fp1 = (await get(s1, "/api/health")).keyFingerprint as string;
    const dkim1 = (await get(s1, "/api/dns")).records[1].value as string;
    expect((await get(s1, "/api/ledger/verify")).ok).toBe(true);
    expect((await get(s1, "/api/inbox")).messages).toHaveLength(1);
    await s1.close();
    closers.pop();

    // Nothing was written to the local state folder: it is all in the database.
    await expect(readFile(join(dir, ".sealpost", "ledger.jsonl"), "utf8")).rejects.toThrow();
    const s2 = await start();
    expect((await get(s2, "/api/health")).keyFingerprint).toBe(fp1);
    expect((await get(s2, "/api/dns")).records[1].value).toBe(dkim1);
    expect((await get(s2, `/api/emails/${sent.id}`))).toMatchObject({ id: sent.id, status: "delivered", tags: [{ name: "t", value: "pg" }] });
    expect((await get(s2, "/api/ledger")).total).toBe(1);
    const dup = await post(s2, "/api/send", { templateId: OTP, to: "ada@example.org", variables: vars(1) });
    expect(dup.code).toBe("preflight_blocked"); // EW-108 still remembers the send after a restart
  });

  it("migrates an existing disk project to Postgres without changing its keys or breaking the ledger", async () => {
    const dir = await project();
    const rt = await openRuntime(await loadProject(dir));
    for (let i = 0; i < 3; i++) expect((await sendEmail(rt, { templateId: OTP, to: `m${i}@example.org`, variables: vars(i) })).status).toBe("delivered");
    const before = rt.issuer.fingerprint;
    const dkimBefore = rt.dkim.publicKeySpkiBase64;

    const p = join(dir, "sealpost.config.json");
    const cfg = JSON.parse(await readFile(p, "utf8"));
    cfg.storage = { type: "postgres", urlEnv: "SEALPOST_TEST_DATABASE_URL", schema: "sealpost_test", namespace: namespace() };
    await writeFile(p, JSON.stringify(cfg));
    const out: string[] = [];
    const err: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t), err: (t) => err.push(t) };
    expect(await run(["storage", "status", "--dir", dir], cap)).toBe(0);
    expect(out.join("")).toMatch(/postgres/);
    expect(await run(["storage", "migrate", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/Copied \d+ files/);
    expect(await run(["storage", "migrate", "--dir", dir], { ...io, err: (t) => err.push(t) })).toBe(1);
    expect(err.join("\n")).toMatch(/already holds/);
    expect(await run(["storage", "migrate", "--force", "--dir", dir], io)).toBe(0);

    const rt2 = await openRuntime(await loadProject(dir));
    expect(rt2.issuer.fingerprint).toBe(before);
    expect(rt2.dkim.publicKeySpkiBase64).toBe(dkimBefore);
    const ver = await verifyLedgerFile(rt2.project.paths.ledger, rt2.project.storage);
    expect(ver, JSON.stringify(ver)).toMatchObject({ ok: true });
    expect(await readLedger(rt2.project.paths.ledger, rt2.project.storage)).toHaveLength(3);
    expect((await listInbox(rt2.project)).length).toBe(3);
    expect((await sendEmail(rt2, { templateId: OTP, to: "m0@example.org", variables: vars(0) })).status).toBe("blocked");
    expect(await run(["ledger", "verify", "--dir", dir], io)).toBe(0);
  });
});

describe.skipIf(!BIN)("several Sealpost processes on one database", () => {
  async function pair(patch?: (cfg: any) => void): Promise<[Runtime, Runtime]> {
    const shared = namespace();
    const a = await openRuntime(await loadProject(await project({ postgres: shared, patch })));
    const b = await openRuntime(await loadProject(await project({ postgres: shared, patch })));
    expect(b.issuer.fingerprint).toBe(a.issuer.fingerprint); // and therefore the same keys
    return [a, b];
  }

  it("never sends an identical email twice, whichever process receives it", async () => {
    const [a, b] = await pair();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sendEmail(i % 2 ? a : b, { templateId: OTP, to: "same@example.org", variables: vars(7) })));
    expect(results.filter((r) => r.status === "delivered")).toHaveLength(1);
    expect(results.filter((r) => r.status === "blocked")).toHaveLength(11);
    expect(await readLedger(a.project.paths.ledger, a.project.storage)).toHaveLength(1);
    expect(await listInbox(a.project)).toHaveLength(1);
  });

  it("keeps one unbroken hash chain when both processes append to the ledger at once", async () => {
    const [a, b] = await pair();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => sendEmail(i % 2 ? a : b, { templateId: OTP, to: `u${i}@example.org`, variables: vars(100 + i) })));
    expect(results.every((r) => r.status === "delivered")).toBe(true);
    const ledger = await readLedger(a.project.paths.ledger, a.project.storage);
    expect(ledger).toHaveLength(30);
    expect(new Set(ledger.map((r) => r.seq)).size).toBe(30);
    expect(await verifyLedgerFile(a.project.paths.ledger, a.project.storage)).toMatchObject({ ok: true, count: 30 });
  });

  it("hands each retry to exactly one worker", async () => {
    let accept = false;
    const relay = await startSmtpSink({ rcptRule: () => (accept ? undefined : { code: 451, text: "4.7.1 try later" }) });
    closers.push(() => relay.close());
    const [a, b] = await pair((cfg) => {
      cfg.transport = "smtp";
      cfg.allowPrivateNetworks = true;
      cfg.mailboxes = [{ id: "main", label: "Main", host: "127.0.0.1", port: relay.port, security: "none" }];
    });
    for (let i = 0; i < 8; i++) expect((await sendEmail(a, { templateId: OTP, to: `q${i}@example.org`, variables: vars(200 + i) })).status).toBe("queued");
    expect(await readQueue(a.project)).toHaveLength(8);
    accept = true;
    const later = Date.now() + 120_000;
    const runs = await Promise.all([processQueue(a, later), processQueue(b, later), processQueue(a, later), processQueue(b, later)]);
    expect(runs.reduce((n, r) => n + r.delivered, 0)).toBe(8);
    expect(relay.messages()).toHaveLength(8);
    expect(new Set(relay.messages().flatMap((m) => m.rcptTo)).size).toBe(8);
    expect(await readQueue(a.project)).toHaveLength(0);
    expect(await verifyLedgerFile(a.project.paths.ledger, a.project.storage)).toMatchObject({ ok: true, count: 8 });
  });

  it("lets only one process work on a broadcast at a time", async () => {
    const [a, b] = await pair();
    const aud = await createAudience(a, "All");
    await addContacts(a, aud.id, Array.from({ length: 12 }, (_, i) => ({ email: `c${i}@example.org`, variables: { userName: `C${i}` } })));
    await createBroadcast(a, { name: "Shared", audienceId: aud.id, templateId: OTP, variables: { otpCode: "111111", signInUrl: "https://app.example.com/in" }, ratePerMinute: 6000 });
    const t = Date.now() + 1000;
    for (let i = 0; i < 6; i++) await Promise.all([processBroadcasts(a, t + i * 1000), processBroadcasts(b, t + i * 1000)]);
    const inbox = await listInbox(a.project);
    expect(inbox).toHaveLength(12);
    expect(new Set(inbox.map((m) => m.rcptTo[0])).size).toBe(12);
  });
});
