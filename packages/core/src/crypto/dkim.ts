import type { DomainProfile } from "../schemas/template";
import { parseHeaders, splitMime } from "../engine/mime";
import { base64ToBytes, bytesToBase64, subtle, utf8 } from "../util/encoding";

const CRLF = "\r\n";
const ALGO = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface DkimKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  /** Base64 of the SubjectPublicKeyInfo: the `p=` value of the DNS record. */
  publicKeySpkiBase64: string;
}

export interface PersistentDkimKey {
  keys: DkimKeyPair;
  /** Private JWK for storage (mode 0600). Never log it. */
  privateKeyJwk: JsonWebKey;
}

/** Generates a 2048-bit RSA key for RSASSA-PKCS1-v1_5 / SHA-256. */
export async function createDkimKeyPair(): Promise<PersistentDkimKey> {
  const pair = await subtle().generateKey({ ...ALGO, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"]);
  const privateKeyJwk = await subtle().exportKey("jwk", pair.privateKey);
  const publicKeyJwk = await subtle().exportKey("jwk", pair.publicKey);
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  return { keys: { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyJwk, publicKeySpkiBase64: bytesToBase64(spki) }, privateKeyJwk };
}

export async function importDkimPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== "RSA") throw new Error("DKIM keys must be RSA");
  return subtle().importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, ALGO, true, ["verify"]);
}

export async function loadDkimKeyPair(privateKeyJwk: JsonWebKey): Promise<DkimKeyPair> {
  if (privateKeyJwk.kty !== "RSA" || !privateKeyJwk.d) throw new Error("Not an RSA private JWK");
  const privateKey = await subtle().importKey("jwk", privateKeyJwk, ALGO, false, ["sign"]);
  const publicKeyJwk: JsonWebKey = { kty: "RSA", n: privateKeyJwk.n, e: privateKeyJwk.e, alg: "RS256", ext: true };
  const publicKey = await importDkimPublicKey(publicKeyJwk);
  return { privateKey, publicKey, publicKeyJwk, publicKeySpkiBase64: bytesToBase64(new Uint8Array(await subtle().exportKey("spki", publicKey))) };
}

/* ───────────────────────── canonicalization (RFC 6376 §3.4, relaxed) ───────────────────────── */

/** Relaxed body: trailing whitespace stripped, runs of whitespace become one space, trailing blank lines removed. */
export function canonicalizeDkimBody(body: string): string {
  const lines = body.split(CRLF).map((l) => l.replace(/[ \t]+$/g, "").replace(/[ \t]+/g, " "));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? `${lines.join(CRLF)}${CRLF}` : "";
}

/** Relaxed header: lower-cased name, unfolded, whitespace collapsed, none around the colon. Ends with CRLF. */
export function canonicalizeDkimHeader(name: string, rawValue: string): string {
  return `${name.trim().toLowerCase()}:${rawValue.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim()}${CRLF}`;
}

export function canonicalizeDkimHeaders(headers: ReadonlyArray<{ name: string; raw: string }>): string {
  return headers.map((h) => canonicalizeDkimHeader(h.name, h.raw)).join("");
}

export const DEFAULT_SIGNED_HEADERS = ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"] as const;

async function bodyHash(body: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await subtle().digest("SHA-256", utf8(canonicalizeDkimBody(body)))));
}

export interface SignDkimOptions {
  domain: string;
  selector: string;
  privateKey: CryptoKey;
  /** Header names to sign, in order; absent ones are skipped. */
  headers?: readonly string[];
  now?: Date;
}

export interface DkimSigned {
  /** The message with `DKIM-Signature` prepended. */
  raw: string;
  /** The `bh=` value. */
  bodyHash: string;
  header: string;
}

function foldTags(tags: string[], signature: string): string {
  // Fold at the "; " between tags (the space becomes CRLF+TAB, which relaxed canonicalization collapses back to one space),
  // and inside the b= value, which is empty when the signature is computed.
  const lines: string[] = [];
  let cur = "DKIM-Signature: ";
  tags.forEach((t, i) => {
    const piece = `${t}${i < tags.length - 1 ? ";" : ""}`;
    if (cur.length + piece.length + 1 > 76 && cur.trim() !== "DKIM-Signature:") {
      lines.push(cur.trimEnd());
      cur = `\t${piece}`;
    } else cur += (cur.endsWith(": ") || cur.endsWith("\t") ? "" : " ") + piece;
  });
  lines.push(cur);
  const joined = lines.join(CRLF);
  if (signature === "") return joined;
  const lastLine = lines[lines.length - 1];
  const room = Math.max(0, 76 - lastLine.length);
  const chunks = [signature.slice(0, room)];
  for (let i = room; i < signature.length; i += 64) chunks.push(signature.slice(i, i + 64));
  return `${joined}${chunks.filter((c, i) => i === 0 || c !== "").join(`${CRLF}\t`)}`;
}

/** Signs a raw message with a real RFC 6376 `DKIM-Signature` (`a=rsa-sha256; c=relaxed/relaxed`). */
export async function signDkim(rawMime: string, opts: SignDkimOptions): Promise<DkimSigned> {
  const { headerBlock, body } = splitMime(rawMime);
  const parsed = parseHeaders(headerBlock);
  if (!parsed.some((h) => h.name.toLowerCase() === "from")) throw new Error("DKIM requires a From header");
  const wanted = (opts.headers ?? DEFAULT_SIGNED_HEADERS).map((h) => h.toLowerCase());
  const picked: Array<{ name: string; raw: string }> = [];
  const used = new Set<number>();
  for (const name of wanted) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (!used.has(i) && parsed[i].name.toLowerCase() === name) {
        used.add(i);
        picked.push({ name: parsed[i].name, raw: parsed[i].raw });
        break;
      }
    }
  }
  const bh = await bodyHash(body);
  const tags = [`v=1`, `a=rsa-sha256`, `c=relaxed/relaxed`, `d=${opts.domain}`, `s=${opts.selector}`, `t=${Math.floor((opts.now ?? new Date()).getTime() / 1000)}`, `h=${picked.map((p) => p.name.toLowerCase()).join(":")}`, `bh=${bh}`, "b="];
  const unsigned = foldTags(tags, "");
  const unsignedValue = unsigned.slice("DKIM-Signature:".length);
  const data = `${canonicalizeDkimHeaders(picked)}${canonicalizeDkimHeader("DKIM-Signature", unsignedValue).replace(/\r\n$/, "")}`;
  const sig = bytesToBase64(new Uint8Array(await subtle().sign(ALGO, opts.privateKey, utf8(data))));
  const header = foldTags(tags, sig);
  return { raw: `${header}${CRLF}${rawMime}`, bodyHash: bh, header };
}

export interface DkimVerification {
  ok: boolean;
  domain: string | null;
  selector: string | null;
  bodyHashOk: boolean;
  signatureOk: boolean;
  /** Headers that were covered by the signature. */
  signedHeaders: string[];
  reason: string;
}

function parseTags(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of value.replace(/\r\n(?=[ \t])/g, "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/\s+/g, "");
  }
  return tags;
}

/** Verifies the first `DKIM-Signature` of a raw message against a public key, offline. */
export async function verifyDkimSignature(rawMime: string, publicKeyJwk: JsonWebKey): Promise<DkimVerification> {
  const none = (reason: string, extra: Partial<DkimVerification> = {}): DkimVerification => ({ ok: false, domain: null, selector: null, bodyHashOk: false, signatureOk: false, signedHeaders: [], reason, ...extra });
  const { headerBlock, body } = splitMime(rawMime);
  const parsed = parseHeaders(headerBlock);
  const sigHeader = parsed.find((h) => h.name.toLowerCase() === "dkim-signature");
  if (!sigHeader) return none("No DKIM-Signature header.");
  const tags = parseTags(sigHeader.raw);
  const meta = { domain: tags.d ?? null, selector: tags.s ?? null };
  if (tags.v !== "1" || tags.a !== "rsa-sha256" || tags.c !== "relaxed/relaxed") return none("Unsupported DKIM parameters (expected v=1; a=rsa-sha256; c=relaxed/relaxed).", meta);
  if (!tags.h || !tags.bh || !tags.b || !tags.d || !tags.s) return none("DKIM-Signature is missing a required tag.", meta);
  const signedNames = tags.h.split(":").map((s) => s.toLowerCase());
  if (!signedNames.includes("from")) return none("The From header is not signed.", { ...meta, signedHeaders: signedNames });
  const bodyHashOk = (await bodyHash(body)) === tags.bh;

  const used = new Set<number>();
  const picked: Array<{ name: string; raw: string }> = [];
  for (const name of signedNames) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (!used.has(i) && parsed[i].name.toLowerCase() === name) {
        used.add(i);
        picked.push({ name: parsed[i].name, raw: parsed[i].raw });
        break;
      }
    }
  }
  const emptied = sigHeader.raw.replace(/(^|;)(\s*)b=[^;]*/, "$1$2b=");
  const data = `${canonicalizeDkimHeaders(picked)}${canonicalizeDkimHeader("DKIM-Signature", emptied).replace(/\r\n$/, "")}`;
  let signatureOk = false;
  try {
    signatureOk = await subtle().verify(ALGO, await importDkimPublicKey(publicKeyJwk), base64ToBytes(tags.b), utf8(data));
  } catch {
    signatureOk = false;
  }
  const reason = !bodyHashOk ? "Body hash mismatch: the message body was altered after signing." : !signatureOk ? "Signature mismatch: a signed header was altered, or the key does not match." : "DKIM signature verified.";
  return { ok: bodyHashOk && signatureOk, ...meta, bodyHashOk, signatureOk, signedHeaders: signedNames, reason };
}

/* ───────────────────────── DNS records ───────────────────────── */

export interface DnsRecord {
  purpose: "SPF" | "DKIM" | "DMARC" | "MX";
  type: "TXT" | "MX";
  /** Host name as most DNS panels want it (relative to the zone). */
  name: string;
  /** Fully-qualified name. */
  fqdn: string;
  value: string;
  /** TXT value as a quoted zone-file string split into 255-character chunks. */
  zoneValue: string;
  note: string;
}

const txtChunks = (v: string): string => (v.match(/.{1,255}/g) ?? [""]).map((c) => `"${c}"`).join(" ");

/** Copy-pasteable SPF, DKIM, DMARC and MX records for a domain profile and its DKIM public key. */
export function synthesizeDnsRecords(profile: Pick<DomainProfile, "domain" | "dkimSelector" | "spfInclude" | "dmarcPolicy">, dkimPublicKeySpkiBase64: string, opts: { mxHost?: string; dmarcReportEmail?: string } = {}): DnsRecord[] {
  const d = profile.domain;
  const rec = (purpose: DnsRecord["purpose"], type: "TXT" | "MX", name: string, value: string, note: string): DnsRecord => ({ purpose, type, name, fqdn: name === "@" ? d : `${name}.${d}`, value, zoneValue: type === "TXT" ? txtChunks(value) : value, note });
  const spf = profile.spfInclude ? `v=spf1 include:${profile.spfInclude} ~all` : "v=spf1 mx ~all";
  return [
    rec("SPF", "TXT", "@", spf, profile.spfInclude ? "Authorises your mailbox provider to send for this domain." : "No provider include set: edit spfInclude to your provider's SPF host (for example _spf.yourprovider.com)."),
    rec("DKIM", "TXT", `${profile.dkimSelector}._domainkey`, `v=DKIM1; k=rsa; p=${dkimPublicKeySpkiBase64}`, "Publishes the public key that receivers use to verify the DKIM-Signature on every message."),
    rec("DMARC", "TXT", "_dmarc", `v=DMARC1; p=${profile.dmarcPolicy}; rua=mailto:${opts.dmarcReportEmail ?? `dmarc@${d}`}; adkim=s; aspf=s`, "Strict alignment: the From domain must match the DKIM and SPF domains. Start with p=none, then tighten."),
    rec("MX", "MX", "@", `10 ${opts.mxHost ?? `mx.${d}`}`, "Needed only if this domain also receives mail (replies, bounces). Use your provider's MX host."),
  ];
}
