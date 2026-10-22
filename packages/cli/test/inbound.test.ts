/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { execFileSync } from "node:child_process";
import { createServer as createHttp } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { run, startServer, openRuntime, loadProject, sendEmail, type RunningServer } from "../src";
import { ingestInbound } from "../src/inbound/ingest";
import { startInboundSmtp, type InboundEnvelope, type RunningInboundSmtp } from "../src/inbound/smtp";
import { extractRawMessage } from "../src/inbound/webhook";
import { listInboundAll, pruneInbound, readInboundRaw } from "../src/inbound/store";
import { readSuppressions } from "../src/store";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-in-"));
  expect(await run(["init", dir, "--name", "in", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  cfg.inbound = { ...cfg.inbound, enabled: true, host: "127.0.0.1", port: 0 };
  patch(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
async function serve(dir: string, o: { apiKey?: string; webhookSecret?: string } = {}): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0, ...o });
  closers.push(() => s.close());
  return s;
}
async function api(base: string, path: string, o: { method?: string; body?: unknown; token?: string; raw?: Buffer | string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers; bytes: Buffer }> {
  const res = await fetch(`${base}${path}`, { method: o.method ?? "GET", headers: { ...(o.raw === undefined && o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers }, body: typeof o.raw === "string" ? o.raw : o.raw ? new Uint8Array(o.raw) : o.body === undefined ? undefined : JSON.stringify(o.body) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    /* binary body */
  }
  return { status: res.status, json, headers: res.headers, bytes };
}

/** A minimal SMTP client that speaks raw bytes, so tests control exactly what crosses the wire. */
async function smtp(port: number, steps: Array<string | Buffer | { wait: number }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    let out = "";
    s.setEncoding("latin1");
    s.on("data", (d: string) => (out += d));
    s.on("error", reject);
    s.on("close", () => resolve(out));
    s.on("connect", async () => {
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, typeof step === "object" && "wait" in step ? step.wait : 25));
        if (typeof step === "string" || Buffer.isBuffer(step)) s.write(step);
      }
      await new Promise((r) => setTimeout(r, 120));
      s.end();
    });
  });
}
const envelope = (to: string, from = "sender@remote.test"): string[] => ["EHLO remote.test\r\n", `MAIL FROM:<${from}>\r\n`, `RCPT TO:<${to}>\r\n`, "DATA\r\n"];
const simpleMail = (extra = ""): string => `From: Remote <sender@remote.test>\r\nTo: hello@mail.example.com\r\nSubject: hi\r\nMessage-ID: <r1@remote.test>\r\n${extra}\r\nbody line\r\n`;

describe("the MX-facing SMTP receiver", () => {
  const start = async (o: Partial<Parameters<typeof startInboundSmtp>[0]> = {}): Promise<{ srv: RunningInboundSmtp; got: Array<{ raw: Buffer; env: InboundEnvelope }> }> => {
    const got: Array<{ raw: Buffer; env: InboundEnvelope }> = [];
    const srv = await startInboundSmtp({ host: "127.0.0.1", port: 0, hostname: "mx.test", maxMessageBytes: 20_000, acceptRecipient: (a) => (a.endsWith("@mail.example.com") ? true : { code: 550, text: "5.7.1 Relay access denied" }), onMessage: async (raw, env) => void got.push({ raw, env }), ...o });
    closers.push(() => srv.close());
    return { srv, got };
  };

  it("accepts mail for its domains, adds a Received header, and unstuffs dots", async () => {
    const { srv, got } = await start();
    const out = await smtp(srv.port, [...envelope("hello@mail.example.com"), `${simpleMail()}..leading dot\r\n.\r\n`, "QUIT\r\n"]);
    expect(out).toMatch(/^220 mx.test ESMTP/);
    expect(out).toMatch(/250 2\.0\.0 Ok: queued as [0-9a-f]{12}/);
    expect(got).toHaveLength(1);
    const text = got[0].raw.toString("latin1");
    expect(text).toMatch(/^Received: from remote\.test \(\[127\.0\.0\.1\]\)\r\n\tby mx\.test with ESMTP id [0-9a-f]{12};/);
    expect(text).toContain("body line\r\n.leading dot\r\n");
    expect(got[0].env).toMatchObject({ from: "sender@remote.test", to: ["hello@mail.example.com"], remoteAddress: "127.0.0.1", helo: "remote.test", secure: false });
  });

  it("refuses to relay: recipients outside its domains get 550 and nothing is delivered", async () => {
    const { srv, got } = await start();
    const out = await smtp(srv.port, ["EHLO x\r\n", "MAIL FROM:<a@remote.test>\r\n", "RCPT TO:<victim@gmail.com>\r\n", "DATA\r\n", "QUIT\r\n"]);
    expect(out).toContain("550 5.7.1 Relay access denied");
    expect(out).toContain("503 5.5.1 Need MAIL and RCPT before DATA");
    expect(got).toHaveLength(0);
  });

  it("preserves 8-bit bytes exactly and finds a terminator split across packets", async () => {
    const { srv, got } = await start();
    const body = Buffer.concat([Buffer.from(`Subject: bytes\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf`), Buffer.from([0xe9, 0x80, 0xff, 0x00, 0x7f]), Buffer.from("\r\n")]);
    await smtp(srv.port, [...envelope("hello@mail.example.com"), body, "\r\n.", { wait: 60 }, "\r\n", "QUIT\r\n"]);
    expect(got).toHaveLength(1);
    expect(got[0].raw.subarray(got[0].raw.length - 9).toString("hex")).toBe(Buffer.from([0xe9, 0x80, 0xff, 0x00, 0x7f, 0x0d, 0x0a, 0x0d, 0x0a]).toString("hex"));
  });

  it("handles an empty body, a null sender (bounces) and pipelined commands", async () => {
    const { srv, got } = await start();
    const out = await smtp(srv.port, ["EHLO x\r\nMAIL FROM:<>\r\nRCPT TO:<hello@mail.example.com>\r\nDATA\r\n", ".\r\n", "QUIT\r\n"]);
    expect(out).toContain("354");
    expect(got).toHaveLength(1);
    expect(got[0].env.from).toBe("");
    expect(got[0].raw.toString("latin1")).toMatch(/^Received: [^]*\r\n$/);
  });

  it("enforces size limits (declared and actual), recipient count and answers 451 when processing fails", async () => {
    const { srv, got } = await start({ maxRecipients: 2 });
    const declared = await smtp(srv.port, ["EHLO x\r\n", "MAIL FROM:<a@remote.test> SIZE=999999\r\n", "QUIT\r\n"]);
    expect(declared).toContain("552 5.3.4 Message size exceeds the limit");
    const big = await smtp(srv.port, [...envelope("hello@mail.example.com"), `Subject: big\r\n\r\n${"x".repeat(30_000)}\r\n.\r\n`, "QUIT\r\n"]);
    expect(big).toContain("552 5.3.4 Message too big");
    expect(got).toHaveLength(0);
    const many = await smtp(srv.port, ["EHLO x\r\n", "MAIL FROM:<a@remote.test>\r\n", "RCPT TO:<a@mail.example.com>\r\n", "RCPT TO:<b@mail.example.com>\r\n", "RCPT TO:<c@mail.example.com>\r\n", "QUIT\r\n"]);
    expect(many).toContain("452 4.5.3 Too many recipients");

    const failing = await start({ onMessage: async () => { throw new Error("disk full"); } });
    const out = await smtp(failing.srv.port, [...envelope("hello@mail.example.com"), `${simpleMail()}.\r\n`, "QUIT\r\n"]);
    expect(out).toContain("451 4.3.0");
  });

  it("closes after repeated protocol errors and limits connections per address", async () => {
    const { srv } = await start({ maxConnectionsPerIp: 2 });
    const junk = await smtp(srv.port, Array.from({ length: 12 }, () => "NONSENSE\r\n"));
    expect(junk).toContain("421 4.7.0 Too many errors");
    const open = [0, 1].map(() => connect({ host: "127.0.0.1", port: srv.port }));
    await new Promise((r) => setTimeout(r, 80));
    const third = await smtp(srv.port, []);
    expect(third).toContain("421 4.3.2 Too many connections");
    for (const s of open) s.destroy();
  });

  describe("STARTTLS", () => {
    let tls: { key: string; cert: string } | null = null;
    beforeAll(() => {
      try {
        const dir = mkdtempSync(join(tmpdir(), "sealpost-intls-"));
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost", "-days", "2"], { stdio: "ignore" });
        tls = { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
      } catch {
        tls = null;
      }
    });
    it("advertises and upgrades, and marks the message as received over TLS", async (ctx) => {
      if (!tls) return ctx.skip();
      const { srv, got } = await start({ tls });
      const { connect: tlsConnect } = await import("node:tls");
      const out = await new Promise<string>((resolve, reject) => {
        const plain = connect({ host: "127.0.0.1", port: srv.port });
        let buf = "";
        plain.setEncoding("latin1");
        plain.once("error", reject);
        plain.on("data", (d: string) => (buf += d));
        const wait = (n: number): Promise<void> => new Promise((r) => setTimeout(r, n));
        void (async () => {
          await wait(40);
          plain.write("EHLO x\r\n");
          await wait(40);
          plain.write("STARTTLS\r\n");
          await wait(60);
          const t = tlsConnect({ socket: plain, rejectUnauthorized: false, servername: "localhost" });
          let tbuf = "";
          t.setEncoding("latin1");
          t.on("data", (d: string) => (tbuf += d));
          t.once("secureConnect", async () => {
            for (const l of ["EHLO x\r\n", "MAIL FROM:<a@remote.test>\r\n", "RCPT TO:<hello@mail.example.com>\r\n", "DATA\r\n", `${simpleMail()}.\r\n`, "QUIT\r\n"]) {
              t.write(l);
              await wait(30);
            }
            await wait(80);
            resolve(`${buf}${tbuf}`);
            t.end();
          });
          t.once("error", reject);
        })();
      });
      expect(out).toContain("250-STARTTLS");
      expect(out).toContain("220 2.0.0 Ready to start TLS");
      expect(out).toMatch(/250 2\.0\.0 Ok: queued/);
      expect(got[0].env.secure).toBe(true);
      expect(got[0].raw.toString("latin1")).toContain("with ESMTPS");
    });
  });
});

describe("received mail through the server", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x1a, 0x0a]);
  const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const rich = (): string =>
    `From: "Ada" <ada@remote.test>\r\nTo: hello@mail.example.com\r\nSubject: =?UTF-8?B?SGVsbG8g8J+RiyBwbGFucw==?=\r\nMessage-ID: <in1@remote.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Type: multipart/alternative; boundary="A"\r\n\r\n--A\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlans attached.\r\n--A\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Plans <b>attached</b></p><script>alert(1)</script>\r\n--A--\r\n--B\r\nContent-Type: image/png; name="plan.png"\r\nContent-Disposition: attachment; filename="plan.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(png)}\r\n--B\r\nContent-Type: text/html; name="evil.html"\r\nContent-Disposition: attachment; filename="..\\\\evil.html"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64("<script>alert(1)</script>")}\r\n--B--\r\n`;

  it("stores a message over real SMTP and serves it, its raw bytes and attachments safely", async () => {
    const s = await serve(await project());
    expect(s.inboundPort).toBeGreaterThan(0);
    await smtp(s.inboundPort ?? 0, [...envelope("hello@mail.example.com"), `${rich()}.\r\n`, "QUIT\r\n"]);

    const list = (await api(s.url, "/api/inbound")).json;
    expect(list.data).toHaveLength(1);
    const item = list.data[0];
    expect(item).toMatchObject({ kind: "message", subject: "Hello 👋 plans", from: { name: "Ada", address: "ada@remote.test" }, source: "smtp", hasText: true, hasHtml: true, secure: false });
    expect(item.id).toMatch(/^in_[0-9a-f]{16}$/);
    expect(item.attachments.map((a: any) => [a.filename, a.contentType, a.size])).toEqual([["plan.png", "image/png", png.length], ["evil.html", "text/html", 25]]);
    expect(item.snippet).toBe("Plans attached.");

    const full = (await api(s.url, `/api/inbound/${item.id}`)).json;
    expect(full.text).toBe("Plans attached.");
    expect(full.html).toContain("<script>alert(1)</script>"); // returned as data; the Studio renders it in a locked-down sandbox
    expect(full.headers.some((h: any) => h.name === "Received")).toBe(true);

    const att = await api(s.url, `/api/inbound/${item.id}/attachments/0`);
    expect(Array.from(att.bytes)).toEqual(Array.from(png));
    expect(att.headers.get("content-type")).toBe("image/png");
    expect(att.headers.get("content-disposition")).toMatch(/^attachment; filename="plan\.png"; filename\*=UTF-8''plan\.png$/);
    expect(att.headers.get("x-content-type-options")).toBe("nosniff");
    expect(att.headers.get("content-security-policy")).toBe("sandbox");
    const evil = await api(s.url, `/api/inbound/${item.id}/attachments/1`);
    expect(evil.headers.get("content-type")).toBe("application/octet-stream"); // never served as a page
    expect(evil.headers.get("content-disposition")).toContain('filename="evil.html"');

    const raw = await api(s.url, `/api/inbound/${item.id}/raw`);
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(raw.bytes.toString("latin1")).toContain("Subject: =?UTF-8?B?");
    expect((await api(s.url, `/api/inbound/${item.id}/attachments/9`)).status).toBe(404);
    expect((await api(s.url, "/api/inbound/in_0000000000000000")).json.code).toBe("not_found");
  });

  it("lists with filters and cursor pagination, and deletes (admin only)", async () => {
    const dir = await project();
    const s = await serve(dir, { apiKey: "master" });
    for (let i = 0; i < 5; i++) await smtp(s.inboundPort ?? 0, [...envelope("hello@mail.example.com", `s${i}@remote.test`), `From: s${i}@remote.test\r\nSubject: topic ${i % 2 ? "odd" : "even"} ${i}\r\n\r\nbody\r\n.\r\n`, "QUIT\r\n"]);
    const t = "master";
    const p1 = (await api(s.url, "/api/inbound?limit=2", { token: t })).json;
    expect(p1.data.map((r: any) => r.subject)).toEqual(["topic even 4", "topic odd 3"]);
    expect(p1.hasMore).toBe(true);
    const p2 = (await api(s.url, `/api/inbound?limit=2&before=${p1.nextCursor}`, { token: t })).json;
    expect(p2.data.map((r: any) => r.subject)).toEqual(["topic even 2", "topic odd 1"]);
    expect((await api(s.url, "/api/inbound?q=ODD", { token: t })).json.data).toHaveLength(2);
    expect((await api(s.url, "/api/inbound?from=s3@", { token: t })).json.data).toHaveLength(1);
    expect((await api(s.url, "/api/inbound?kind=bounce", { token: t })).json.data).toHaveLength(0);
    expect((await api(s.url, "/api/inbound?kind=weird", { token: t })).status).toBe(400);
    expect((await api(s.url, "/api/inbound")).status).toBe(401);

    const id = p1.data[0].id;
    await run(["auth", "add-key", "ci", "--dir", dir], io);
    expect((await api(s.url, `/api/inbound/${id}`, { method: "DELETE", token: "not-admin" })).status).toBe(401);
    expect((await api(s.url, `/api/inbound/${id}`, { method: "DELETE", token: t })).status).toBe(200);
    expect((await api(s.url, `/api/inbound/${id}`, { token: t })).status).toBe(404);
  });

  it("refuses mail for domains that are not configured, and only starts when enabled", async () => {
    const s = await serve(await project());
    const out = await smtp(s.inboundPort ?? 0, ["EHLO x\r\n", "MAIL FROM:<a@remote.test>\r\n", "RCPT TO:<x@other.org>\r\n", "QUIT\r\n"]);
    expect(out).toContain("550 5.7.1 Relay access denied");
    expect((await api(s.url, "/api/inbound")).json.data).toHaveLength(0);
    const off = await serve(await project((cfg) => { cfg.inbound.enabled = false; }));
    expect(off.inboundPort).toBeNull();
  });

  it("only accepts the domains named in inbound.domains when set", async () => {
    const s = await serve(await project((cfg) => { cfg.inbound.domains = ["support.example.com"]; }));
    const out = await smtp(s.inboundPort ?? 0, ["EHLO x\r\n", "MAIL FROM:<a@remote.test>\r\n", "RCPT TO:<hello@mail.example.com>\r\n", "RCPT TO:<help@support.example.com>\r\n", "QUIT\r\n"]);
    expect(out).toContain("550 5.7.1");
    expect(out).toContain("250 2.1.5 Recipient ok");
  });
});

describe("threading, bounces and complaints", () => {
  const OTP = "magic_link_otp_verification";
  const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
  async function sent(s: RunningServer, to: string): Promise<{ id: string; messageId: string }> {
    const r = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to, variables: vars } });
    expect(r.status).toBe(201);
    return { id: r.json.id, messageId: r.json.messageId };
  }
  const dsn = (messageId: string, rcpt: string, status = "5.1.1", action = "failed"): string =>
    `From: MAILER-DAEMON@relay.example.net\r\nTo: hello@mail.example.com\r\nSubject: Undelivered Mail Returned to Sender\r\nAuto-Submitted: auto-replied\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="D"\r\n\r\n--D\r\nContent-Type: text/plain\r\n\r\nCould not deliver.\r\n--D\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; relay.example.net\r\n\r\nFinal-Recipient: rfc822; ${rcpt}\r\nAction: ${action}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\r\n--D\r\nContent-Type: message/rfc822\r\n\r\nMessage-ID: ${messageId}\r\nTo: ${rcpt}\r\nSubject: x\r\n\r\nbody\r\n--D--\r\n`;
  const deliver = (s: RunningServer, raw: string): Promise<string> => smtp(s.inboundPort ?? 0, [...envelope("hello@mail.example.com", ""), `${raw}.\r\n`, "QUIT\r\n"]);

  it("links a reply to the email it answers and adds it to that email's timeline", async () => {
    const s = await serve(await project());
    const out = await sent(s, "ada@example.org");
    await deliver(s, `From: Ada <ada@example.org>\r\nTo: hello@mail.example.com\r\nSubject: Re: 482913 is your Acme sign-in code\r\nMessage-ID: <reply1@example.org>\r\nIn-Reply-To: ${out.messageId}\r\nReferences: ${out.messageId}\r\n\r\nThanks, that worked.\r\n`);
    const rec = (await api(s.url, `/api/emails/${out.id}`)).json;
    expect(rec.replies).toBe(1);
    expect(rec.events.map((e: any) => e.type)).toEqual(["delivered", "replied"]);
    expect(rec.events[1].detail).toContain("ada@example.org");
    const inbound = (await api(s.url, "/api/inbound")).json.data[0];
    expect(inbound.threadEmailId).toBe(out.id);
    await deliver(s, "From: x@y.io\r\nSubject: unrelated\r\nIn-Reply-To: <someone-elses@other>\r\n\r\nhi\r\n");
    expect((await api(s.url, "/api/inbound")).json.data[0].threadEmailId).toBeUndefined();
  });

  it("acts on a verified bounce: suppresses the recipient and marks the email bounced", async () => {
    const dir = await project();
    const s = await serve(dir);
    const out = await sent(s, "gone@example.org");
    await deliver(s, dsn(out.messageId, "gone@example.org"));
    const rec = (await api(s.url, `/api/emails/${out.id}`)).json;
    expect(rec.status).toBe("bounced");
    expect(rec.events.at(-1)).toMatchObject({ type: "bounced" });
    expect(rec.events.at(-1).detail).toContain("gone@example.org");
    const sup = await readSuppressions(await loadProject(dir));
    expect(sup).toEqual([expect.objectContaining({ email: "gone@example.org", reason: "hard_bounce" })]);
    const inbound = (await api(s.url, "/api/inbound?kind=bounce")).json.data[0];
    expect(inbound).toMatchObject({ kind: "bounce", reportVerified: true, autoReply: false });
    expect(inbound.bounce.recipients[0]).toMatchObject({ email: "gone@example.org", status: "5.1.1", hard: true });
    const again = await api(s.url, "/api/send", { method: "POST", body: { templateId: OTP, to: "gone@example.org", variables: { ...vars, otpCode: "111111" } } });
    expect(again.status).toBe(403);
    expect(JSON.stringify(again.json.preflight.checks)).toContain("EW-107");
  });

  it("ignores forged reports: unknown Message-ID, or a recipient we never mailed", async () => {
    const dir = await project();
    const s = await serve(dir);
    const out = await sent(s, "real@example.org");
    await deliver(s, dsn("<invented@mail.example.com>", "victim@example.org"));
    await deliver(s, dsn(out.messageId, "victim@example.org"));
    expect(await readSuppressions(await loadProject(dir))).toEqual([]);
    const rec = (await api(s.url, `/api/emails/${out.id}`)).json;
    expect(rec.status).toBe("delivered");
    const reports = (await api(s.url, "/api/inbound?kind=bounce")).json.data;
    expect(reports).toHaveLength(2);
    expect(reports.every((r: any) => r.reportVerified !== true)).toBe(true);
  });

  it("treats a delayed (4.x) report as deferred, not a suppression", async () => {
    const dir = await project();
    const s = await serve(dir);
    const out = await sent(s, "slow@example.org");
    await deliver(s, dsn(out.messageId, "slow@example.org", "4.2.2", "delayed"));
    const rec = (await api(s.url, `/api/emails/${out.id}`)).json;
    expect(rec.status).toBe("deferred");
    expect(await readSuppressions(await loadProject(dir))).toEqual([]);
  });

  it("acts on a verified abuse report (ARF)", async () => {
    const dir = await project();
    const s = await serve(dir);
    const out = await sent(s, "angry@example.org");
    await deliver(s, `From: fbl@isp.test\r\nSubject: FW: Acme\r\nContent-Type: multipart/report; report-type=feedback-report; boundary="F"\r\n\r\n--F\r\nContent-Type: text/plain\r\n\r\ncomplaint\r\n--F\r\nContent-Type: message/feedback-report\r\n\r\nFeedback-Type: abuse\r\nOriginal-Rcpt-To: <angry@example.org>\r\n--F\r\nContent-Type: message/rfc822\r\n\r\nMessage-ID: ${out.messageId}\r\nTo: angry@example.org\r\n\r\nx\r\n--F--\r\n`);
    expect((await api(s.url, `/api/emails/${out.id}`)).json.status).toBe("complained");
    expect(await readSuppressions(await loadProject(dir))).toEqual([expect.objectContaining({ email: "angry@example.org", reason: "complaint" })]);
  });

  it("flags automatic replies without treating them as bounces", async () => {
    const s = await serve(await project());
    await deliver(s, "From: ooo@example.org\r\nSubject: Out of office\r\nAuto-Submitted: auto-replied\r\n\r\nBack Monday.\r\n");
    expect((await api(s.url, "/api/inbound")).json.data[0]).toMatchObject({ kind: "message", autoReply: true });
  });

  it("notifies your app with a signed email.received webhook", async () => {
    const hits: string[] = [];
    const hook = createHttp((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        hits.push(b);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => { hook.closeAllConnections(); hook.close(() => r()); }));
    process.env.SEALPOST_IN_WHSEC = "whsec";
    const s = await serve(await project((cfg) => {
      cfg.allowPrivateNetworks = true;
      cfg.webhooks = [{ id: "app", url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/h`, events: ["email.received"], secretEnv: "SEALPOST_IN_WHSEC" }];
    }));
    await deliver(s, "From: Ada <ada@example.org>\r\nSubject: Question\r\nContent-Type: text/plain\r\n\r\nCan you help?\r\n");
    for (let i = 0; i < 30 && hits.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const ev = JSON.parse(hits[0]);
    expect(ev).toMatchObject({ type: "email.received", data: { kind: "message", from: "ada@example.org", subject: "Question", snippet: "Can you help?", source: "smtp" } });
  });
});

describe("DKIM on received mail", () => {
  it("verifies a signed message against the published key, and fails a tampered one", async () => {
    const dir = await project();
    const rt = await openRuntime(await loadProject(dir));
    const out = await sendEmail(rt, { templateId: "magic_link_otp_verification", to: "x@example.org", variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" } });
    const raw = out.rawMime ?? "";
    expect(raw).toContain("DKIM-Signature:");
    const key = rt.dkim.publicKeySpkiBase64;
    rt.resolveTxt = async (name) => {
      if (name === "sealpost._domainkey.mail.example.com") return [[`v=DKIM1; k=rsa; p=${key.slice(0, 200)}`, key.slice(200)]];
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    const good = await ingestInbound(rt, Buffer.from(raw), { source: "import" });
    expect(good.dkim).toMatchObject({ result: "pass", domain: "mail.example.com", selector: "sealpost" });
    const bad = await ingestInbound(rt, Buffer.from(raw.replace("482913", "999999")), { source: "import" });
    expect(bad.dkim.result).toBe("fail");
    const unsigned = await ingestInbound(rt, Buffer.from("From: a@b.co\r\nSubject: x\r\n\r\nhi\r\n"), { source: "import" });
    expect(unsigned.dkim).toMatchObject({ result: "none", detail: "no DKIM-Signature" });
    rt.resolveTxt = async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); };
    expect((await ingestInbound(rt, Buffer.from(raw), { source: "import" })).dkim.result).toBe("none");
    rt.resolveTxt = async () => { throw new Error("SERVFAIL"); };
    expect((await ingestInbound(rt, Buffer.from(raw), { source: "import" })).dkim.result).toBe("temperror");
  });
});

describe("relay inbound webhooks and housekeeping", () => {
  const msg = "From: a@remote.test\r\nTo: hello@mail.example.com\r\nSubject: via webhook\r\n\r\nhello\r\n";

  it("extracts the message from SES/SNS, SendGrid, Mailgun, JSON and plain posts", () => {
    expect(extractRawMessage("message/rfc822", Buffer.from(msg))?.toString()).toBe(msg);
    expect(extractRawMessage("application/json", Buffer.from(JSON.stringify({ raw: msg })))?.toString()).toBe(msg);
    expect(extractRawMessage("application/json", Buffer.from(JSON.stringify({ rawBase64: Buffer.from(msg).toString("base64") })))?.toString()).toBe(msg);
    expect(extractRawMessage("application/json", Buffer.from(JSON.stringify({ Type: "Notification", Message: JSON.stringify({ content: msg }) })))?.toString()).toBe(msg);
    const form = (field: string): Buffer => Buffer.from(`--XX\r\nContent-Disposition: form-data; name="to"\r\n\r\nhello@mail.example.com\r\n--XX\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${msg}\r\n--XX--\r\n`);
    expect(extractRawMessage("multipart/form-data; boundary=XX", form("email"))?.toString()).toBe(msg);
    expect(extractRawMessage("multipart/form-data; boundary=XX", form("body-mime"))?.toString()).toBe(msg);
    expect(extractRawMessage("multipart/form-data; boundary=XX", form("other"))).toBeNull();
    expect(extractRawMessage("application/json", Buffer.from("{nope"))).toBeNull();
    expect(extractRawMessage("application/json", Buffer.from("{}"))).toBeNull();
    expect(extractRawMessage(undefined, Buffer.alloc(0))).toBeNull();
  });

  it("is disabled without a secret, checks the token, and stores what a relay posts", async () => {
    const off = await serve(await project());
    expect((await api(off.url, "/hooks/inbound/raw?token=x", { method: "POST", raw: msg })).status).toBe(404);
    const s = await serve(await project((cfg) => { cfg.inbound.maxMessageMb = 1; }), { webhookSecret: "relay-secret" });
    expect((await api(s.url, "/hooks/inbound/raw?token=bad", { method: "POST", raw: msg })).status).toBe(401);
    expect((await api(s.url, "/hooks/inbound/raw?token=relay-secret")).status).toBe(405);
    const ok = await api(s.url, "/hooks/inbound/raw?token=relay-secret", { method: "POST", raw: msg, headers: { "content-type": "message/rfc822" } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, kind: "message" });
    expect((await api(s.url, "/api/inbound")).json.data[0]).toMatchObject({ subject: "via webhook", source: "webhook" });
    expect((await api(s.url, "/hooks/inbound/raw?token=relay-secret", { method: "POST", raw: "{nope", headers: { "content-type": "application/json" } })).json.code).toBe("invalid_request");
    const big = await api(s.url, "/hooks/inbound/raw?token=relay-secret", { method: "POST", raw: Buffer.alloc(1_100_000, 65), headers: { "content-type": "message/rfc822" } });
    expect(big.status).toBe(413);
  });

  it("prunes mail older than the retention period", async () => {
    const dir = await project();
    const rt = await openRuntime(await loadProject(dir));
    const rec = await ingestInbound(rt, Buffer.from(msg), { source: "import" });
    expect(await pruneInbound(rt.project, 0)).toBe(0);
    expect(await pruneInbound(rt.project, 30, Date.now())).toBe(0);
    expect(await pruneInbound(rt.project, 30, Date.now() + 31 * 86_400_000)).toBe(1);
    expect(await listInboundAll(rt.project)).toEqual([]);
    expect(await readInboundRaw(rt.project, rec.id)).toBeNull();
  });

  it("imports, lists, shows, saves attachments and deletes from the CLI", async () => {
    const dir = await project();
    const file = join(dir, "m.eml");
    await writeFile(file, `From: a@remote.test\r\nSubject: cli\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nbody\r\n--b\r\nContent-Type: application/octet-stream; name="d.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from([1, 2, 3, 255]).toString("base64")}\r\n--b--\r\n`);
    const out: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t) };
    expect(await run(["inbound", "import", file, "--dir", dir, "--json"], cap)).toBe(0);
    const id = JSON.parse(out.join("")).id as string;
    out.length = 0;
    expect(await run(["inbound", "list", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toContain(id);
    out.length = 0;
    expect(await run(["inbound", "show", id, "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/d\.bin/);
    const dest = join(dir, "saved.bin");
    expect(await run(["inbound", "attachment", id, "0", "--out", dest, "--dir", dir], cap)).toBe(0);
    expect(Array.from(await readFile(dest))).toEqual([1, 2, 3, 255]);
    expect(await run(["inbound", "attachment", id, "7", "--dir", dir], io)).toBe(1);
    expect(await run(["inbound", "delete", id, "--dir", dir], cap)).toBe(0);
    expect(await run(["inbound", "show", id, "--dir", dir], io)).toBe(1);
    expect(await run(["inbound", "list", "--kind", "nope", "--dir", dir], io)).toBe(1);
  });
});

describe("replying and doctor", () => {
  const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
  it("sends a threaded, DKIM-signed reply to a received message", async () => {
    const s = await serve(await project());
    await smtp(s.inboundPort ?? 0, [...envelope("hello@mail.example.com"), "From: Ada <ada@remote.test>\r\nTo: hello@mail.example.com\r\nSubject: Question\r\nMessage-ID: <q1@remote.test>\r\nReferences: <root@remote.test>\r\n\r\nHelp?\r\n.\r\n", "QUIT\r\n"]);
    const inbound = (await api(s.url, "/api/inbound")).json.data[0];
    const r = await api(s.url, "/api/send", { method: "POST", body: { templateId: "magic_link_otp_verification", to: "ada@remote.test", variables: vars, inReplyTo: inbound.id } });
    expect(r.status).toBe(201);
    const box = (await api(s.url, "/api/inbox")).json.messages as any[];
    const raw = (await api(s.url, `/api/inbox/${box[0].id}`)).json.raw as string;
    expect(raw).toMatch(/\r\nIn-Reply-To: <q1@remote\.test>\r\n/);
    expect(raw).toMatch(/\r\nReferences: <root@remote\.test> <q1@remote\.test>\r\n/);
    expect(box[0].dkim).toMatchObject({ ok: true });
    expect(/h=([^;]+);/.exec(raw.replace(/\r\n[ \t]/g, ""))?.[1]).toContain("in-reply-to:references");

    const byId = await api(s.url, "/api/send", { method: "POST", body: { templateId: "magic_link_otp_verification", to: "b@example.org", variables: { ...vars, otpCode: "222222" }, inReplyTo: "<plain@id.test>" } });
    expect(byId.status).toBe(201);
    const unknown = await api(s.url, "/api/send", { method: "POST", body: { templateId: "magic_link_otp_verification", to: "c@example.org", variables: vars, inReplyTo: "in_0000000000000000" } });
    expect([unknown.status, unknown.json.code]).toEqual([400, "invalid_request"]);
    const unsafe = await api(s.url, "/api/send", { method: "POST", body: { templateId: "magic_link_otp_verification", to: "d@example.org", variables: vars, inReplyTo: "bad id\r\nBcc: x@y.z" } });
    expect(unsafe.status).toBe(400);
  });

  it("doctor checks the MX record and the listener settings when receiving is enabled", async () => {
    const { runDoctor } = await import("../src/doctor");
    const dir = await project((cfg) => { cfg.inbound = { ...cfg.inbound, host: "127.0.0.1", port: 2525, mxHost: "mx.example.net", retentionDays: 0 }; });
    const rt = await openRuntime(await loadProject(dir));
    const checks = await runDoctor(rt, { resolveTxt: async () => [], probe: async () => ({ ok: true, detail: "" }), env: {}, resolveMx: async () => [{ exchange: "elsewhere.test", priority: 10 }] });
    const byId = new Map(checks.map((c) => [c.id, c]));
    expect(byId.get("dns:mail.example.com:MX")).toMatchObject({ status: "fail" });
    expect(byId.get("dns:mail.example.com:MX")?.detail).toContain("inbound.mxHost is mx.example.net");
    for (const id of ["inbound:port", "inbound:tls", "inbound:host", "inbound:retention"]) expect(byId.get(id)?.status, id).toBe("warn");
    expect(byId.has("inbound:mxhost")).toBe(false);
    const ok = await runDoctor(rt, { resolveTxt: async () => [], probe: async () => ({ ok: true, detail: "" }), env: {}, resolveMx: async () => [{ exchange: "mx.example.net.", priority: 10 }] });
    expect(ok.find((c) => c.id === "dns:mail.example.com:MX")?.status).toBe("pass");
  });
});
