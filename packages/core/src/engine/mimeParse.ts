/**
 * A tolerant RFC 5322 / RFC 2045 / RFC 2231 parser for received mail.
 *
 * It accepts raw bytes (what an SMTP server hands over) or a string (encoded as UTF-8), and never throws on malformed
 * input: limits and oddities are reported in `problems`. It decodes bodies and headers but executes nothing and
 * fetches nothing, so a hostile message can only produce wrong text, never side effects.
 */

export interface ParsedAddress {
  name?: string;
  address: string;
}

export interface ParsedHeaderField {
  name: string;
  /** Unfolded and RFC 2047-decoded. */
  value: string;
  /** Unfolded, not decoded (what address parsing needs). */
  raw: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  disposition: "attachment" | "inline";
  /** Without angle brackets; the target of `cid:` URLs in the HTML body. */
  contentId?: string;
  size: number;
  content: Uint8Array;
}

export interface ParsedMessage {
  headers: ParsedHeaderField[];
  contentType: string;
  from?: ParsedAddress;
  sender?: ParsedAddress;
  replyTo: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  /** ISO 8601, when the Date header parses. */
  dateIso?: string;
  /** Message-ID, without angle brackets. */
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  text?: string;
  html?: string;
  attachments: ParsedAttachment[];
  size: number;
  /** Things that were skipped or looked wrong: nesting too deep, too many parts, bad boundary, unknown charset. */
  problems: string[];
}

export const MAX_MIME_DEPTH = 10;
export const MAX_MIME_PARTS = 300;
const MAX_TEXT_CHARS = 2_000_000;

const utf8 = new TextEncoder();

function toBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function fromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Windows-1252 for 0x80-0x9f; the other bytes equal their code points. Node 20's TextDecoder decodes this label as plain Latin-1, so it is done here. */
const CP1252_HIGH = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

/** Decodes bytes with a MIME charset name; unknown charsets fall back to UTF-8 (lossy) and are reported. */
function decodeBytes(bytes: Uint8Array, charset: string | undefined, problems?: string[]): string {
  const name = (charset ?? "").trim().toLowerCase().replace(/^"|"$/g, "");
  if (name === "" || name === "us-ascii" || name === "ascii") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return decodeWindows1252(bytes);
    }
  }
  if (["iso-8859-1", "iso8859-1", "iso_8859-1", "latin1", "l1", "cp1252", "windows-1252"].includes(name)) return decodeWindows1252(bytes);
  try {
    return new TextDecoder(name).decode(bytes);
  } catch {
    problems?.push(`Unknown charset '${name}', decoded as UTF-8`);
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Header bytes: raw UTF-8 (RFC 6532) when valid, otherwise Windows-1252. */
function headerText(binary: string): string {
  if (!/[\x80-\xff]/.test(binary)) return binary;
  const bytes = fromBinary(binary);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

function qBytes(q: string): Uint8Array {
  const out: number[] = [];
  const s = q.replace(/_/g, " ");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

function b64Bytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  try {
    return fromBinary(atob(padded));
  } catch {
    return new Uint8Array();
  }
}

/** RFC 2047 encoded words in any charset. Whitespace between two encoded words is dropped. */
export function decodeEncodedWords(value: string): string {
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let prevWasWord = false;
  for (const m of value.matchAll(word)) {
    const between = value.slice(last, m.index);
    out += prevWasWord && /^\s*$/.test(between) ? "" : between;
    const charset = m[1].split("*")[0];
    const bytes = m[2].toLowerCase() === "b" ? b64Bytes(m[3]) : qBytes(m[3]);
    out += decodeBytes(bytes, charset);
    last = (m.index ?? 0) + m[0].length;
    prevWasWord = true;
  }
  return out + value.slice(last);
}

/* ───────────────────────── headers and parameters ───────────────────────── */

function parseHeaderBlock(block: string): ParsedHeaderField[] {
  const out: Array<{ name: string; raw: string }> = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += ` ${line.trim()}`;
    else {
      const i = line.indexOf(":");
      if (i > 0 && /^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, i))) out.push({ name: line.slice(0, i), raw: line.slice(i + 1).trim() });
    }
  }
  return out.map((h) => {
    const raw = headerText(h.raw);
    return { name: h.name, raw, value: decodeEncodedWords(raw) };
  });
}

const header = (hs: readonly ParsedHeaderField[], name: string): ParsedHeaderField | undefined => hs.find((h) => h.name.toLowerCase() === name);

/** `value; key=val; key="quoted"` including RFC 2231 continuations and `key*=charset''%XX`. Keys are lower-cased. */
export function parseParams(value: string): { main: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && quoted && i + 1 < value.length) {
      cur += ch + value[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const main = (parts.shift() ?? "").trim().toLowerCase();
  const simple: Record<string, string> = {};
  const ext: Record<string, Array<{ n: number; encoded: boolean; v: string }>> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 1) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (m && (m[2] !== undefined || m[3])) {
      key = m[1];
      (ext[key] ??= []).push({ n: m[2] === undefined ? 0 : Number(m[2]), encoded: m[3] === "*", v: val });
    } else simple[key] = val;
  }
  for (const [key, segs] of Object.entries(ext)) {
    segs.sort((a, b) => a.n - b.n);
    let charset = "";
    const bytes: number[] = [];
    segs.forEach((s, i) => {
      let v = s.v;
      if (s.encoded) {
        if (i === 0) {
          const m = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (m) {
            charset = m[1];
            v = m[2];
          }
        }
        for (let k = 0; k < v.length; k++) {
          if (v[k] === "%" && /^[0-9A-Fa-f]{2}$/.test(v.slice(k + 1, k + 3))) {
            bytes.push(parseInt(v.slice(k + 1, k + 3), 16));
            k += 2;
          } else bytes.push(v.charCodeAt(k) & 0xff);
        }
      } else for (let k = 0; k < v.length; k++) bytes.push(...utf8.encode(v[k]));
    });
    simple[key] = decodeBytes(Uint8Array.from(bytes), charset || "utf-8");
  }
  return { main, params: simple };
}

/* ───────────────────────── addresses (RFC 5322 §3.4) ───────────────────────── */

function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      out += ch;
      if (ch === "\\" && i + 1 < s.length) out += s[++i];
      else if (ch === '"') quoted = false;
    } else if (ch === '"' && depth === 0) {
      quoted = true;
      out += ch;
    } else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      cur += ch;
      if (ch === "\\" && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "<") angle++;
    else if (ch === ">" && angle > 0) angle--;
    if (ch === sep && angle === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parses an address header. Names are 2047-decoded; groups are flattened; malformed entries are skipped. */
export function parseAddressList(raw: string): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  for (let seg of splitTop(stripComments(raw), ",")) {
    seg = seg.trim();
    const group = /^(?:"(?:[^"\\]|\\.)*"|[^<>@",:;]*):/.exec(seg);
    if (group && !seg.slice(0, group[0].length).includes("<")) seg = seg.slice(group[0].length).trim();
    seg = seg.replace(/;\s*$/, "").trim();
    if (seg === "") continue;
    const angle = /<([^<>]*)>/.exec(seg);
    let address = angle ? angle[1].trim() : seg;
    let name = angle ? seg.slice(0, angle.index).trim() : "";
    address = address.replace(/^mailto:/i, "").replace(/^@[^:]*:/, "");
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address) && address !== "") continue;
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    name = decodeEncodedWords(name).trim();
    if (address) out.push(name ? { name, address } : { address });
  }
  return out;
}

const ids = (v: string | undefined): string[] => [...(v ?? "").matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);

/* ───────────────────────── bodies ───────────────────────── */

function splitNode(s: string): { head: string; body: string } {
  if (s.startsWith("\r\n")) return { head: "", body: s.slice(2) };
  if (s.startsWith("\n")) return { head: "", body: s.slice(1) };
  const m = /\r?\n\r?\n/.exec(s);
  return m ? { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) } : { head: s, body: "" };
}

function splitMultipart(body: string, boundary: string): string[] | null {
  const delim = `--${boundary}`;
  const parts: string[] = [];
  let started = false;
  let partStart = 0;
  let i = 0;
  while (i <= body.length) {
    const nl = body.indexOf("\n", i);
    const lineEnd = nl < 0 ? body.length : nl;
    if (body.startsWith(delim, i)) {
      const rest = body.slice(i + delim.length, lineEnd).replace(/\r$/, "");
      const closing = rest.startsWith("--");
      if (closing || /^[ \t]*$/.test(rest)) {
        if (started) {
          let end = i;
          if (end > partStart && body[end - 1] === "\n") end--;
          if (end > partStart && body[end - 1] === "\r") end--;
          parts.push(body.slice(partStart, Math.max(partStart, end)));
        }
        if (closing) return started ? parts : null;
        started = true;
        partStart = nl < 0 ? body.length : nl + 1;
      }
    }
    if (nl < 0) break;
    i = nl + 1;
  }
  if (!started) return null;
  parts.push(body.slice(partStart));
  return parts;
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  switch (encoding.trim().toLowerCase()) {
    case "base64":
      return b64Bytes(body);
    case "quoted-printable": {
      const joined = body.replace(/=[ \t]*\r?\n/g, "");
      const out: number[] = [];
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
          out.push(parseInt(joined.slice(i + 1, i + 3), 16));
          i += 2;
        } else out.push(joined.charCodeAt(i) & 0xff);
      }
      return Uint8Array.from(out);
    }
    default:
      return fromBinary(body);
  }
}

const safeFilename = (name: string, fallback: string): string => {
  const base = name.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned === "" ? fallback : cleaned;
};

/** Parses a received message. Never throws. */
export function parseMimeMessage(input: Uint8Array | string): ParsedMessage {
  const bytes = typeof input === "string" ? utf8.encode(input) : input;
  const binary = toBinary(bytes);
  const problems: string[] = [];
  const { head, body } = splitNode(binary);
  const headers = parseHeaderBlock(head);
  const ct = parseParams(header(headers, "content-type")?.raw ?? "text/plain");

  const attachments: ParsedAttachment[] = [];
  const texts: string[] = [];
  const htmls: string[] = [];
  let partCount = 0;
  let textChars = 0;

  const walk = (hs: ParsedHeaderField[], bodyStr: string, depth: number): void => {
    if (++partCount > MAX_MIME_PARTS) {
      if (partCount === MAX_MIME_PARTS + 1) problems.push(`More than ${MAX_MIME_PARTS} MIME parts: the rest were skipped`);
      return;
    }
    const type = parseParams(header(hs, "content-type")?.raw ?? "text/plain");
    const disp = parseParams(header(hs, "content-disposition")?.raw ?? "");
    const encoding = header(hs, "content-transfer-encoding")?.raw ?? "7bit";
    if (type.main.startsWith("multipart/")) {
      if (depth >= MAX_MIME_DEPTH) {
        problems.push(`MIME nesting deeper than ${MAX_MIME_DEPTH}: inner parts were skipped`);
        return;
      }
      const boundary = type.params.boundary;
      const parts = boundary ? splitMultipart(bodyStr, boundary) : null;
      if (!parts) {
        problems.push("Multipart message without a usable boundary");
        return;
      }
      for (const p of parts) {
        const n = splitNode(p);
        walk(parseHeaderBlock(n.head), n.body, depth + 1);
      }
      return;
    }
    const content = decodeTransfer(bodyStr, encoding);
    const filenameRaw = disp.params.filename ?? type.params.name;
    const isAttachment = disp.main === "attachment" || filenameRaw !== undefined || !(type.main === "text/plain" || type.main === "text/html" || type.main === "");
    if (!isAttachment && (type.main === "text/plain" || type.main === "text/html" || type.main === "")) {
      if (content.length > 0 && textChars < MAX_TEXT_CHARS) {
        const text = decodeBytes(content, type.params.charset, problems);
        textChars += text.length;
        (type.main === "text/html" ? htmls : texts).push(text);
      }
      return;
    }
    const cid = ids(header(hs, "content-id")?.raw)[0];
    const fallback = `attachment-${attachments.length + 1}`;
    const filename = safeFilename(decodeEncodedWords(filenameRaw ?? (type.main === "message/rfc822" ? "message.eml" : fallback)), fallback);
    attachments.push({ filename, contentType: type.main || "application/octet-stream", disposition: disp.main === "inline" || (cid !== undefined && disp.main !== "attachment") ? "inline" : "attachment", contentId: cid, size: content.length, content });
  };
  walk(headers, body, 0);

  const addr = (name: string): ParsedAddress[] => parseAddressList(header(headers, name)?.raw ?? "");
  const dateRaw = header(headers, "date")?.raw.replace(/\([^)]*\)/g, "").trim();
  const dateMs = dateRaw ? Date.parse(dateRaw) : Number.NaN;
  const joinText = (list: string[]): string | undefined => (list.length ? list.join("\n\n") : undefined);
  return {
    headers,
    contentType: ct.main || "text/plain",
    from: addr("from")[0],
    sender: addr("sender")[0],
    replyTo: addr("reply-to"),
    to: addr("to"),
    cc: addr("cc"),
    subject: header(headers, "subject")?.value ?? "",
    dateIso: Number.isNaN(dateMs) ? undefined : new Date(dateMs).toISOString(),
    messageId: ids(header(headers, "message-id")?.raw)[0],
    inReplyTo: ids(header(headers, "in-reply-to")?.raw)[0],
    references: ids(header(headers, "references")?.raw),
    text: joinText(texts),
    html: joinText(htmls),
    attachments,
    size: bytes.length,
    problems,
  };
}

/** Plain-text approximation of an HTML body, for snippets. Not a sanitiser; never render its output as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
