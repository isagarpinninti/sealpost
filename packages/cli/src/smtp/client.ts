import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { classifyRecipientReply, dotStuffSmtpData, type Mailbox, type SmtpDispatchResult, type SmtpTranscriptLine } from "@sealpost/core";
import { isPrivateIp, safeLookup } from "../webhook";

const CRLF = "\r\n";

export interface SmtpEndpoint {
  id?: string;
  host: string;
  port: number;
  security: Mailbox["security"];
  username?: string;
  password?: string;
}

export interface SendSmtpOptions {
  endpoint: SmtpEndpoint;
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipients: to, cc and bcc. */
  recipients: string[];
  /** The complete message, DKIM header included, CRLF line endings, not dot-stuffed. */
  data: string;
  helo?: string;
  timeoutMs?: number;
  /** Allow private and loopback addresses (the built-in sink, or an internal relay). */
  allowPrivateNetworks: boolean;
  rejectUnauthorized?: boolean;
  /** Stop after the login (greeting, EHLO, STARTTLS, AUTH) and QUIT without sending anything. Used by `sealpost doctor`. */
  probe?: boolean;
}

interface Reply {
  code: number;
  lines: string[];
  text: string;
}

class NetworkError extends Error {}
class SmtpReplyError extends Error {
  constructor(
    readonly code: number,
    readonly stage: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads RFC 5321 replies from a socket: `250-` continues a multi-line reply, `250 ` ends it. */
class Session {
  private buf = "";
  private pending: { code: number; lines: string[] } | null = null;
  private queue: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  socket!: Socket | TLSSocket;

  constructor(
    private readonly transcript: SmtpTranscriptLine[],
    private readonly t0: number,
    private readonly timeoutMs: number,
  ) {}

  log(dir: SmtpTranscriptLine["dir"], text: string): void {
    this.transcript.push({ atMs: Date.now() - this.t0, dir, text });
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    this.buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (e) => this.fail(new NetworkError(e.message)));
    socket.on("close", () => this.fail(new NetworkError("Connection closed by the server")));
    socket.setTimeout(this.timeoutMs, () => this.fail(new NetworkError(`Timed out after ${this.timeoutMs} ms`)));
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(e);
      this.waiter = null;
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 1_000_000) {
      this.fail(new NetworkError("Server sent an oversized reply"));
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.log("S", line);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      const code = Number(m[1]);
      if (!this.pending) this.pending = { code, lines: [] };
      this.pending.lines.push(m[3]);
      if (m[2] === " ") {
        const reply: Reply = { code: this.pending.code, lines: this.pending.lines, text: `${this.pending.code} ${this.pending.lines.join(" ")}` };
        this.pending = null;
        if (this.waiter) {
          clearTimeout(this.waiter.timer);
          const w = this.waiter;
          this.waiter = null;
          w.resolve(reply);
        } else this.queue.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new NetworkError(`Timed out after ${this.timeoutMs} ms waiting for the server`)), this.timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  write(line: string, shown?: string): void {
    this.log("C", shown ?? line);
    this.socket.write(`${line}${CRLF}`);
  }

  async command(line: string, shown?: string): Promise<Reply> {
    this.write(line, shown);
    return this.read();
  }
}

const expect = (r: Reply, ok: number[], stage: string): Reply => {
  if (!ok.includes(r.code)) throw new SmtpReplyError(r.code, stage, `${stage}: ${r.text}`);
  return r;
};

function waitConnected(socket: Socket | TLSSocket, event: "connect" | "secureConnect", timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new NetworkError(`Could not connect within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(new NetworkError(e.message));
    });
  });
}

/**
 * A from-scratch RFC 5321 client on `node:net` / `node:tls`: greeting, EHLO, STARTTLS (never downgraded),
 * AUTH PLAIN / LOGIN, MAIL FROM, RCPT TO, DATA with dot-stuffing, QUIT. Records the full wire transcript.
 */
export async function sendRawSmtp(opts: SendSmtpOptions): Promise<SmtpDispatchResult> {
  const { endpoint: ep } = opts;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const transcript: SmtpTranscriptLine[] = [];
  const t0 = Date.now();
  const session = new Session(transcript, t0, timeoutMs);
  const helo = opts.helo ?? "localhost";
  const accepted: string[] = [];
  const rejected: SmtpDispatchResult["rejected"] = [];
  let banner = "";
  const base = { host: ep.host, port: ep.port, mailboxId: ep.id };
  const done = (partial: Partial<SmtpDispatchResult> & Pick<SmtpDispatchResult, "ok" | "retryable">): SmtpDispatchResult => ({ ...base, banner, finalResponse: "", finalCode: 0, accepted, rejected, transcript, ...partial });

  try {
    session.log("I", `Connecting to ${ep.host}:${ep.port} (${ep.security === "tls" ? "implicit TLS" : ep.security === "starttls" ? "STARTTLS" : "plain TCP"})`);
    // net.connect skips `lookup` for IP literals, so a literal private address must be refused explicitly.
    if (!opts.allowPrivateNetworks && isIP(ep.host.replace(/^\[|\]$/g, "")) !== 0 && isPrivateIp(ep.host.replace(/^\[|\]$/g, ""))) throw new NetworkError(`SMTP host '${ep.host}' is a private address; set allowPrivateNetworks to permit it`);
    const lookup = safeLookup(opts.allowPrivateNetworks);
    const rejectUnauthorized = opts.rejectUnauthorized ?? true;
    if (ep.security === "tls") {
      const s = tlsConnect({ host: ep.host, port: ep.port, servername: ep.host, lookup, rejectUnauthorized });
      session.attach(s);
      await waitConnected(s, "secureConnect", timeoutMs);
      session.log("I", `TLS established (${s.getProtocol() ?? "TLS"}, ${s.getCipher()?.name ?? "cipher"})`);
    } else {
      const s = netConnect({ host: ep.host, port: ep.port, lookup });
      session.attach(s);
      await waitConnected(s, "connect", timeoutMs);
    }

    const greeting = expect(await session.read(), [220], "greeting");
    banner = greeting.text;

    const ehlo = async (): Promise<string[]> => {
      const r = await session.command(`EHLO ${helo}`);
      if (r.code === 250) return r.lines.map((l) => l.toUpperCase());
      expect(await session.command(`HELO ${helo}`), [250], "HELO");
      return [];
    };
    let caps = await ehlo();

    if (ep.security === "starttls") {
      if (!caps.some((c) => c.startsWith("STARTTLS"))) throw new SmtpReplyError(0, "STARTTLS", "The server does not offer STARTTLS; refusing to continue unencrypted");
      expect(await session.command("STARTTLS"), [220], "STARTTLS");
      const plain = session.socket;
      plain.removeAllListeners();
      const upgraded = tlsConnect({ socket: plain, servername: ep.host, rejectUnauthorized });
      session.attach(upgraded);
      await waitConnected(upgraded, "secureConnect", timeoutMs);
      session.log("I", `TLS established (${upgraded.getProtocol() ?? "TLS"}, ${upgraded.getCipher()?.name ?? "cipher"})`);
      caps = await ehlo();
    }

    if (ep.username !== undefined && ep.password !== undefined) {
      const encrypted = ep.security !== "none";
      if (!encrypted && !opts.allowPrivateNetworks) throw new SmtpReplyError(0, "AUTH", "Refusing to send credentials over an unencrypted connection");
      const authCap = caps.find((c) => c.startsWith("AUTH")) ?? "";
      try {
        if (authCap.includes("PLAIN") || authCap === "") {
          const token = Buffer.from(`\0${ep.username}\0${ep.password}`).toString("base64");
          expect(await session.command(`AUTH PLAIN ${token}`, "AUTH PLAIN [credentials hidden]"), [235], "AUTH");
        } else if (authCap.includes("LOGIN")) {
          expect(await session.command("AUTH LOGIN"), [334], "AUTH");
          expect(await session.command(Buffer.from(ep.username).toString("base64"), "[username hidden]"), [334], "AUTH");
          expect(await session.command(Buffer.from(ep.password).toString("base64"), "[password hidden]"), [235], "AUTH");
        } else throw new SmtpReplyError(0, "AUTH", "The server offers no supported AUTH mechanism (PLAIN, LOGIN)");
      } catch (e) {
        if (e instanceof SmtpReplyError && e.stage === "AUTH") return done({ ok: false, retryable: false, authFailed: true, finalCode: e.code, finalResponse: e.message, error: e.message });
        throw e;
      }
    }

    if (opts.probe) {
      const secured = ep.security !== "none" ? "TLS" : "no TLS";
      const authed = ep.username !== undefined && ep.password !== undefined ? "authenticated" : "no login attempted";
      await session.command("QUIT").catch(() => undefined);
      session.socket.end();
      return done({ ok: true, retryable: false, finalCode: 250, finalResponse: `${secured}, ${authed}` });
    }
    expect(await session.command(`MAIL FROM:<${opts.from}>`), [250], "MAIL FROM");
    for (const rcpt of opts.recipients) {
      const r = await session.command(`RCPT TO:<${rcpt}>`);
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      else rejected.push({ recipient: rcpt, code: r.code, message: r.text });
    }
    if (accepted.length === 0) {
      await session.command("QUIT").catch(() => undefined);
      const transient = rejected.every((x) => classifyRecipientReply(x.code) === "soft_bounce");
      return done({ ok: false, retryable: transient, finalCode: rejected[0]?.code ?? 0, finalResponse: rejected[0]?.message ?? "No recipient accepted", error: "Every recipient was rejected" });
    }

    expect(await session.command("DATA"), [354], "DATA");
    const body = opts.data.endsWith(CRLF) ? opts.data : `${opts.data}${CRLF}`;
    session.log("C", `<${body.length} bytes of message data, dot-stuffed>`);
    session.socket.write(`${dotStuffSmtpData(body)}.${CRLF}`);
    const final = await session.read();
    await session.command("QUIT").catch(() => undefined);
    session.socket.end();
    if (final.code >= 200 && final.code < 300) return done({ ok: true, retryable: false, finalCode: final.code, finalResponse: final.text });
    return done({ ok: false, retryable: final.code >= 400 && final.code < 500, finalCode: final.code, finalResponse: final.text, error: final.text });
  } catch (e) {
    session.socket?.destroy();
    const msg = e instanceof Error ? e.message : "SMTP failure";
    session.log("I", `Error: ${msg}`);
    if (e instanceof SmtpReplyError) return done({ ok: false, retryable: e.code >= 400 && e.code < 500, finalCode: e.code, finalResponse: msg, error: msg });
    return done({ ok: false, retryable: true, error: msg });
  }
}

export interface FailoverResult extends SmtpDispatchResult {
  attempts: number;
}

/**
 * Tries each relay in order. Moves on after a network error, a 4xx or a credential failure (a broken primary should
 * not stop mail); stops on success or on a permanent rejection of the message itself.
 */
export async function dispatchWithFailover(endpoints: SmtpEndpoint[], opts: Omit<SendSmtpOptions, "endpoint">): Promise<FailoverResult> {
  if (endpoints.length === 0) throw new Error("No SMTP mailbox is configured");
  const combined: SmtpTranscriptLine[] = [];
  let offset = 0;
  let last: SmtpDispatchResult | null = null;
  let anyRetryable = false;
  for (let i = 0; i < endpoints.length; i++) {
    const r = await sendRawSmtp({ ...opts, endpoint: endpoints[i] });
    anyRetryable = anyRetryable || r.retryable;
    if (i > 0) combined.push({ atMs: offset, dir: "I", text: `Failing over to ${endpoints[i].id ?? endpoints[i].host}` });
    for (const l of r.transcript) combined.push({ ...l, atMs: l.atMs + offset });
    offset += (r.transcript.at(-1)?.atMs ?? 0) + 1;
    last = r;
    const worthFailover = !r.ok && (r.retryable || r.authFailed === true);
    if (r.ok || !worthFailover) return { ...r, transcript: combined, failedOver: i > 0, attempts: i + 1 };
  }
  const l = last as SmtpDispatchResult;
  return { ...l, transcript: combined, retryable: anyRetryable, failedOver: endpoints.length > 1, attempts: endpoints.length };
}
