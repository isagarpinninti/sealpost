import { base64ToBytes, bytesToBase64, bytesToHex, utf8 } from "../util/encoding";

const CRLF = "\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ───────────────────────── quoted-printable (RFC 2045 §6.7) ───────────────────────── */

/** Encodes text as quoted-printable with CRLF line breaks and soft `=` breaks so no line exceeds 76 characters. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = encoder.encode(line);
    let cur = "";
    const push = (token: string): void => {
      if (cur.length + token.length > 75) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += token;
    };
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      push(literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    });
    out.push(cur);
  }
  return out.join(CRLF);
}

export function decodeQuotedPrintable(qp: string): string {
  const joined = qp.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...encoder.encode(ch));
  }
  return decoder.decode(new Uint8Array(bytes));
}

/* ───────────────────────── headers (RFC 5322 / RFC 2047) ───────────────────────── */

 
const NON_ASCII_OR_CTL = /[^\x20-\x7e]/;

/** RFC 2047 encoded-words (`=?UTF-8?B?…?=`), each at most 75 characters, never splitting a UTF-8 sequence. */
export function encodeMimeWords(text: string): string {
  if (!NON_ASCII_OR_CTL.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (encoder.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(encoder.encode(w))}?=`).join(" ");
}

export function decodeMimeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=(\s+(?==\?UTF-8\?B\?))?/gi, (_m, b64: string) => decoder.decode(base64ToBytes(b64)));
}

export interface Address {
  name?: string;
  email: string;
}

const ATEXT_SPECIALS = /[()<>[\]:;@\\,."]/;

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  if (NON_ASCII_OR_CTL.test(a.name)) return `${encodeMimeWords(a.name)} <${a.email}>`;
  return ATEXT_SPECIALS.test(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}" <${a.email}>` : `${a.name} <${a.email}>`;
}

/** Folds a header at spaces so no physical line exceeds 76 characters (RFC 5322 §2.2.3). */
export function foldHeader(name: string, value: string): string {
  const first = `${name}: `;
  const words = value.split(" ");
  const lines: string[] = [];
  let cur = first;
  for (const w of words) {
    const sep = cur === first || cur.endsWith(" ") ? "" : " ";
    if (cur.length + sep.length + w.length > 76 && cur.trim().length > first.trim().length - 1 && cur !== first) {
      lines.push(cur);
      cur = ` ${w}`;
    } else cur += sep + w;
  }
  lines.push(cur);
  return lines.join(CRLF);
}

/* ───────────────────────── SMTP data (RFC 5321 §4.5.2) ───────────────────────── */

/** Doubles a leading `.` on every line so the body can never end the DATA phase early. */
export function dotStuffSmtpData(mime: string): string {
  return mime.replace(/(^|\r\n)\./g, "$1..");
}

export function undotStuffSmtpData(raw: string): string {
  return raw.replace(/(^|\r\n)\.\./g, "$1.");
}

/* ───────────────────────── message builder ───────────────────────── */

export interface Attachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface MimeInput {
  from: Address;
  to: string[];
  cc?: string[];
  /** Used for the SMTP envelope only; never written into the headers. */
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  date?: Date;
  messageId?: string;
  /** `https://…` and/or `mailto:…`; a https link also adds the RFC 8058 one-click header. */
  listUnsubscribe?: string[];
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Fixed boundary suffix (tests). Random by default. */
  boundarySeed?: string;
}

export interface MimeMessage {
  raw: string;
  messageId: string;
  date: string;
  /** Header block + body split, for DKIM. */
  headerBlock: string;
  body: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatRfc5322Date(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} +0000`;
}

export const randomHex = (bytes: number): string => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

export function newMessageId(domain: string): string {
  return `<${Date.now().toString(36)}.${randomHex(10)}@${domain}>`;
}

const wrap76 = (b64: string): string => (b64.match(/.{1,76}/g) ?? []).join(CRLF);

const HEADER_NAME = /^[!-9;-~]+$/;

/** Builds a complete RFC 5322 message: `multipart/alternative` (text + html, quoted-printable), inside `multipart/mixed` when attachments exist. */
export function buildMimeMessage(input: MimeInput): MimeMessage {
  for (const [label, v] of [["from", input.from.email], ["from name", input.from.name ?? ""], ["to", input.to.join(",")], ["cc", (input.cc ?? []).join(",")], ["reply-to", input.replyTo ?? ""], ["message-id", input.messageId ?? ""], ["list-unsubscribe", (input.listUnsubscribe ?? []).join(",")]] as const) {
    if (/[\r\n\0]/.test(v)) throw new Error(`Refusing ${label}: it contains a line break or NUL (header injection)`);
  }
  const domain = input.from.email.split("@")[1] ?? "localhost";
  const messageId = input.messageId ?? newMessageId(domain);
  const date = formatRfc5322Date(input.date ?? new Date());
  const seed = input.boundarySeed ?? randomHex(12);
  const altBoundary = `=_ew_alt_${seed}`;
  const mixBoundary = `=_ew_mix_${seed}`;
  const attachments = input.attachments ?? [];

  const h: string[] = [];
  const add = (name: string, value: string): void => {
    h.push(foldHeader(name, value));
  };
  add("From", formatAddress(input.from));
  add("To", input.to.join(", "));
  if (input.cc?.length) add("Cc", input.cc.join(", "));
  if (input.replyTo) add("Reply-To", input.replyTo);
  add("Subject", encodeMimeWords(input.subject));
  add("Date", date);
  add("Message-ID", messageId);
  add("MIME-Version", "1.0");
  if (input.listUnsubscribe?.length) {
    add("List-Unsubscribe", input.listUnsubscribe.map((u) => `<${u}>`).join(", "));
    if (input.listUnsubscribe.some((u) => u.startsWith("https://"))) add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  }
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME.test(k) || /[\r\n\0]/.test(v)) throw new Error(`Refusing unsafe header "${k}"`);
    add(k, encodeMimeWords(v));
  }

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.html),
    `--${altBoundary}--`,
  ].join(CRLF);

  let body: string;
  if (attachments.length === 0) {
    h.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    body = alternative;
  } else {
    h.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`);
    const parts = attachments.map((a) => {
      if (/[\r\n"\\]/.test(a.filename) || /[\r\n;]/.test(a.contentType)) throw new Error("Refusing unsafe attachment name or type");
      const name = NON_ASCII_OR_CTL.test(a.filename) ? encodeMimeWords(a.filename) : a.filename;
      return [`--${mixBoundary}`, `Content-Type: ${a.contentType}; name="${name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "", wrap76(a.contentBase64.replace(/\s+/g, ""))].join(CRLF);
    });
    body = [`--${mixBoundary}`, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, "", alternative, ...parts, `--${mixBoundary}--`].join(CRLF);
  }
  body += CRLF;
  const headerBlock = h.join(CRLF);
  return { raw: `${headerBlock}${CRLF}${CRLF}${body}`, messageId, date, headerBlock, body };
}

/** Splits a raw message into its header block and body at the first blank line. */
export function splitMime(raw: string): { headerBlock: string; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  return at < 0 ? { headerBlock: raw, body: "" } : { headerBlock: raw.slice(0, at), body: raw.slice(at + 4) };
}

export interface ParsedHeader {
  name: string;
  /** Value as written, including any folding. */
  raw: string;
  /** Unfolded, whitespace-collapsed value. */
  value: string;
}

export function parseHeaders(headerBlock: string): ParsedHeader[] {
  const out: ParsedHeader[] = [];
  for (const line of headerBlock.split(CRLF)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += `${CRLF}${line}`;
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i), raw: line.slice(i + 1), value: "" });
    }
  }
  for (const h of out) h.value = h.raw.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim();
  return out;
}

/** The SHA-256 of the exact message bytes, as hex. */
export async function sha256OfMime(raw: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(raw))));
}
