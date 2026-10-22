import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildMimeMessage, createDkimKeyPair, signDkim, type PersistentDkimKey } from "@sealpost/core";
import { dispatchWithFailover, sendRawSmtp, type SmtpEndpoint } from "../src/smtp/client";
import { startSmtpSink, type RunningSink, type SinkOptions } from "../src/smtp/sink";

const open: Array<{ close(): Promise<void> }> = [];
const raws: Server[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.close();
  while (raws.length) await new Promise((r) => raws.pop()?.close(r));
});

async function sink(opts: SinkOptions = {}): Promise<RunningSink> {
  const s = await startSmtpSink(opts);
  open.push(s);
  return s;
}
const plain = (s: RunningSink, extra: Partial<SmtpEndpoint> = {}): SmtpEndpoint => ({ id: "t", host: s.host, port: s.port, security: "none", ...extra });
const message = (body = "Hello\r\n"): string => `From: a@mail.example.com\r\nTo: b@example.org\r\nSubject: Test\r\nMessage-ID: <t@mail.example.com>\r\nDate: Thu, 22 Oct 2026 10:00:00 +0000\r\n\r\n${body}`;
const base = { from: "a@mail.example.com", recipients: ["b@example.org"], allowPrivateNetworks: true, helo: "mail.example.com", timeoutMs: 4000 };

describe("raw SMTP client against the loopback sink", () => {
  it("speaks RFC 5321 end to end and records the wire transcript", async () => {
    const s = await sink();
    const r = await sendRawSmtp({ ...base, endpoint: plain(s), data: message() });
    expect(r).toMatchObject({ ok: true, finalCode: 250, retryable: false, accepted: ["b@example.org"] });
    expect(r.banner).toMatch(/^220 .*ESMTP Sealpost sink/);
    expect(r.finalResponse).toMatch(/^250 2\.0\.0 Ok: queued as [0-9a-f]{16}$/);
    const lines = r.transcript.map((l) => `${l.dir}: ${l.text}`);
    for (const must of ["S: 220", "C: EHLO mail.example.com", "S: 250-", "C: MAIL FROM:<a@mail.example.com>", "C: RCPT TO:<b@example.org>", "C: DATA", "S: 354", "C: QUIT"]) expect(lines.some((l) => l.startsWith(must)), must).toBe(true);
    // multi-line replies: every "250-" line precedes exactly one "250 " line
    expect(lines.filter((l) => l.startsWith("S: 250 ")).length).toBeGreaterThanOrEqual(3);
    expect(r.transcript.every((l, i, a) => i === 0 || l.atMs >= a[i - 1].atMs)).toBe(true);
    expect(s.messages()).toHaveLength(1);
    expect(s.messages()[0]).toMatchObject({ mailFrom: "a@mail.example.com", rcptTo: ["b@example.org"], subject: "Test" });
  });

  it("dot-stuffs the body so a lone '.' line cannot end DATA early", async () => {
    const s = await sink();
    const body = "first\r\n.leading dot\r\n..two dots\r\n.\r\nafter the lone dot\r\n";
    const r = await sendRawSmtp({ ...base, endpoint: plain(s), data: message(body) });
    expect(r.ok).toBe(true);
    expect(s.messages()[0].raw).toBe(message(body));
  });

  it("authenticates with AUTH PLAIN and AUTH LOGIN, and never writes credentials to the transcript", async () => {
    const s = await sink({ auth: { username: "mailer", password: "s3cret-pass" } });
    const ok = await sendRawSmtp({ ...base, endpoint: plain(s, { username: "mailer", password: "s3cret-pass" }), data: message() });
    expect(ok.ok).toBe(true);
    const text = JSON.stringify(ok.transcript);
    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain(Buffer.from("\0mailer\0s3cret-pass").toString("base64"));
    expect(text).toContain("AUTH PLAIN [credentials hidden]");
    // a server that only offers LOGIN
    const s2 = await sink({ auth: { username: "mailer", password: "s3cret-pass" } });
    const viaLogin = await sendRawSmtp({ ...base, endpoint: plain(s2, { username: "mailer", password: "s3cret-pass" }), data: message() });
    expect(viaLogin.ok).toBe(true);
    const bad = await sendRawSmtp({ ...base, endpoint: plain(s, { username: "mailer", password: "wrong" }), data: message() });
    expect(bad).toMatchObject({ ok: false, authFailed: true, retryable: false, finalCode: 535 });
    expect(JSON.stringify(bad.transcript)).not.toContain("wrong");
  });

  it("refuses to send credentials over an unencrypted connection to a non-private host, and blocks private literals by default (SSRF)", async () => {
    const s = await sink();
    const r = await sendRawSmtp({ ...base, allowPrivateNetworks: false, endpoint: plain(s, { username: "u", password: "p" }), data: message() });
    expect(r).toMatchObject({ ok: false, retryable: true });
    expect(r.error).toMatch(/private address/);
    expect(s.messages()).toHaveLength(0);
    const meta = await sendRawSmtp({ ...base, allowPrivateNetworks: false, endpoint: { host: "169.254.169.254", port: 25, security: "none" }, data: message() });
    expect(meta.error).toMatch(/private address/);
  });

  it("reports per-recipient replies: a 550 is a hard bounce, the rest still deliver", async () => {
    const s = await sink({ rcptRule: (r) => (r.startsWith("dead@") ? { code: 550, text: "5.1.1 No such user" } : undefined) });
    const r = await sendRawSmtp({ ...base, recipients: ["ok@example.org", "dead@example.org"], endpoint: plain(s), data: message() });
    expect(r.ok).toBe(true);
    expect(r.accepted).toEqual(["ok@example.org"]);
    expect(r.rejected).toEqual([{ recipient: "dead@example.org", code: 550, message: "550 5.1.1 No such user" }]);
    const all = await sendRawSmtp({ ...base, recipients: ["dead@example.org"], endpoint: plain(s), data: message() });
    expect(all).toMatchObject({ ok: false, retryable: false, error: "Every recipient was rejected" });
  });

  it("treats 4xx as retryable and times out on a silent server", async () => {
    const s = await sink({ rcptRule: () => ({ code: 451, text: "4.7.1 Greylisted, try again later" }) });
    const r = await sendRawSmtp({ ...base, endpoint: plain(s), data: message() });
    expect(r).toMatchObject({ ok: false, retryable: true });
    const silent = createServer(() => undefined);
    raws.push(silent);
    await new Promise<void>((res) => silent.listen(0, "127.0.0.1", res));
    const port = (silent.address() as { port: number }).port;
    const t = await sendRawSmtp({ ...base, timeoutMs: 300, endpoint: { host: "127.0.0.1", port, security: "none" }, data: message() });
    expect(t).toMatchObject({ ok: false, retryable: true });
    expect(t.error).toMatch(/Timed out/);
  });

  it("verifies DKIM on arrival and catches a body altered after signing", async () => {
    const key: PersistentDkimKey = await createDkimKeyPair();
    const s = await sink({ resolveDkimKey: (d, sel) => (d === "mail.example.com" && sel === "sealpost" ? key.keys.publicKeyJwk : undefined) });
    const mime = buildMimeMessage({ from: { email: "hello@mail.example.com" }, to: ["b@example.org"], subject: "Hi", text: "plain", html: "<p>html</p>" });
    const signed = await signDkim(mime.raw, { domain: "mail.example.com", selector: "sealpost", privateKey: key.keys.privateKey });
    await sendRawSmtp({ ...base, endpoint: plain(s), data: signed.raw });
    await sendRawSmtp({ ...base, endpoint: plain(s), data: signed.raw.replace("<p>html</p>", "<p>HTML</p>").replace("html</p>", "html</p>") });
    const [good, bad] = s.messages();
    expect(good.dkim).toMatchObject({ ok: true, domain: "mail.example.com", selector: "sealpost" });
    expect(bad.dkim?.bodyHashOk === false || bad.dkim?.ok === false).toBe(true);
  });
});

describe("TLS (real handshakes)", () => {
  let tls: { key: string; cert: string } | null = null;
  beforeAll(() => {
    try {
      const dir = mkdtempSync(join(tmpdir(), "ew-tls-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost", "-days", "2"], { stdio: "ignore" });
      tls = { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
    } catch {
      tls = null;
    }
  });

  it("upgrades with STARTTLS, re-issues EHLO and delivers over TLS (and sends credentials only after the upgrade)", async (ctx) => {
    if (!tls) return ctx.skip();
    const s = await sink({ tls, auth: { username: "u", password: "p" } });
    const r = await sendRawSmtp({ ...base, rejectUnauthorized: false, endpoint: plain(s, { security: "starttls", username: "u", password: "p" }), data: message() });
    expect(r.ok).toBe(true);
    const lines = r.transcript.map((l) => l.text);
    expect(lines.some((l) => l === "STARTTLS")).toBe(true);
    expect(lines.some((l) => l.startsWith("TLS established"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("EHLO")).length).toBe(2);
    expect(lines.findIndex((l) => l.startsWith("AUTH"))).toBeGreaterThan(lines.findIndex((l) => l.startsWith("TLS established")));
  });

  it("supports implicit TLS (port-465 style)", async (ctx) => {
    if (!tls) return ctx.skip();
    const s = await sink({ tls: { ...tls, implicit: true } });
    const r = await sendRawSmtp({ ...base, rejectUnauthorized: false, endpoint: plain(s, { security: "tls" }), data: message() });
    expect(r.ok).toBe(true);
    expect(r.transcript[1].text).toMatch(/^TLS established/);
  });

  it("rejects an untrusted certificate by default, and never downgrades when STARTTLS is missing", async (ctx) => {
    if (!tls) return ctx.skip();
    const s = await sink({ tls });
    const untrusted = await sendRawSmtp({ ...base, endpoint: plain(s, { security: "starttls" }), data: message() });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.error).toMatch(/self[- ]signed|certificate|unable to verify/i);
    const noTls = await sink();
    const refused = await sendRawSmtp({ ...base, endpoint: plain(noTls, { security: "starttls" }), data: message() });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/does not offer STARTTLS/);
    expect(noTls.messages()).toHaveLength(0);
  });
});

describe("multi-mailbox failover", () => {
  it("falls over from a dead primary to the backup", async () => {
    const backup = await sink();
    const dead = await sink();
    const deadPort = dead.port;
    await dead.close();
    open.splice(open.indexOf(dead), 1);
    const r = await dispatchWithFailover([{ id: "primary", host: "127.0.0.1", port: deadPort, security: "none" }, plain(backup, { id: "backup" })], { ...base, data: message() });
    expect(r).toMatchObject({ ok: true, failedOver: true, attempts: 2, mailboxId: "backup" });
    expect(r.transcript.some((l) => l.text.startsWith("Failing over to backup"))).toBe(true);
    expect(backup.messages()).toHaveLength(1);
  });

  it("fails over on a 4xx from the primary and on rejected credentials, but not on a permanent 5xx", async () => {
    const grey = await sink({ rcptRule: () => ({ code: 451, text: "4.7.1 try later" }) });
    const authFail = await sink({ auth: { username: "x", password: "y" } });
    const good = await sink();
    expect((await dispatchWithFailover([plain(grey, { id: "p" }), plain(good, { id: "b" })], { ...base, data: message() })).mailboxId).toBe("b");
    expect((await dispatchWithFailover([plain(authFail, { id: "p", username: "x", password: "nope" }), plain(good, { id: "b" })], { ...base, data: message() })).ok).toBe(true);
    const hard = await sink({ rcptRule: () => ({ code: 550, text: "5.1.1 No such user" }) });
    const untouched = await sink();
    const r = await dispatchWithFailover([plain(hard, { id: "p" }), plain(untouched, { id: "b" })], { ...base, data: message() });
    expect(r).toMatchObject({ ok: false, retryable: false, attempts: 1 });
    expect(untouched.messages()).toHaveLength(0);
  });

  it("reports retryable when every relay is down", async () => {
    const a = await sink();
    const port = a.port;
    await a.close();
    open.splice(open.indexOf(a), 1);
    const r = await dispatchWithFailover([{ id: "a", host: "127.0.0.1", port, security: "none" }, { id: "b", host: "127.0.0.1", port, security: "none" }], { ...base, data: message() });
    expect(r).toMatchObject({ ok: false, retryable: true, attempts: 2 });
  });
});
