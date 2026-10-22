import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, createSecureContext, TLSSocket, type Server as TlsServer } from "node:tls";
import { randomBytes } from "node:crypto";
import { parseHeaders, splitMime, undotStuffSmtpData, verifyDkimSignature, type DkimVerification } from "@sealpost/core";

const CRLF = "\r\n";

export interface SinkMessage {
  id: string;
  receivedAtIso: string;
  mailFrom: string;
  rcptTo: string[];
  size: number;
  subject: string;
  from: string;
  to: string;
  messageId: string;
  /** `null` when the message carries no DKIM-Signature or no key was available for its selector. */
  dkim: DkimVerification | null;
  raw: string;
}

export interface SinkOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  hostname?: string;
  /** When set, AUTH PLAIN / LOGIN must present exactly these credentials before MAIL FROM. */
  auth?: { username: string; password: string };
  /** Looks up the DKIM public key for `selector._domainkey.domain` so captured messages are verified. */
  resolveDkimKey?: (domain: string, selector: string) => JsonWebKey | undefined;
  /**
   * Simulate a failing mailbox. Return a reply to override the default `250`:
   * e.g. `{ code: 550, text: "5.1.1 No such user" }` for a hard bounce, `{ code: 451, text: "4.7.1 Try again later" }` for greylisting.
   */
  rcptRule?: (recipient: string) => { code: number; text: string } | undefined;
  /** Serve TLS: STARTTLS on the plain port, or implicit TLS (port-465 style) with `implicit: true`. */
  tls?: { key: string; cert: string; implicit?: boolean };
  maxMessageBytes?: number;
  maxRecipients?: number;
  idleTimeoutMs?: number;
  onMessage?: (m: SinkMessage) => void | Promise<void>;
}

export interface RunningSink {
  host: string;
  port: number;
  messages(): SinkMessage[];
  clear(): void;
  close(): Promise<void>;
}

const ADDRESS = /^<([^<>\s]*)>/;

/** A real RFC 5321 server on loopback that captures mail instead of delivering it, verifying DKIM on the way in. */
export async function startSmtpSink(opts: SinkOptions = {}): Promise<RunningSink> {
  const host = opts.host ?? "127.0.0.1";
  const hostname = opts.hostname ?? "sealpost-sink.local";
  const maxBytes = opts.maxMessageBytes ?? 10 * 1024 * 1024;
  const maxRcpt = opts.maxRecipients ?? 100;
  const store: SinkMessage[] = [];
  const sockets = new Set<Socket>();

  const onConnection = (initial: Socket | TLSSocket): void => {
    let socket: Socket | TLSSocket = initial;
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(opts.idleTimeoutMs ?? 30_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const send = (code: number, text: string): void => {
      socket.write(`${code} ${text}${CRLF}`);
    };
    const sendMulti = (code: number, lines: string[]): void => {
      socket.write(lines.map((l, i) => `${code}${i === lines.length - 1 ? " " : "-"}${l}`).join(CRLF) + CRLF);
    };

    type Mode = "command" | "data" | "auth_user" | "auth_pass";
    const st = { secured: initial instanceof TLSSocket, mode: "command" as Mode, busy: false, mailFrom: null as string | null, rcptTo: [] as string[], authed: !opts.auth, authUser: "", data: "", oversize: false };
    let buf = "";

    send(220, `${hostname} ESMTP Sealpost sink ready`);

    const reset = (): void => {
      st.mailFrom = null;
      st.rcptTo = [];
      st.data = "";
      st.oversize = false;
    };

    const finishData = async (envelope: { from: string; to: string[] }): Promise<void> => {
      const raw = undotStuffSmtpData(st.data);
      const tooBig = st.oversize;
      reset();
      st.mode = "command";
      if (tooBig) return send(552, "5.3.4 Message too big");
      const { headerBlock } = splitMime(raw);
      const headers = parseHeaders(headerBlock);
      const get = (n: string): string => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
      const sig = headers.find((h) => h.name.toLowerCase() === "dkim-signature");
      let dkim: DkimVerification | null = null;
      if (sig) {
        const tags = Object.fromEntries(sig.value.split(";").map((p) => [p.slice(0, p.indexOf("=")).trim(), p.slice(p.indexOf("=") + 1).replace(/\s+/g, "")]));
        const key = tags.d && tags.s ? opts.resolveDkimKey?.(tags.d, tags.s) : undefined;
        if (key) dkim = await verifyDkimSignature(raw, key);
      }
      const message: SinkMessage = { id: randomBytes(8).toString("hex"), receivedAtIso: new Date().toISOString(), mailFrom: envelope.from, rcptTo: envelope.to, size: Buffer.byteLength(raw), subject: get("subject"), from: get("from"), to: get("to"), messageId: get("message-id"), dkim, raw };
      store.push(message);
      try {
        await opts.onMessage?.(message);
      } catch {
        return send(451, "4.3.0 Local error in processing");
      }
      send(250, `2.0.0 Ok: queued as ${message.id}`);
    };

    const handle = (line: string): void => {
      if (st.mode === "auth_user") {
        st.authUser = Buffer.from(line, "base64").toString("utf8");
        st.mode = "auth_pass";
        return void socket.write(`334 ${Buffer.from("Password:").toString("base64")}${CRLF}`);
      }
      if (st.mode === "auth_pass") {
        st.mode = "command";
        const pass = Buffer.from(line, "base64").toString("utf8");
        st.authed = !opts.auth || (st.authUser === opts.auth.username && pass === opts.auth.password);
        return st.authed ? send(235, "2.7.0 Authentication successful") : send(535, "5.7.8 Authentication credentials invalid");
      }
      if (line.length > 1000) return send(500, "5.5.2 Line too long");
      const [verbRaw, ...restParts] = line.split(" ");
      const verb = verbRaw.toUpperCase();
      const rest = restParts.join(" ");
      switch (verb) {
        case "EHLO":
        case "HELO":
          reset();
          return verb === "HELO" ? send(250, hostname) : sendMulti(250, [`${hostname} greets ${rest || "client"}`, `SIZE ${maxBytes}`, "8BITMIME", "PIPELINING", ...(opts.tls && !st.secured ? ["STARTTLS"] : []), "AUTH PLAIN LOGIN", "ENHANCEDSTATUSCODES", "HELP"]);
        case "AUTH": {
          const [mech, initial] = rest.split(" ");
          if (mech?.toUpperCase() === "PLAIN" && initial) {
            const [, user, pass] = Buffer.from(initial, "base64").toString("utf8").split("\0");
            st.authed = !opts.auth || (user === opts.auth.username && pass === opts.auth.password);
            return st.authed ? send(235, "2.7.0 Authentication successful") : send(535, "5.7.8 Authentication credentials invalid");
          }
          if (mech?.toUpperCase() === "LOGIN") {
            st.mode = "auth_user";
            return void socket.write(`334 ${Buffer.from("Username:").toString("base64")}${CRLF}`);
          }
          return send(504, "5.5.4 Unrecognized authentication type");
        }
        case "MAIL": {
          if (!st.authed) return send(530, "5.7.0 Authentication required");
          const m = /^FROM:\s*(.*)$/i.exec(rest);
          const addr = m ? ADDRESS.exec(m[1]) : null;
          if (!addr) return send(501, "5.1.7 Bad sender address syntax");
          st.mailFrom = addr[1];
          st.rcptTo = [];
          return send(250, "2.1.0 Sender ok");
        }
        case "RCPT": {
          if (st.mailFrom === null) return send(503, "5.5.1 Need MAIL before RCPT");
          const m = /^TO:\s*(.*)$/i.exec(rest);
          const addr = m ? ADDRESS.exec(m[1]) : null;
          if (!addr || addr[1] === "") return send(501, "5.1.3 Bad recipient address syntax");
          if (st.rcptTo.length >= maxRcpt) return send(452, "4.5.3 Too many recipients");
          const rule = opts.rcptRule?.(addr[1]);
          if (rule) return send(rule.code, rule.text);
          st.rcptTo.push(addr[1]);
          return send(250, "2.1.5 Recipient ok");
        }
        case "DATA":
          if (st.mailFrom === null || st.rcptTo.length === 0) return send(503, "5.5.1 Need MAIL and RCPT before DATA");
          st.mode = "data";
          st.data = "";
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
        case "STARTTLS": {
          if (!opts.tls || st.secured) return send(502, "5.5.1 STARTTLS is not available");
          send(220, "2.0.0 Ready to start TLS");
          const plain = socket;
          plain.removeAllListeners("data");
          const secure = new TLSSocket(plain, { isServer: true, secureContext: createSecureContext({ key: opts.tls.key, cert: opts.tls.cert }) });
          secure.setEncoding("utf8");
          secure.on("error", () => secure.destroy());
          secure.on("data", onChunk);
          sockets.add(secure);
          socket = secure;
          st.secured = true;
          reset();
          buf = "";
          return;
        }
        default:
          return send(500, "5.5.2 Command not recognized");
      }
    };

    /** Consumes buffered input: command lines one at a time, or message data up to the lone-dot terminator. */
    const pump = (): void => {
      while (!st.busy && buf.length > 0) {
        if (st.mode === "data") {
          st.data += buf;
          buf = "";
          let body: string | null = null;
          let rest = "";
          if (st.data.startsWith(`.${CRLF}`)) {
            body = "";
            rest = st.data.slice(3);
          } else {
            const idx = st.data.indexOf(`${CRLF}.${CRLF}`);
            if (idx >= 0) {
              body = st.data.slice(0, idx + 2);
              rest = st.data.slice(idx + 5);
            }
          }
          if (body === null) {
            if (st.data.length > maxBytes + 8) {
              st.oversize = true;
              st.data = st.data.slice(-8);
            }
            return;
          }
          if (body.length > maxBytes) st.oversize = true;
          st.data = st.oversize ? "" : body;
          buf = rest;
          const envelope = { from: st.mailFrom ?? "", to: [...st.rcptTo] };
          st.busy = true;
          void finishData(envelope).finally(() => {
            st.busy = false;
            pump();
          });
          return;
        }
        const nl = buf.indexOf(CRLF);
        if (nl < 0) {
          if (buf.length > 1000) {
            send(500, "5.5.2 Line too long");
            buf = "";
          }
          return;
        }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handle(line);
      }
    };

    const onChunk = (chunk: string): void => {
      buf += chunk;
      pump();
    };
    socket.on("data", onChunk);
  };
  const server: Server | TlsServer = opts.tls?.implicit ? createTlsServer({ key: opts.tls.key, cert: opts.tls.cert }, onConnection) : createServer(onConnection);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  return {
    host,
    port,
    messages: () => [...store],
    clear: () => {
      store.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
