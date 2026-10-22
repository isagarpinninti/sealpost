/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@sealpost/core";
import { addContacts, cancelBroadcast, createAudience, createBroadcast, processBroadcasts } from "../src/broadcast";
import { parseCsv } from "../src/commands";
import { openRuntime, run, sendEmail, startServer, loadProject, type RunningServer } from "../src";
import { emitEvent, processOutbox } from "../src/outbound";
import { listInbox, readAudiences, readBroadcasts, readOutbox, readSuppressions, writeSuppressions } from "../src/store";
import { startSmtpSink } from "../src/smtp/sink";
import type { Io } from "../src/ui";

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t), color: false, stdin: async () => "" }, out, err };
}

async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-feat-"));
  expect(await run(["init", dir, "--name", "feat", "--domain", "mail.example.com"], capture().io)).toBe(0);
  const path = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(path, "utf8"));
  patch(cfg);
  await writeFile(path, JSON.stringify(cfg, null, 2));
  return dir;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function serve(dir: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0 });
  closers.push(() => s.close());
  return s;
}
async function api(base: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return { status: res.status, json: await res.json() };
}

interface Hit {
  body: string;
  signature: string;
  eventType: string;
}
async function receiver(statuses: number[] = [200]): Promise<{ url: string; hits: Hit[]; server: Server }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ body, signature: String(req.headers["sealpost-signature"] ?? ""), eventType: String(req.headers["sealpost-event-type"] ?? "") });
      res.writeHead(statuses[Math.min(hits.length - 1, statuses.length - 1)]);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, hits, server };
}

const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
const OTP = "magic_link_otp_verification";

describe("multiple sending domains", () => {
  it("signs each domain with its own key, verifies at the sink, and keeps From aligned", async () => {
    const dir = await project();
    const c = capture();
    expect(await run(["domain", "add", "news.example.org", "--from", "news@news.example.org", "--name", "Acme News", "--selector", "n1", "--dir", dir], c.io)).toBe(0);
    expect((await readdir(join(dir, ".sealpost"))).sort()).toContain("dkim-news.example.org.json");
    expect(await run(["domain", "add", "news.example.org", "--dir", dir], capture().io)).toBe(1);

    const s = await serve(dir);
    const dnsA = (await api(s.url, "/api/dns")).json;
    const dnsB = (await api(s.url, "/api/dns?domain=news.example.org")).json;
    expect(dnsB.domain).toBe("news.example.org");
    expect(dnsB.records[1].name).toBe("n1._domainkey");
    expect(dnsB.records[1].value).not.toBe(dnsA.records[1].value);
    expect((await api(s.url, "/api/dns?domain=nope.example.net")).status).toBe(404);
    expect((await api(s.url, "/api/domains")).json.domains.map((d: any) => d.domain)).toEqual(["mail.example.com", "news.example.org"]);

    const a = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "a@example.org", variables: vars } });
    const b = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, domain: "news.example.org", to: "b@example.org", variables: vars } });
    expect([a.status, b.status]).toEqual([201, 201]);
    const inbox = (await api(s.url, "/api/inbox")).json.messages as any[];
    const toB = inbox.find((m) => m.rcptTo.includes("b@example.org"));
    expect(toB.from).toContain("news@news.example.org");
    expect(toB.dkim).toMatchObject({ ok: true, domain: "news.example.org", selector: "n1" });
    expect(inbox.find((m) => m.rcptTo.includes("a@example.org")).dkim).toMatchObject({ ok: true, domain: "mail.example.com" });

    const wrongFrom = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, domain: "news.example.org", fromEmail: "hello@mail.example.com", to: "c@example.org", variables: vars } });
    expect(wrongFrom.status).toBe(403);
    expect(JSON.stringify(wrongFrom.json.preflight.checks)).toContain("EW-103");
    expect((await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, domain: "nope.example.net", to: "d@example.org", variables: vars } })).status).toBe(404);
  });

  it("rejects duplicate domains and refuses to remove the primary", async () => {
    const dir = await project();
    expect(await run(["domain", "remove", "mail.example.com", "--dir", dir], capture().io)).toBe(1);
    const cfgPath = join(dir, "sealpost.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.domains = [{ ...cfg.domain }];
    await writeFile(cfgPath, JSON.stringify(cfg));
    await expect(loadProject(dir)).rejects.toThrow(/issue/);
  });
});

describe("outbound webhooks", () => {
  const setup = async (statuses: number[] = [200], events: string[] = ["*"]) => {
    const hook = await receiver(statuses);
    process.env.SEALPOST_TEST_WHSEC = "whsec_test_secret";
    const dir = await project((cfg) => {
      cfg.allowPrivateNetworks = true;
      cfg.webhooks = [{ id: "app", url: hook.url, events, secretEnv: "SEALPOST_TEST_WHSEC" }];
    });
    return { hook, dir, rt: await openRuntime(await loadProject(dir)) };
  };

  it("delivers a signed email.delivered event that verifies against the raw body", async () => {
    const { hook, rt } = await setup();
    const out = await sendEmail(rt, { templateId: OTP, to: "user@example.org", variables: vars });
    expect(out.status).toBe("delivered");
    await new Promise((r) => setTimeout(r, 20));
    expect(await processOutbox(rt)).toMatchObject({ delivered: 1 });
    expect(hook.hits).toHaveLength(1);
    expect(hook.hits[0].eventType).toBe("email.delivered");
    expect(await verifyWebhookSignature("whsec_test_secret", hook.hits[0].body, hook.hits[0].signature)).toEqual({ ok: true });
    expect(await verifyWebhookSignature("wrong", hook.hits[0].body, hook.hits[0].signature)).toMatchObject({ ok: false });
    const ev = JSON.parse(hook.hits[0].body);
    expect(ev).toMatchObject({ type: "email.delivered", data: { to: "user@example.org", templateId: OTP, receiptId: out.receipt?.receiptId } });
    expect(ev.id).toMatch(/^evt_/);
  });

  it("retries a failing endpoint on the 10 s schedule, then succeeds", async () => {
    const { hook, rt } = await setup([500, 200]);
    await emitEvent(rt, "email.opened", { messageId: "m1" });
    const t0 = Date.now();
    expect(await processOutbox(rt, t0)).toMatchObject({ retrying: 1, delivered: 0 });
    let item = (await readOutbox(rt.project))[0];
    expect(item).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });
    expect(Date.parse(item.nextAttemptAtIso) - t0).toBe(10_000);
    expect(await processOutbox(rt, t0 + 5_000)).toMatchObject({ delivered: 0, retrying: 0 });
    expect(await processOutbox(rt, t0 + 11_000)).toMatchObject({ delivered: 1 });
    item = (await readOutbox(rt.project))[0];
    expect(item).toMatchObject({ status: "delivered", attempts: 2 });
    expect(hook.hits).toHaveLength(2);
    expect(JSON.parse(hook.hits[0].body).id).toBe(JSON.parse(hook.hits[1].body).id);
  });

  it("gives up after the last retry", async () => {
    const { rt } = await setup([500]);
    await emitEvent(rt, "email.opened", {});
    let now = Date.now();
    for (let i = 0; i < 6; i++) {
      await processOutbox(rt, now);
      now += 8_000_000;
    }
    expect((await readOutbox(rt.project))[0]).toMatchObject({ status: "failed", attempts: 6 });
  });

  it("filters by event pattern and fails fast without a secret", async () => {
    const { hook, rt } = await setup([200], ["email.delivered", "broadcast.*"]);
    expect(await emitEvent(rt, "email.opened", {})).toBeNull();
    expect(await emitEvent(rt, "broadcast.completed", {})).not.toBeNull();
    delete process.env.SEALPOST_TEST_WHSEC;
    expect(await processOutbox(rt)).toMatchObject({ failed: 1 });
    expect((await readOutbox(rt.project))[0].lastNote).toMatch(/SEALPOST_TEST_WHSEC is not set/);
    expect(hook.hits).toHaveLength(0);
  });

  it("refuses private targets unless allowed", async () => {
    const { rt } = await setup();
    rt.project.config.allowPrivateNetworks = false;
    await emitEvent(rt, "email.opened", {});
    await processOutbox(rt);
    expect((await readOutbox(rt.project))[0].lastNote).toMatch(/private|loopback|not allowed/i);
  });

  it("is reachable through the API and CLI (ping)", async () => {
    const { hook, dir } = await setup();
    const s = await serve(dir);
    const list = (await api(s.url, "/api/webhooks")).json;
    expect(list.endpoints[0]).toMatchObject({ id: "app", secretEnvSet: true });
    expect((await api(s.url, "/api/webhooks/app/test", { method: "POST" })).status).toBe(202);
    expect(hook.hits.map((h) => h.eventType)).toContain("webhook.ping");
    expect((await api(s.url, "/api/webhooks/nope/test", { method: "POST" })).status).toBe(404);
    expect((await api(s.url, "/api/webhooks/deliveries")).json.deliveries[0].body).toBeUndefined();
  });

  it("sends open and relay-bounce events through the server", async () => {
    const hook = await receiver();
    process.env.SEALPOST_TEST_WHSEC = "whsec_test_secret";
    const dir = await project((cfg) => {
      cfg.allowPrivateNetworks = true;
      cfg.webhooks = [{ id: "app", url: hook.url, events: ["*"], secretEnv: "SEALPOST_TEST_WHSEC" }];
    });
    const s = await startServer({ dir, port: 0, webhookSecret: "relay-secret" });
    closers.push(() => s.close());
    const sent = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "o@example.org", variables: vars } });
    const id = sent.json.messageId as string;
    await fetch(`${s.url}/o/${encodeURIComponent(id)}.gif`);
    await api(s.url, "/hooks/relay/postmark?token=relay-secret", { method: "POST", body: { RecordType: "Bounce", Type: "HardBounce", Email: "gone@example.org" } });
    await new Promise((r) => setTimeout(r, 2500));
    const types = hook.hits.map((h) => h.eventType);
    expect(types).toEqual(expect.arrayContaining(["email.delivered", "email.opened", "email.bounced"]));
  });
});

describe("audiences and broadcasts", () => {
  const rtFor = async (patch?: (cfg: any) => void) => openRuntime(await loadProject(await project(patch)));
  const base = { otpCode: "111111", signInUrl: "https://app.example.com/in" };

  it("imports a CSV with quotes and per-contact variables", () => {
    expect(parseCsv('email,name,userName\r\na@x.io,"Smith, Ada",Ada\nbad,,\n\n"b@x.io","O""Neil",Bo\n')).toEqual([
      ["email", "name", "userName"],
      ["a@x.io", "Smith, Ada", "Ada"],
      ["bad", "", ""],
      ["b@x.io", 'O"Neil', "Bo"],
    ]);
  });

  it("manages contacts: normalises, dedupes, rejects invalid addresses", async () => {
    const rt = await rtFor();
    const a = await createAudience(rt, "Customers");
    const r = await addContacts(rt, a.id, [{ email: " Ada@Example.org ", name: "Ada" }, { email: "ada@example.org", variables: { plan: "pro" } }, { email: "nope" }]);
    expect(r).toMatchObject({ added: 1, updated: 1 });
    expect(r.rejected).toEqual([{ email: "nope", reason: "Not a valid email address" }]);
    expect((await readAudiences(rt.project))[0].contacts[0]).toMatchObject({ email: "ada@example.org", name: "Ada", variables: { plan: "pro" } });
  });

  it("waits for its schedule, personalises per contact, skips suppressed contacts and completes", async () => {
    const rt = await rtFor();
    await writeSuppressions(rt.project, [{ email: "unsub@example.org", reason: "unsubscribed", atIso: new Date().toISOString() }]);
    const aud = await createAudience(rt, "Launch");
    await addContacts(rt, aud.id, [{ email: "ada@example.org", variables: { userName: "Ada" } }, { email: "bo@example.org", variables: { userName: "Bo" } }, { email: "unsub@example.org", variables: { userName: "Una" } }, { email: "nouser@example.org" }]);
    const at = Date.now() + 3_600_000;
    const b = await createBroadcast(rt, { name: "Launch day", audienceId: aud.id, templateId: OTP, variables: base, scheduledAtIso: new Date(at).toISOString(), ratePerMinute: 6000 });
    expect(await processBroadcasts(rt, Date.now())).toEqual({ started: 0, sent: 0, completed: 0 });
    expect((await readBroadcasts(rt.project))[0].status).toBe("scheduled");

    expect((await processBroadcasts(rt, at)).started).toBe(1);
    await processBroadcasts(rt, at + 1000);
    const done = (await readBroadcasts(rt.project))[0];
    expect(done.id).toBe(b.id);
    expect(done.status).toBe("completed");
    expect(done.counts).toMatchObject({ total: 4, delivered: 2, suppressed: 1, blocked: 1, failed: 0 });
    const inbox = await listInbox(rt.project);
    expect(inbox.map((m) => m.rcptTo[0]).sort()).toEqual(["ada@example.org", "bo@example.org"]);
    expect(inbox.every((m) => m.dkim?.ok)).toBe(true);
  });

  it("resumes at the cursor after a restart without double sending, and cancel stops it", async () => {
    const dir = await project();
    const rt = await openRuntime(await loadProject(dir));
    const aud = await createAudience(rt, "Slow");
    await addContacts(rt, aud.id, ["a", "b", "c", "d"].map((n) => ({ email: `${n}@example.org`, variables: { userName: n } })));
    await createBroadcast(rt, { name: "Slow", audienceId: aud.id, templateId: OTP, variables: base, ratePerMinute: 60 });
    const t = Date.now() + 1000;
    await processBroadcasts(rt, t);
    await processBroadcasts(rt, t + 1000);
    expect((await readBroadcasts(rt.project))[0]).toMatchObject({ cursor: 2, status: "sending" });

    const rt2 = await openRuntime(await loadProject(dir));
    await processBroadcasts(rt2, t + 2000);
    expect((await readBroadcasts(rt2.project))[0].cursor).toBe(3);
    const id = (await readBroadcasts(rt2.project))[0].id;
    expect((await cancelBroadcast(rt2, id)).status).toBe("cancelled");
    await processBroadcasts(rt2, t + 3000);
    expect((await readBroadcasts(rt2.project))[0].cursor).toBe(3);
    expect(await listInbox(rt2.project)).toHaveLength(3);
    await expect(cancelBroadcast(rt2, id)).rejects.toThrow(/already cancelled/);
  });

  it("is driven end to end by the server's scheduler and the REST API", async () => {
    const dir = await project();
    const s = await serve(dir);
    const aud = (await api(s.url, "/api/audiences", { method: "POST", body: { name: "API list" } })).json.audience;
    const added = await api(s.url, `/api/audiences/${aud.id}/contacts`, { method: "POST", body: { contacts: [{ email: "x@example.org", variables: { userName: "X" } }, { email: "y@example.org", variables: { userName: "Y" } }, { email: "bad" }] } });
    expect(added.json).toMatchObject({ added: 2, total: 2 });
    expect(added.json.rejected).toHaveLength(1);
    expect((await api(s.url, "/api/broadcasts", { method: "POST", body: { name: "n", audienceId: aud.id, templateId: "missing" } })).status).toBe(404);
    const created = await api(s.url, "/api/broadcasts", { method: "POST", body: { name: "Now", audienceId: aud.id, templateId: OTP, variables: base, ratePerMinute: 6000 } });
    expect(created.status).toBe(201);
    let status = "";
    for (let i = 0; i < 40 && status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      status = (await api(s.url, `/api/broadcasts/${created.json.broadcast.id}`)).json.status;
    }
    expect(status).toBe("completed");
    expect((await api(s.url, `/api/broadcasts/${created.json.broadcast.id}`)).json.counts).toMatchObject({ delivered: 2 });
    expect((await api(s.url, `/api/audiences/${aud.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await readSuppressions(await loadProject(dir))).length).toBe(0);
  });

  it("works from the CLI: audience import and broadcast run", async () => {
    const dir = await project();
    const csv = join(dir, "people.csv");
    await writeFile(csv, "email,name,userName\nann@example.org,Ann,Ann\nbob@example.org,Bob,Bob\n");
    const c1 = capture();
    expect(await run(["audience", "create", "CLI list", "--dir", dir, "--json"], c1.io)).toBe(0);
    const id = JSON.parse(c1.out.join("")).id as string;
    expect(await run(["audience", "import", id, csv, "--dir", dir], capture().io)).toBe(0);
    expect(await run(["broadcast", "create", "Hello", "--audience", id, "--template", OTP, "--rate", "6000", "--var", "otpCode=222222", "--var", "signInUrl=https://app.example.com/in", "--dir", dir], capture().io)).toBe(0);
    const c2 = capture();
    expect(await run(["broadcast", "run", "--dir", dir, "--json"], c2.io)).toBe(0);
    expect(JSON.parse(c2.out.join("").slice(c2.out.join("").lastIndexOf("[\n")))[0].counts).toMatchObject({ delivered: 2 });
    expect(await run(["webhook", "add", "app", "--url", "https://app.example.com/hooks", "--secret-env", "SEALPOST_X", "--events", "email.*", "--dir", dir], capture().io)).toBe(0);
    expect((await loadProject(dir)).config.webhooks[0]).toMatchObject({ id: "app", events: ["email.*"] });
    expect(await run(["webhook", "add", "bad", "--url", "https://x.io", "--secret-env", "X", "--events", "nonsense", "--dir", dir], capture().io)).toBe(1);
  });
});

describe("doctor and auth-check", () => {
  const dnsFor = (rt: Awaited<ReturnType<typeof openRuntime>>) => async (name: string): Promise<string[][]> => {
    const { synthesizeDnsRecords } = await import("@sealpost/core");
    const { dkimFor } = await import("../src/runtime");
    const d = rt.project.config.domain;
    const rec = synthesizeDnsRecords(d, (await dkimFor(rt, d)).publicKeySpkiBase64).find((r) => r.fqdn === name);
    if (!rec) throw new Error("NXDOMAIN");
    return [[rec.value.slice(0, 100), rec.value.slice(100)]];
  };

  it("passes a correctly configured install and sends nothing while probing", async () => {
    const { runDoctor, defaultProbe } = await import("../src/doctor");
    const relay = await startSmtpSink({ auth: { username: "u", password: "p" } });
    closers.push(() => relay.close());
    const dir = await project((cfg) => {
      cfg.transport = "smtp";
      cfg.allowPrivateNetworks = true;
      cfg.mailboxes = [{ id: "main", label: "Main", host: "127.0.0.1", port: relay.port, security: "none", username: "u", passwordEnv: "SEALPOST_DOCTOR_PW" }, { id: "backup", label: "Backup", host: "127.0.0.1", port: relay.port, security: "none" }];
      cfg.domain.spfInclude = "relay.test";
      cfg.domain.dmarcPolicy = "quarantine";
      cfg.domain.trackingBaseUrl = "https://mail.example.com";
      cfg.domain.unsubscribeUrl = "https://example.com/unsub";
    });
    const rt = await openRuntime(await loadProject(dir));
    const spf = async (n: string): Promise<string[][]> => (n === "mail.example.com" ? [["v=spf1 include:relay.test ~all"]] : n === "_dmarc.mail.example.com" ? [["v=DMARC1; p=quarantine"]] : dnsFor(rt)(n));
    const checks = await runDoctor(rt, { resolveTxt: spf, probe: defaultProbe, env: { SEALPOST_DOCTOR_PW: "p" } });
    expect(checks.filter((c) => c.status === "fail"), JSON.stringify(checks.filter((c) => c.status === "fail"))).toEqual([]);
    expect(checks.find((c) => c.id === "mailbox:main")?.title).toMatch(/accepts the login/);
    expect(checks.find((c) => c.id === "mailbox:backup")?.status).toBe("pass");
    expect(relay.messages()).toHaveLength(0);
  });

  it("reports every blocking problem with a fix", async () => {
    const { runDoctor } = await import("../src/doctor");
    const dir = await project((cfg) => {
      cfg.transport = "smtp";
      cfg.mailboxes = [{ id: "main", label: "Main", host: "127.0.0.1", port: 1, security: "starttls", username: "u", passwordEnv: "SEALPOST_DOCTOR_PW" }, { id: "nopw", label: "No pw", host: "relay.test", port: 587, security: "starttls", username: "u", passwordEnv: "SEALPOST_MISSING" }];
      cfg.domain.trackingBaseUrl = "http://127.0.0.1:4320";
      delete cfg.domain.unsubscribeUrl;
      cfg.webhooks = [{ id: "app", url: "https://app.example.com/h", events: ["*"], secretEnv: "SEALPOST_NOHOOK" }];
    });
    const rt = await openRuntime(await loadProject(dir));
    const checks = await runDoctor(rt, { resolveTxt: async () => { throw new Error("NXDOMAIN"); }, probe: async () => ({ ok: false, detail: "ECONNREFUSED" }), env: { SEALPOST_DOCTOR_PW: "p" } });
    const fails = checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(fails).toEqual(expect.arrayContaining(["mailbox:main", "mailbox:nopw", "dns:mail.example.com:SPF", "dns:mail.example.com:DKIM", "dns:mail.example.com:DMARC", "webhook:app"]));
    expect(checks.every((c) => c.status !== "fail" || (c.fix ?? "").length > 0 || c.id.startsWith("mailbox:main"))).toBe(true);
    expect(checks.map((c) => c.id + ":" + c.status), "ids").toContain("tracking:mail.example.com:warn");
    expect(checks.find((c) => c.id === "unsub:mail.example.com")?.status).toBe("warn");
  });

  it("warns that the sink transport never leaves the machine and exits 2 only on failures", async () => {
    const dir = await project();
    const sinkRun = capture();
    expect(await run(["doctor", "--dir", dir, "--json"], sinkRun.io)).toBe(2); // DNS for the example domain does not exist
    const report = JSON.parse(sinkRun.out.join(""));
    expect(report.checks.find((c: any) => c.id === "transport").status).toBe("warn");
    expect(report.failed).toBeGreaterThan(0);
  });

  it("auth-check reads a downloaded original and exits 2 when anything failed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sealpost-auth-"));
    const good = join(dir, "good.eml");
    const bad = join(dir, "bad.eml");
    const msg = (ar: string): string => `Authentication-Results: mx.google.com; ${ar}\nDKIM-Signature: v=1; d=mail.example.com; s=sealpost; b=x\nFrom: Acme <hello@mail.example.com>\n\nhi`;
    await writeFile(good, msg("dkim=pass header.i=@mail.example.com; spf=pass smtp.mailfrom=a@relay.test; dmarc=pass header.from=mail.example.com"));
    await writeFile(bad, msg("dkim=fail; spf=pass; dmarc=fail"));
    expect(await run(["auth-check", good], capture().io)).toBe(0);
    const c = capture();
    expect(await run(["auth-check", bad], c.io)).toBe(2);
    expect(c.out.join("\n")).toMatch(/Not fully authenticated/);
    expect(await run(["auth-check"], capture().io)).toBe(1);
  });
});
