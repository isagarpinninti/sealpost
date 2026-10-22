/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSuppression } from "@sealpost/core";
import { loadProject, run, startServer, type RunningServer } from "../src";
import { readLedger } from "../src/ledger";
import { writeSuppressions } from "../src/store";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-sub-"));
  expect(await run(["init", dir, "--name", "s", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  cfg.submission = { ...cfg.submission, enabled: true, port: 0 };
  patch(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
async function serve(dir: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0, apiKey: "master-key" });
  closers.push(() => s.close());
  return s;
}
async function smtp(port: number, steps: Array<string | Buffer>): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let out = "";
    s.setEncoding("latin1");
    s.on("data", (d: string) => (out += d));
    s.on("error", reject);
    s.on("close", () => resolve(out));
    s.on("connect", async () => {
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, 25));
        s.write(step);
      }
      await new Promise((r) => setTimeout(r, 200));
      s.end();
    });
  });
}
const plain = (pass: string): string => `AUTH PLAIN ${Buffer.from(`\0sealpost\0${pass}`).toString("base64")}\r\n`;
const mail = (extra = "", from = "App <hello@mail.example.com>"): string => `From: ${from}\r\nTo: user@example.org\r\nBcc: hidden@example.org\r\nSubject: Receipt #1\r\nMessage-ID: <app-1@client.test>\r\n${extra}\r\nThanks for your order.\r\n.\r\n`;
const session = (pass: string, rcpt: string[], body: string, from = "hello@mail.example.com"): string[] => ["EHLO app.test\r\n", plain(pass), `MAIL FROM:<${from}>\r\n`, ...rcpt.map((r) => `RCPT TO:<${r}>\r\n`), "DATA\r\n", body, "QUIT\r\n"];
const inbox = async (s: RunningServer): Promise<any[]> => ((await (await fetch(`${s.url}/api/inbox`, { headers: { authorization: "Bearer master-key" } })).json()) as any).messages;

describe("SMTP submission", () => {
  it("requires authentication with an API key that may send", async () => {
    const dir = await project();
    const s = await serve(dir);
    const port = s.submissionPort ?? 0;
    expect(port).toBeGreaterThan(0);
    const anon = await smtp(port, ["EHLO x\r\n", "MAIL FROM:<hello@mail.example.com>\r\n", "QUIT\r\n"]);
    expect(anon).toContain("250-AUTH PLAIN LOGIN");
    expect(anon).toContain("530 5.7.0 Authentication required");
    expect(await smtp(port, ["EHLO x\r\n", plain("wrong"), "QUIT\r\n"])).toContain("535 5.7.8");
    const login = await smtp(port, ["EHLO x\r\n", "AUTH LOGIN\r\n", `${Buffer.from("anyone").toString("base64")}\r\n`, `${Buffer.from("master-key").toString("base64")}\r\n`, "QUIT\r\n"]);
    expect(login).toContain("235 2.7.0 Authentication successful");

    const readOnly = (await (await fetch(`${s.url}/api/keys`, { method: "POST", headers: { authorization: "Bearer master-key", "content-type": "application/json" }, body: JSON.stringify({ label: "ro", scopes: ["read"] }) })).json()) as any;
    expect(await smtp(port, ["EHLO x\r\n", plain(readOnly.key), "QUIT\r\n"])).toContain("535 5.7.8");
    const sender = (await (await fetch(`${s.url}/api/keys`, { method: "POST", headers: { authorization: "Bearer master-key", "content-type": "application/json" }, body: JSON.stringify({ label: "app", scopes: ["send"] }) })).json()) as any;
    expect(await smtp(port, ["EHLO x\r\n", plain(sender.key), "QUIT\r\n"])).toContain("235");
  });

  it("signs, delivers and records a submitted message like any other send", async () => {
    const dir = await project();
    const s = await serve(dir);
    const out = await smtp(s.submissionPort ?? 0, session("master-key", ["user@example.org", "hidden@example.org"], mail()));
    expect(out).toMatch(/250 2\.0\.0 Ok: queued as/);
    const box = await inbox(s);
    expect(box).toHaveLength(1);
    expect(box[0].rcptTo.sort()).toEqual(["hidden@example.org", "user@example.org"]);
    expect(box[0].dkim).toMatchObject({ ok: true, domain: "mail.example.com", selector: "sealpost" });
    const raw = ((await (await fetch(`${s.url}/api/inbox/${box[0].id}`, { headers: { authorization: "Bearer master-key" } })).json()) as any).raw as string;
    expect(raw).toContain("Message-ID: <app-1@client.test>");
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(raw).not.toMatch(/^Received:/im);
    expect(raw).toMatch(/^Date: /m);
    expect(raw).toContain("Thanks for your order.");

    const emails = ((await (await fetch(`${s.url}/api/emails`, { headers: { authorization: "Bearer master-key" } })).json()) as any).data;
    expect(emails[0]).toMatchObject({ status: "delivered", from: "hello@mail.example.com", subject: "Receipt #1", templateId: "smtp-submission", tags: [{ name: "source", value: "smtp-submission" }] });
    expect(emails[0].bcc).toEqual(["hidden@example.org"]);
    expect(await readLedger((await loadProject(dir)).paths.ledger)).toHaveLength(1);
  });

  it("adds a Message-ID when missing and does not send a client retry twice", async () => {
    const s = await serve(await project());
    const body = "From: hello@mail.example.com\r\nTo: user@example.org\r\nSubject: No id\r\n\r\nhi\r\n.\r\n";
    await smtp(s.submissionPort ?? 0, session("master-key", ["user@example.org"], body));
    expect(((await inbox(s))[0] as any).messageId).toMatch(/^<[\w.-]+@mail\.example\.com>$/);
    await smtp(s.submissionPort ?? 0, session("master-key", ["user@example.org"], mail()));
    const again = await smtp(s.submissionPort ?? 0, session("master-key", ["user@example.org"], mail()));
    expect(again).toMatch(/250 2\.0\.0 Ok: queued/);
    expect(await inbox(s)).toHaveLength(2); // the second submission of <app-1@client.test> was recognised
  });

  it("refuses foreign sender domains, suppressed recipients and non-UTF-8 bodies", async () => {
    const dir = await project();
    const s = await serve(dir);
    const port = s.submissionPort ?? 0;
    const foreign = await smtp(port, session("master-key", ["user@example.org"], mail("", "Spoof <ceo@bank.example>")));
    expect(foreign).toContain("550 5.7.1 The sender domain bank.example is not configured");
    await writeSuppressions(await loadProject(dir), addSuppression([], { email: "gone@example.org", reason: "hard_bounce", atIso: new Date().toISOString() }));
    const sup = await smtp(port, ["EHLO x\r\n", plain("master-key"), "MAIL FROM:<hello@mail.example.com>\r\n", "RCPT TO:<gone@example.org>\r\n", "QUIT\r\n"]);
    expect(sup).toContain("550 5.7.1 Recipient is on the suppression list");
    const latin1 = Buffer.concat([Buffer.from("From: hello@mail.example.com\r\nTo: u@example.org\r\nSubject: x\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf"), Buffer.from([0xe9]), Buffer.from("\r\n.\r\n")]);
    const bad = await smtp(port, ["EHLO x\r\n", plain("master-key"), "MAIL FROM:<hello@mail.example.com>\r\n", "RCPT TO:<u@example.org>\r\n", "DATA\r\n", latin1, "QUIT\r\n"]);
    expect(bad).toContain("554 5.6.0 The message must be UTF-8");
    expect(await inbox(s)).toHaveLength(0);
  });

  it("will not start on a public address without TLS, or without any API key", async () => {
    await expect(startServer({ dir: await project((cfg) => { cfg.submission.host = "0.0.0.0"; }), port: 0, apiKey: "k" })).rejects.toThrow(/needs submission\.tls/);
    await expect(startServer({ dir: await project(), port: 0, apiKey: "" })).rejects.toThrow(/needs an API key/);
  });

  it("interoperates with Python's smtplib (a real third-party client)", async (ctx) => {
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore" });
    } catch {
      return ctx.skip();
    }
    const s = await serve(await project());
    const script = `import smtplib, sys\nfrom email.message import EmailMessage\nm=EmailMessage(); m['From']='Shop <hello@mail.example.com>'; m['To']='buyer@example.org'; m['Subject']='Your receipt \u2014 \u20ac49'; m.set_content('Total: \u20ac49.00'); m.add_alternative('<p>Total <b>\u20ac49.00</b></p>', subtype='html')\nwith smtplib.SMTP('127.0.0.1', int(sys.argv[1])) as c:\n    c.login('app', 'master-key'); c.send_message(m)\nprint('SENT')`;
    // Asynchronous on purpose: the server lives in this process, so a blocking call would deadlock it.
    expect((await promisify(execFile)("python3", ["-c", script, String(s.submissionPort)])).stdout).toContain("SENT");
    const box = await inbox(s);
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ subject: expect.stringContaining("receipt"), dkim: { ok: true } });
  });
});
