import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, createSecureContext, TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import { formatRfc5322Date, undotStuffSmtpData } from "@sealpost/core";

const CRLF = "\r\n";

export interface InboundEnvelope {
  from: string;
  to: string[];
  remoteAddress: string;
  helo: string;
  secure: boolean;
  /** The authenticated identity, when `auth` is configured. */
  user?: string;
}

export interface InboundSmtpOptions {
  host: string;
  port: number;
  /** Name in the greeting and the Received header. */
  hostname: string;
  maxMessageBytes: number;
  /** STARTTLS (PEM contents), or implicit TLS from the first byte with `implicitTls`. */
  tls?: { key: string; cert: string };
  implicitTls?: boolean;
  /**
   * SMTP AUTH (PLAIN and LOGIN). Return the identity to accept the login, or null to refuse it. Advertised only over TLS
   * or from a loopback address, so credentials never cross the network in clear text.
   */
  auth?: (user: string, password: string) => Promise<string | null> | string | null;
  /** Refuse MAIL until the client has authenticated (a submission server). */
  requireAuth?: boolean;
  /** `true` to accept; or a reply to refuse the recipient. Anything outside your domains must be refused: this is not a relay. */
  acceptRecipient: (address: string, ctx: { user: string | null }) => boolean | { code: number; text: string } | Promise<boolean | { code: number; text: string }>;
  /** Throw to answer 451 (the sender will retry). Resolve to accept. */
  onMessage: (raw: Buffer, envelope: InboundEnvelope) => Promise<void>;
  /** Prepend a Received header (default true). A submission server turns this off so clients' addresses are not published. */
  addReceived?: boolean;
  maxRecipients?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxMessagesPerSession?: number;
  idleTimeoutMs?: number;
  sessionTimeoutMs?: number;
}

export interface RunningInboundSmtp {
  host: string;
  port: number;
  close(): Promise<void>;
}

const ADDRESS = /^<([^<>\s]*)>/;

/**
 * The MX-facing SMTP receiver. It only accepts mail for domains it is told to, never relays, caps every dimension an
 * attacker controls (size, recipients, connections per address, messages per session, idle and total time), and keeps
 * message bytes intact: the socket is read as binary, so 8-bit content survives.
 */
export async function startInboundSmtp(opts: InboundSmtpOptions): Promise<RunningInboundSmtp> {
  const maxRcpt = opts.maxRecipients ?? 50;
  const maxConns = opts.maxConnections ?? 200;
  const maxPerIp = opts.maxConnectionsPerIp ?? 10;
  const maxMessages = opts.maxMessagesPerSession ?? 50;
  const sockets = new Set<Socket>();
  const perIp = new Map<string, number>();

  const onConnection = (initial: Socket | TLSSocket): void => {
    const ip = (initial.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    let socket: Socket | TLSSocket = initial;
    if (sockets.size >= maxConns || (perIp.get(ip) ?? 0) >= maxPerIp) {
      initial.end(`421 4.3.2 Too many connections${CRLF}`);
      return;
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    sockets.add(socket);
    socket.setEncoding("latin1");
    socket.setTimeout(opts.idleTimeoutMs ?? 60_000, () => socket.destroy());
    const session = setTimeout(() => socket.destroy(), opts.sessionTimeoutMs ?? 300_000);
    session.unref();
    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      clearTimeout(session);
      sockets.delete(initial);
      sockets.delete(socket);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    };
    socket.on("close", onClose);
    socket.on("error", () => socket.destroy());

    const send = (code: number, text: string): void => void socket.write(`${code} ${text}${CRLF}`);
    const st = { secured: initial instanceof TLSSocket, user: null as string | null, authMode: null as null | "plain" | "login-user" | "login-pass", authUser: "", helo: "", mailFrom: null as string | null, rcpt: [] as string[], inData: false, chunks: [] as string[], size: 0, pending: CRLF, oversize: false, busy: false, errors: 0, messages: 0 };
    let buf = "";

    const reset = (): void => {
      st.mailFrom = null;
      st.rcpt = [];
      st.chunks = [];
      st.size = 0;
      st.pending = CRLF;
      st.oversize = false;
      st.inData = false;
    };
    const bad = (code: number, text: string): void => {
      send(code, text);
      if (++st.errors >= 10) {
        send(421, "4.7.0 Too many errors, closing");
        socket.end();
      }
    };

    send(220, `${opts.hostname} ESMTP Sealpost`);

    const loopback = ip === "127.0.0.1" || ip === "::1";
    const authAllowed = (): boolean => opts.auth !== undefined && (st.secured || loopback);
    const finishAuth = async (user: string, password: string): Promise<void> => {
      st.authMode = null;
      const who = await Promise.resolve(opts.auth?.(user, password)).catch(() => null);
      if (who) {
        st.user = who;
        return send(235, "2.7.0 Authentication successful");
      }
      st.user = null;
      bad(535, "5.7.8 Authentication credentials invalid");
    };

    const finish = async (): Promise<void> => {
      const oversize = st.oversize;
      const envelope: InboundEnvelope = { from: st.mailFrom ?? "", to: [...st.rcpt], remoteAddress: ip, helo: st.helo, secure: st.secured, ...(st.user !== null ? { user: st.user } : {}) };
      const body = st.chunks.join("").slice(2);
      reset();
      if (oversize) return send(552, "5.3.4 Message too big");
      if (++st.messages > maxMessages) return send(452, "4.5.3 Too many messages in this session");
      const id = randomBytes(6).toString("hex");
      const helo = st.helo.replace(/[^\x21-\x7e]/g, "").slice(0, 100) || "unknown";
      const received = opts.addReceived === false ? "" : `Received: from ${helo} ([${ip}])${CRLF}\tby ${opts.hostname} with ESMTP${st.secured ? "S" : ""} id ${id};${CRLF}\t${formatRfc5322Date(new Date())}${CRLF}`;
      try {
        await opts.onMessage(Buffer.from(received + undotStuffSmtpData(body), "latin1"), envelope);
      } catch (e) {
        // A handler may refuse with its own reply: throw Object.assign(new Error(), { smtp: { code, text } }).
        const r = (e as { smtp?: { code: number; text: string } }).smtp;
        return send(r?.code ?? 451, r?.text ?? "4.3.0 Local error in processing, try again later");
      }
      send(250, `2.0.0 Ok: queued as ${id}`);
    };

    const command = (line: string): void | Promise<void> => {
      if (line.length > 998) return bad(500, "5.5.2 Line too long");
      const sp = line.indexOf(" ");
      const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const rest = sp < 0 ? "" : line.slice(sp + 1);
      switch (verb) {
        case "EHLO":
        case "HELO":
          st.helo = rest.trim();
          reset();
          if (verb === "HELO") return send(250, opts.hostname);
          return void socket.write([`250-${opts.hostname} greets ${st.helo.replace(/[^\x21-\x7e]/g, "").slice(0, 100) || "you"}`, `250-SIZE ${opts.maxMessageBytes}`, "250-8BITMIME", "250-PIPELINING", ...(opts.tls && !st.secured ? ["250-STARTTLS"] : []), ...(authAllowed() ? ["250-AUTH PLAIN LOGIN"] : []), "250 ENHANCEDSTATUSCODES"].join(CRLF) + CRLF);
        case "STARTTLS": {
          if (!opts.tls || st.secured) return send(502, "5.5.1 STARTTLS is not available");
          send(220, "2.0.0 Ready to start TLS");
          const plain = socket;
          plain.removeAllListeners("data");
          const secure = new TLSSocket(plain, { isServer: true, secureContext: createSecureContext({ key: opts.tls.key, cert: opts.tls.cert }) });
          secure.setEncoding("latin1");
          secure.on("error", () => secure.destroy());
          secure.on("data", onChunk);
          secure.on("close", onClose);
          sockets.add(secure);
          socket = secure;
          st.secured = true;
          st.user = null;
          st.authMode = null;
          st.helo = "";
          reset();
          buf = ""; // anything buffered before the handshake is discarded (CVE-2011-0411 class)
          return;
        }
        case "AUTH": {
          if (!authAllowed()) return send(502, "5.5.1 AUTH is not available on an unencrypted connection");
          if (st.user !== null) return bad(503, "5.5.1 Already authenticated");
          const [mech, initial] = rest.split(" ");
          if (mech?.toUpperCase() === "PLAIN") {
            if (initial) {
              const [, user, pass] = Buffer.from(initial, "base64").toString("utf8").split("\0");
              return finishAuth(user ?? "", pass ?? "");
            }
            st.authMode = "plain";
            return void socket.write(`334 ${CRLF}`);
          }
          if (mech?.toUpperCase() === "LOGIN") {
            st.authMode = "login-user";
            return void socket.write(`334 ${Buffer.from("Username:").toString("base64")}${CRLF}`);
          }
          return bad(504, "5.5.4 Unrecognized authentication type");
        }
        case "MAIL": {
          if (opts.requireAuth && st.user === null) return bad(530, "5.7.0 Authentication required");
          if (st.mailFrom !== null) return bad(503, "5.5.1 Nested MAIL command");
          const m = /^FROM:\s*(<[^<>\s]*>)(.*)$/i.exec(rest);
          const addr = m ? ADDRESS.exec(m[1]) : null;
          if (!m || !addr) return bad(501, "5.1.7 Bad sender address syntax");
          const size = /\bSIZE=(\d+)\b/i.exec(m[2])?.[1];
          if (size !== undefined && Number(size) > opts.maxMessageBytes) return send(552, "5.3.4 Message size exceeds the limit");
          st.mailFrom = addr[1];
          st.rcpt = [];
          return send(250, "2.1.0 Sender ok");
        }
        case "RCPT": {
          if (st.mailFrom === null) return bad(503, "5.5.1 Need MAIL before RCPT");
          const m = /^TO:\s*(<[^<>\s]*>)/i.exec(rest);
          const addr = m ? ADDRESS.exec(m[1]) : null;
          if (!addr || addr[1] === "" || !addr[1].includes("@")) return bad(501, "5.1.3 Bad recipient address syntax");
          if (st.rcpt.length >= maxRcpt) return send(452, "4.5.3 Too many recipients");
          return Promise.resolve(opts.acceptRecipient(addr[1], { user: st.user })).then((verdict) => {
            if (verdict !== true) return bad(typeof verdict === "object" ? verdict.code : 550, typeof verdict === "object" ? verdict.text : "5.7.1 Relay access denied");
            st.rcpt.push(addr[1]);
            send(250, "2.1.5 Recipient ok");
          });
        }
        case "DATA":
          if (st.mailFrom === null || st.rcpt.length === 0) return bad(503, "5.5.1 Need MAIL and RCPT before DATA");
          st.inData = true;
          st.chunks = [];
          st.size = 0;
          st.pending = CRLF;
          st.oversize = false;
          return send(354, "End data with <CR><LF>.<CR><LF>");
        case "RSET":
          reset();
          return send(250, "2.0.0 Ok");
        case "NOOP":
          return send(250, "2.0.0 Ok");
        case "QUIT":
          send(221, "2.0.0 Bye");
          return void socket.end();
        case "VRFY":
        case "EXPN":
          return send(502, "5.5.1 Command not implemented");
        default:
          return bad(500, "5.5.2 Command not recognized");
      }
    };

    const pump = (): void => {
      while (!st.busy && buf.length > 0) {
        if (st.inData) {
          // `pending` holds the last few bytes back so a terminator split across chunks is still found. It starts as a
          // virtual CRLF (so a message that is just ".") and that first CRLF is dropped again in finish().
          const combined = st.pending + buf;
          const end = combined.indexOf(`${CRLF}.${CRLF}`);
          if (end < 0) {
            const keep = Math.min(4, combined.length);
            const emit = combined.slice(0, combined.length - keep);
            if (!st.oversize && emit) {
              st.chunks.push(emit);
              st.size += emit.length;
              if (st.size > opts.maxMessageBytes + 16) {
                st.oversize = true;
                st.chunks = [];
              }
            }
            st.pending = combined.slice(combined.length - keep);
            buf = "";
            return;
          }
          const emit = combined.slice(0, end + 2);
          if (!st.oversize) {
            st.chunks.push(emit);
            st.size += emit.length;
            if (st.size > opts.maxMessageBytes + 2) st.oversize = true;
          }
          buf = combined.slice(end + 5);
          st.inData = false;
          st.busy = true;
          void finish().finally(() => {
            st.busy = false;
            pump();
          });
          return;
        }
        const nl = buf.indexOf(CRLF);
        if (nl < 0) {
          if (buf.length > 1000) {
            bad(500, "5.5.2 Line too long");
            buf = "";
          }
          return;
        }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (st.authMode !== null) {
          const mode = st.authMode;
          if (mode === "login-user") {
            st.authUser = Buffer.from(line, "base64").toString("utf8");
            st.authMode = "login-pass";
            socket.write(`334 ${Buffer.from("Password:").toString("base64")}${CRLF}`);
            continue;
          }
          const decoded = Buffer.from(line, "base64").toString("utf8");
          const [, user, pass] = mode === "plain" ? decoded.split("\0") : ["", st.authUser, decoded];
          st.busy = true;
          void finishAuth(user ?? "", pass ?? "").finally(() => {
            st.busy = false;
            pump();
          });
          return;
        }
        const r = command(line);
        if (r instanceof Promise) {
          st.busy = true;
          void r.finally(() => {
            st.busy = false;
            pump();
          });
          return;
        }
      }
    };

    const onChunk = (chunk: string): void => {
      buf += chunk;
      pump();
    };
    socket.on("data", onChunk);
  };

  const server: Server = opts.implicitTls && opts.tls ? (createTlsServer({ key: opts.tls.key, cert: opts.tls.cert }, onConnection) as unknown as Server) : createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  return {
    host: opts.host,
    port: typeof address === "object" && address ? address.port : opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
