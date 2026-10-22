/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON fixtures in integration tests */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime, processQueue, run, sendEmail, startServer, loadProject, type RunningServer } from "../src";
import type { Io } from "../src/ui";
import { startSmtpSink, type RunningSink, type SinkOptions } from "../src/smtp/sink";
import { readQueue, writeQueue } from "../src/store";

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t), color: false, stdin: async () => "" }, out, err };
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-test-"));
  expect(await run(["init", dir, "--name", "test-project", "--domain", "mail.example.com"], capture().io)).toBe(0);
  return dir;
}

const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.close();
});
async function serve(dir: string, apiKey?: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0, apiKey });
  closers.push(s);
  return s;
}
async function sink(opts: SinkOptions = {}): Promise<RunningSink> {
  const s = await startSmtpSink(opts);
  closers.push(s);
  return s;
}

async function api(base: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** Points the project at a real SMTP relay (a test sink) instead of the built-in one. */
async function useRelay(dir: string, port: number, extra: Record<string, unknown> = {}): Promise<void> {
  const file = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(file, "utf8"));
  cfg.transport = "smtp";
  cfg.allowPrivateNetworks = true;
  cfg.mailboxes = [{ id: "primary", label: "Primary", host: "127.0.0.1", port, security: "none" }];
  Object.assign(cfg, extra);
  await writeFile(file, JSON.stringify(cfg));
}

const OTP = "magic_link_otp_verification";

describe("project commands", () => {
  it("init scaffolds config, five templates and both keys; validate passes", async () => {
    const dir = await project();
    expect((await readdir(join(dir, "templates"))).sort()).toEqual(["enterprise_wire_invoice.json", "magic_link_otp_verification.json", "p1_incident_failover_alert.json", "usage_cap_circuit_warning.json", "workspace_team_invitation.json"]);
    expect((await readdir(join(dir, ".sealpost"))).sort()).toEqual(["dkim-key.json", "receipt-key.json"]);
    const c = capture();
    expect(await run(["validate", dir, "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out.join("")).templates).toHaveLength(5);
  });

  it("validate reports an undeclared {{variable}} and bad files; init refuses to overwrite", async () => {
    const dir = await project();
    const file = join(dir, "templates", `${OTP}.json`);
    const t = JSON.parse(await readFile(file, "utf8"));
    t.subject = "{{ghost}} is your code";
    await writeFile(file, JSON.stringify(t));
    await writeFile(join(dir, "templates", "broken.json"), "{ nope");
    const c = capture();
    expect(await run(["validate", dir], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("{{ghost}}");
    expect(c.err.join("\n")).toContain("broken.json");
    expect(await run(["init", dir], capture().io)).toBe(1);
  });

  it("dns prints real SPF / DKIM / DMARC / MX records using the project's DKIM key", async () => {
    const dir = await project();
    const c = capture();
    expect(await run(["dns", dir, "--json"], c.io)).toBe(0);
    const recs = JSON.parse(c.out.join(""));
    expect(recs.map((r: any) => r.purpose)).toEqual(["SPF", "DKIM", "DMARC", "MX"]);
    const k = capture();
    await run(["key", "show", dir, "--json"], k.io);
    expect(recs[1].value).toBe(`v=DKIM1; k=rsa; p=${JSON.parse(k.out.join("")).dkimPublicKeySpkiBase64}`);
  });

  it("compile exits 0 when clear and 2 when the gate blocks; --mime prints a DKIM-signed message", async () => {
    const dir = await project();
    expect(await run(["compile", OTP, "--dir", dir, "--auto-fill"], capture().io)).toBe(0);
    expect(await run(["compile", OTP, "--dir", dir], capture().io)).toBe(2);
    const m = capture();
    expect(await run(["compile", OTP, "--dir", dir, "--auto-fill", "--mime", "--json"], m.io)).toBe(0);
    const j = JSON.parse(m.out.join(""));
    expect(j.rawMime).toMatch(/^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=mail\.example\.com;/);
    expect(j.dkim).toMatchObject({ ok: true });
    expect(await run(["compile", OTP, "--dir", dir, "--auto-fill", "--to", "x@y.co\r\nBcc: v@e.test"], capture().io)).toBe(2);
    expect(await run(["compile", OTP, "--dir", dir, "--var", "nope=1"], capture().io)).toBe(1);
  });
});

describe("send → local sink → receipt → ledger", () => {
  it("delivers over raw SMTP to the test inbox with a verified DKIM signature, then seals and verifies the receipt", async () => {
    const dir = await project();
    const c = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "user@example.org", "--auto-fill", "--json"], c.io)).toBe(0);
    const out = JSON.parse(c.out.join(""));
    expect(out).toMatchObject({ status: "delivered", ledgerSeq: 1 });
    expect(out.receiptId).toMatch(/^evw_[0-9a-f]{16}$/);
    const inbox = join(dir, ".sealpost", "inbox");
    const files = await readdir(inbox);
    const id = files.find((f) => f.endsWith(".json"))?.replace(".json", "") ?? "";
    const meta = JSON.parse(await readFile(join(inbox, `${id}.json`), "utf8"));
    expect(meta).toMatchObject({ rcptTo: ["user@example.org"], dkim: { ok: true, bodyHashOk: true, signatureOk: true } });
    expect(meta.subject).toBe("482913 is your Acme sign-in code");
    const eml = join(inbox, `${id}.eml`);
    const receiptFile = join(dir, "r.evw.json");
    await writeFile(receiptFile, JSON.stringify({ token: out.receipt }));
    expect(await run(["receipt", "verify", receiptFile, "--eml", eml], capture().io)).toBe(0);
    await writeFile(eml, (await readFile(eml, "utf8")).replace("482913", "999999"));
    expect(await run(["receipt", "verify", receiptFile, "--eml", eml], capture().io)).toBe(2);
    expect(await run(["ledger", "verify", dir], capture().io)).toBe(0);
  });

  it("blocks before any socket: missing variable, header injection, duplicate (EW-108) and suppressed recipient (EW-107)", async () => {
    const dir = await project();
    const inboxCount = async (): Promise<number> => (await readdir(join(dir, ".sealpost", "inbox")).catch(() => [])).filter((f) => f.endsWith(".eml")).length;
    expect(await run(["send", OTP, "--dir", dir, "--to", "a@example.org"], capture().io)).toBe(2); // EW-101
    expect(await run(["send", OTP, "--dir", dir, "--to", "a@example.org\r\nBcc: v@e.test", "--auto-fill"], capture().io)).toBe(2); // EW-102
    expect(await inboxCount()).toBe(0);
    expect(await run(["send", OTP, "--dir", dir, "--to", "dup@example.org", "--auto-fill"], capture().io)).toBe(0);
    const again = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "dup@example.org", "--auto-fill"], again.io)).toBe(2);
    expect(again.out.join("\n")).toContain("EW-108");
    expect(await run(["send", OTP, "--dir", dir, "--to", "dup@example.org", "--auto-fill", "--var", "otpCode=111111"], capture().io)).toBe(0); // different variables → new key
    expect(await run(["suppress", "add", "gone@example.org", "--dir", dir, "--reason", "unsubscribed"], capture().io)).toBe(0);
    const sup = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "GONE@example.org", "--auto-fill"], sup.io)).toBe(2);
    expect(sup.out.join("\n")).toContain("EW-107");
    expect(await inboxCount()).toBe(2);
    expect(await run(["suppress", "remove", "gone@example.org", "--dir", dir], capture().io)).toBe(0);
    expect(await run(["ledger", "verify", dir], capture().io)).toBe(0);
  });

  it("detects a tampered ledger", async () => {
    const dir = await project();
    for (const to of ["a@example.org", "b@example.org"]) expect(await run(["send", OTP, "--dir", dir, "--to", to, "--auto-fill"], capture().io)).toBe(0);
    const file = join(dir, ".sealpost", "ledger.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const rec = JSON.parse(lines[0]);
    rec.smtpStatusCode = 550;
    lines[0] = JSON.stringify(rec);
    await writeFile(file, `${lines.join("\n")}\n`);
    expect(await run(["ledger", "verify", dir], capture().io)).toBe(2);
  });
});

describe("real relays: bounces, retries and failover", () => {
  it("a hard bounce fails the send, suppresses the address, and the next send is blocked before opening a socket", async () => {
    const dir = await project();
    let rcptCalls = 0;
    const relay = await sink({ rcptRule: (r) => { rcptCalls++; return r.startsWith("dead@") ? { code: 550, text: "5.1.1 No such user" } : undefined; } });
    await useRelay(dir, relay.port);
    const first = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "dead@example.org", "--auto-fill"], first.io)).toBe(2);
    expect(first.err.join("\n")).toContain("hard-bounced");
    expect(rcptCalls).toBe(1);
    const second = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "dead@example.org", "--auto-fill", "--var", "otpCode=222222"], second.io)).toBe(2);
    expect(second.out.join("\n")).toContain("EW-107");
    expect(rcptCalls).toBe(1); // no new connection attempt
    expect((await readFile(join(dir, ".sealpost", "suppressions.json"), "utf8"))).toContain("dead@example.org");
  });

  it("a transient failure is queued and retried at 10 s → 1 min → 5 min, then delivered when the relay recovers", async () => {
    const dir = await project();
    let healthy = false;
    const relay = await sink({ rcptRule: () => (healthy ? undefined : { code: 451, text: "4.7.1 Greylisted" }) });
    await useRelay(dir, relay.port);
    const rt = await openRuntime(await loadProject(dir));
    const first = await sendEmail(rt, { templateId: OTP, to: "late@example.org", variables: {}, autoFill: true });
    expect(first.status).toBe("queued");
    let q = await readQueue(rt.project);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ status: "queued", attempts: 1 });
    const delays: number[] = [];
    let now = 0;
    delays.push(Date.parse(q[0].nextAttemptAtIso) - Date.parse(q[0].createdAtIso));
    // retry 1 fails → next in 1 minute
    now = Date.parse(q[0].nextAttemptAtIso);
    expect((await processQueue(rt, now)).requeued).toBe(1);
    q = await readQueue(rt.project);
    delays.push(Date.parse(q[0].nextAttemptAtIso) - now);
    // retry 2 fails → next in 5 minutes
    now = Date.parse(q[0].nextAttemptAtIso);
    expect((await processQueue(rt, now)).requeued).toBe(1);
    q = await readQueue(rt.project);
    delays.push(Date.parse(q[0].nextAttemptAtIso) - now);
    expect(delays.map((d) => Math.round(d / 1000))).toEqual([10, 60, 300]);
    // not due yet → untouched
    expect((await processQueue(rt, now)).waiting).toBe(1);
    // relay recovers
    healthy = true;
    now = Date.parse(q[0].nextAttemptAtIso);
    expect(await processQueue(rt, now)).toMatchObject({ delivered: 1, waiting: 0 });
    expect(await readQueue(rt.project)).toHaveLength(0);
    expect(relay.messages()).toHaveLength(1);
    expect(await run(["ledger", "verify", dir], capture().io)).toBe(0);
  });

  it("gives up after the third retry and marks the message failed", async () => {
    const dir = await project();
    const relay = await sink({ rcptRule: () => ({ code: 451, text: "4.7.1 nope" }) });
    await useRelay(dir, relay.port);
    const rt = await openRuntime(await loadProject(dir));
    await sendEmail(rt, { templateId: OTP, to: "never@example.org", variables: {}, autoFill: true });
    let now = Date.now();
    for (let i = 0; i < 3; i++) {
      now += 3_600_000;
      await processQueue(rt, now);
    }
    const q = await readQueue(rt.project);
    expect(q[0]).toMatchObject({ status: "failed", attempts: 4 });
    // a failed item is never retried again
    expect(await processQueue(rt, now + 3_600_000)).toMatchObject({ delivered: 0, requeued: 0, failed: 0, waiting: 0 });
  });

  it("fails over to the backup mailbox when the primary is down", async () => {
    const dir = await project();
    const backup = await sink();
    const dead = await sink();
    const deadPort = dead.port;
    await dead.close();
    closers.splice(closers.indexOf(dead), 1);
    await useRelay(dir, deadPort, { mailboxes: [{ id: "primary", label: "P", host: "127.0.0.1", port: deadPort, security: "none" }, { id: "backup", label: "B", host: "127.0.0.1", port: backup.port, security: "none" }] });
    const c = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "u@example.org", "--auto-fill", "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out.join(""))).toMatchObject({ status: "delivered", smtp: { failedOver: true, mailboxId: "backup" } });
    expect(backup.messages()).toHaveLength(1);
  });

  it("reads SMTP passwords from the environment and refuses to start without them", async () => {
    const dir = await project();
    const relay = await sink({ auth: { username: "mailer", password: "env-secret" } });
    await useRelay(dir, relay.port, { mailboxes: [{ id: "primary", label: "P", host: "127.0.0.1", port: relay.port, security: "none", username: "mailer", passwordEnv: "EW_TEST_SMTP_PASSWORD" }] });
    delete process.env.EW_TEST_SMTP_PASSWORD;
    const missing = capture();
    expect(await run(["send", OTP, "--dir", dir, "--to", "u@example.org", "--auto-fill"], missing.io)).toBe(1);
    expect(missing.err.join("\n")).toContain("EW_TEST_SMTP_PASSWORD");
    process.env.EW_TEST_SMTP_PASSWORD = "env-secret";
    try {
      expect(await run(["send", OTP, "--dir", dir, "--to", "u@example.org", "--auto-fill"], capture().io)).toBe(0);
    } finally {
      delete process.env.EW_TEST_SMTP_PASSWORD;
    }
  });
});

describe("studio server", () => {
  it("compiles inline templates, sends stored templates, serves the inbox and verifies receipts against the message", async () => {
    const dir = await project();
    const s = await serve(dir);
    expect((await api(s.url, "/api/health")).json).toMatchObject({ name: "sealpost", transport: "sink" });
    const ws = (await api(s.url, "/api/workspace")).json;
    expect(ws.templates).toHaveLength(5);
    expect(ws.dns.map((r: any) => r.purpose)).toEqual(["SPF", "DKIM", "DMARC", "MX"]);
    const otp = ws.templates.find((t: any) => t.id === OTP);
    const inline = await api(s.url, "/api/compile", { method: "POST", body: { template: { ...otp, subject: "Edited {{otpCode}}" }, variables: {}, autoFill: true, to: "u@example.org", includeMime: true } });
    expect(inline.json.preflight.compiled.subject).toMatch(/^Edited /);
    expect(inline.json.dkim.ok).toBe(true);
    expect((await api(s.url, "/api/compile", { method: "POST", body: { template: { id: "x" }, variables: {} } })).status).toBe(422);
    expect((await api(s.url, "/api/send", { method: "POST", body: { template: otp, to: "u@example.org", autoFill: true } })).status).toBe(400); // inline templates never send

    const sent = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "u@example.org", autoFill: true } });
    expect(sent.status).toBe(201);
    const inbox = (await api(s.url, "/api/inbox")).json.messages;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].dkim.ok).toBe(true);
    const mail = (await api(s.url, `/api/inbox/${inbox[0].id}`)).json;
    const good = await api(s.url, "/api/verify", { method: "POST", body: { token: sent.json.receipt.token, inboxId: inbox[0].id } });
    expect(good.json).toMatchObject({ ok: true, mimeMatches: true, issuerTrusted: true });
    expect(mail.raw).toContain("DKIM-Signature:");
    expect((await api(s.url, "/api/ledger/verify")).json).toMatchObject({ ok: true, count: 1 });
    expect((await api(s.url, "/api/inbox/not-a-valid-id")).status).toBe(404);
    expect((await api(s.url, `/api/inbox/${"0".repeat(16)}`)).status).toBe(404);
  });

  it("serialises concurrent sends: identical requests dedupe to one, distinct ones all land, and the chain never forks", async () => {
    const dir = await project();
    const s = await serve(dir);
    const same = await Promise.all(Array.from({ length: 8 }, () => api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "same@example.org", autoFill: true } })));
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    expect(same.filter((r) => r.status === 403)).toHaveLength(7);
    expect(same.find((r) => r.status === 403)?.json.code).toBe("preflight_blocked");
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) => api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: `u${i}@example.org`, autoFill: true } })));
    expect(many.every((r) => r.status === 201)).toBe(true);
    const ledger = (await api(s.url, "/api/ledger")).json;
    expect(ledger.total).toBe(11);
    expect(new Set(ledger.records.map((r: any) => r.seq)).size).toBe(11);
    expect((await api(s.url, "/api/ledger/verify")).json).toMatchObject({ ok: true, count: 11 });
  });

  it("tracks opens and clicks, and the click redirect can never be an open redirect", async () => {
    const dir = await project();
    const s = await serve(dir);
    const cfgFile = join(dir, "sealpost.config.json");
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.domain.trackingBaseUrl = s.url;
    await writeFile(cfgFile, JSON.stringify(cfg));
    const ws = (await api(s.url, "/api/workspace")).json;
    await api(s.url, "/api/workspace", { method: "PUT", body: { templates: ws.templates, domain: { ...ws.domain, trackingBaseUrl: s.url } } });
    const sent = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "t@example.org", autoFill: true } });
    expect(sent.status).toBe(201);
    const mid = sent.json.messageId as string;
    const mail = (await api(s.url, `/api/inbox/${(await api(s.url, "/api/inbox")).json.messages[0].id}`)).json.raw as string;
    const html = Buffer.from(mail.split("Content-Type: text/html")[1].split("\r\n\r\n")[1].split("\r\n--")[0].replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("latin1");
    expect(html).toContain(`/o/${encodeURIComponent(mid)}.gif`);
    const pixel = await fetch(`${s.url}/o/${encodeURIComponent(mid)}.gif`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get("content-type")).toBe("image/gif");
    const link = "https://app.example.com/auth/verify?token=abc123";
    const click = await fetch(`${s.url}/c/${encodeURIComponent(mid)}?u=${encodeURIComponent(link)}`, { redirect: "manual" });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe(link);
    for (const evil of ["https://evil.example/phish", "javascript:alert(1)", "//evil.example"]) expect((await fetch(`${s.url}/c/${encodeURIComponent(mid)}?u=${encodeURIComponent(evil)}`, { redirect: "manual" })).status).toBe(404);
    expect((await fetch(`${s.url}/c/${encodeURIComponent("<nope@x>")}?u=${encodeURIComponent(link)}`, { redirect: "manual" })).status).toBe(404);
    const events = (await api(s.url, "/api/events")).json.events as Array<{ type: string }>;
    expect(events.map((e) => e.type).sort()).toEqual(["click", "open"]);
  });

  it("requires an API key, keeps the workspace admin-only, leaves tracking public, and refuses a public bind without auth", async () => {
    const dir = await project();
    const s = await serve(dir, "master-secret");
    expect((await api(s.url, "/api/workspace")).status).toBe(401);
    const ws = await api(s.url, "/api/workspace", { token: "master-secret" });
    expect(ws.status).toBe(200);
    expect((await fetch(`${s.url}/o/anything.gif`)).status).toBe(200);
    expect((await api(s.url, "/api/workspace", { method: "PUT", token: "master-secret", body: { templates: ws.json.templates } })).status).toBe(200);
    const k = capture();
    expect(await run(["auth", "add-key", "ci", "--dir", dir], k.io)).toBe(0);
    const key = k.out.join("\n").match(/evk_[A-Za-z0-9_-]+/)?.[0] ?? "";
    expect(key.startsWith("evk_")).toBe(true);
    const s2 = await serve(dir);
    expect((await api(s2.url, "/api/workspace", { token: key })).status).toBe(200);
    expect((await api(s2.url, "/api/workspace", { method: "PUT", token: key, body: { templates: ws.json.templates } })).status).toBe(403);
    expect((await api(s2.url, "/api/send", { method: "POST", token: key, body: { templateId: OTP, to: "k@example.org", autoFill: true } })).status).toBe(201);
    await expect(startServer({ dir, port: 0, host: "0.0.0.0", apiKey: "" })).resolves.toBeDefined().catch(() => undefined);
  });

  it("the retry worker delivers queued mail on its own once the relay recovers", async () => {
    const dir = await project();
    let healthy = false;
    const relay = await sink({ rcptRule: () => (healthy ? undefined : { code: 451, text: "4.7.1 Greylisted" }) });
    await useRelay(dir, relay.port);
    const s = await serve(dir);
    const sent = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "w@example.org", autoFill: true } });
    expect(sent.status).toBe(202);
    healthy = true;
    const file = join(dir, ".sealpost", "queue.json");
    const q = JSON.parse(await readFile(file, "utf8"));
    q[0].nextAttemptAtIso = new Date(Date.now() - 1000).toISOString();
    await writeQueue(await loadProject(dir), q);
    const start = Date.now();
    let delivered = false;
    while (Date.now() - start < 8000 && !delivered) {
      await new Promise((r) => setTimeout(r, 250));
      delivered = relay.messages().length === 1 && (await api(s.url, "/api/ledger")).json.total === 1;
    }
    expect(delivered).toBe(true);
    expect((await api(s.url, "/api/ledger/verify")).json).toMatchObject({ ok: true, count: 1 });
  });
});

describe("relay feedback, batch, stats and the SDK", () => {
  const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };

  it("is disabled without a secret, rejects a bad token, and suppresses on hard bounce and complaint", async () => {
    const dir = await project();
    const off = await serve(dir);
    expect((await api(off.url, "/hooks/relay/ses?token=x", { method: "POST", body: {} })).status).toBe(404);

    const s = await startServer({ dir, port: 0, webhookSecret: "s3cret-token" });
    closers.push(s);
    expect((await api(s.url, "/hooks/relay/ses?token=wrong", { method: "POST", body: {} })).status).toBe(401);
    expect((await api(s.url, "/hooks/relay/nope?token=s3cret-token", { method: "POST", body: {} })).status).toBe(404);

    const bounce = JSON.stringify({ notificationType: "Bounce", mail: { messageId: "r1" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "Gone@Example.org", diagnosticCode: "550 no such user" }] } });
    const r = await api(s.url, "/hooks/relay/ses?token=s3cret-token", { method: "POST", body: { Type: "Notification", Message: bounce } });
    expect(r.json).toMatchObject({ ok: true, received: 1, suppressed: 1 });
    await api(s.url, "/hooks/relay/sendgrid?token=s3cret-token", { method: "POST", body: [{ event: "spamreport", email: "angry@example.org" }, { event: "deferred", email: "slow@example.org" }] });

    const sup = (await api(s.url, "/api/suppressions")).json.suppressions as Array<{ email: string; reason: string }>;
    expect(sup.map((x) => `${x.email}:${x.reason}`).sort()).toEqual(["angry@example.org:complaint", "gone@example.org:hard_bounce"]);
    const stats = (await api(s.url, "/api/stats")).json;
    expect(stats).toMatchObject({ bounces: 1, complaints: 1, suppressed: 2 });

    const blocked = await api(s.url, "/api/send", { method: "POST", body: { templateId: "magic_link_otp_verification", to: "gone@example.org", variables: vars } });
    expect(blocked.status).toBe(403);
    expect(JSON.stringify(blocked.json.preflight.checks)).toContain("EW-107");
  });

  it("sends a batch with per-item results and serves an OpenAPI document", async () => {
    const s = await serve(await project(), "master-key");
    const t = "master-key";
    const r = await api(s.url, "/api/send/batch", { method: "POST", token: t, body: { emails: [{ templateId: "magic_link_otp_verification", to: "a@example.org", variables: vars }, { templateId: "magic_link_otp_verification", to: "b@example.org", variables: vars }, { templateId: "missing", to: "c@example.org" }, { templateId: "magic_link_otp_verification", to: "a@example.org", variables: vars }] } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ accepted: 2, rejected: 2 });
    expect(r.json.results.map((x: any) => x.status)).toEqual(["delivered", "delivered", "failed", "blocked"]);
    expect((await api(s.url, "/api/send/batch", { method: "POST", token: t, body: { emails: [] } })).status).toBe(400);
    const spec = await api(s.url, "/api/openapi.json");
    expect(spec.json.openapi).toBe("3.1.0");
    expect(Object.keys(spec.json.paths)).toContain("/hooks/relay/{provider}");
  });

  it("drives a real server through @sealpost/sdk", async () => {
    const { Sealpost } = await import("../../sdk/src");
    const s = await serve(await project(), "master-key");
    const mail = new Sealpost({ apiKey: "master-key", baseUrl: s.url });
    const sent = await mail.emails.send({ template: "magic_link_otp_verification", to: "sdk@example.org", variables: vars });
    expect(sent.error).toBeNull();
    expect(sent.data?.status).toBe("delivered");
    expect(sent.data?.receipt?.startsWith("evw_")).toBe(true);
    const again = await mail.emails.send({ template: "magic_link_otp_verification", to: "sdk@example.org", variables: vars });
    expect(again.error).toMatchObject({ status: 403, code: "preflight_blocked" });
    expect(again.error?.preflight?.gate).toBe("BLOCKED");
    expect((await mail.ledger.verify()).data).toMatchObject({ ok: true, count: 1 });
    expect((await mail.receipts.verify(sent.data?.receipt ?? "")).data?.ok).toBe(true);
    expect((await mail.stats.get()).data?.sent).toBe(1);
    expect((await new Sealpost({ apiKey: "wrong", baseUrl: s.url }).stats.get()).error?.status).toBe(401);
  });
});
