import { createVerify } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RELAY_PROVIDERS,
  EmailTemplateSchema,
  compileEmailTemplate as compileForImage,
  analyzeAuthenticationResults,
  checkDnsRecords,
  signWebhookPayload,
  verifyWebhookSignature,
  parseRelayEvents,
  SAMPLE_DOMAIN,
  TEMPLATE_PACKS,
  addSuppression,
  autoFillSampleVariables,
  base64ToBytes,
  buildLedgerRecord,
  buildMimeMessage,
  canonicalizeDkimBody,
  canonicalizeDkimHeaders,
  classifyRecipientReply,
  compileEmailTemplate,
  createDkimKeyPair,
  createSigningKey,
  decodeMimeWords,
  decodeQuotedPrintable,
  dotStuffSmtpData,
  encodeMimeWords,
  encodeQuotedPrintable,
  escapeHtml,
  evaluateDispatchPreflight,
  generateDeliveryReceipt,
  getTemplatePack,
  isValidEmail,
  parseHeaders,
  retryDelayMs,
  sha256OfMime,
  signDkim,
  splitMime,
  synthesizeDnsRecords,
  tamperDeliveryReceipt,
  undotStuffSmtpData,
  validateTemplate,
  verifyDeliveryLedger,
  verifyDeliveryReceipt,
  verifyDkimSignature,
  buildRegistry,
  type DeliveryLedgerRecord,
  type EmailTemplate,
  type PersistentDkimKey,
} from "../src";

const tpl = (id: string): EmailTemplate => {
  const t = getTemplatePack(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
};
const sample = (id: string) => autoFillSampleVariables(tpl(id), {});
const ctx = (id: string) => ({ template: tpl(id), domain: SAMPLE_DOMAIN });

let dkim: PersistentDkimKey;
beforeAll(async () => {
  dkim = await createDkimKeyPair();
});

describe("packs", () => {
  it("ships five valid templates that pass the pre-flight gate with their sample variables", async () => {
    expect(TEMPLATE_PACKS).toHaveLength(5);
    for (const t of TEMPLATE_PACKS) {
      expect(validateTemplate(t), t.id).toMatchObject({ ok: true, errors: [] });
      const r = await evaluateDispatchPreflight({ to: "user@example.org", variables: sample(t.id) }, ctx(t.id));
      expect(r.gate, `${t.id}: ${r.checks.filter((c) => c.severity !== "ok").map((c) => c.message).join(" | ")}`).toBe("CLEAR");
      expect(r.score).toBe(100);
    }
  });
  it("flags undeclared variables, duplicate ids and a bad otp binding", () => {
    const base = tpl("magic_link_otp_verification");
    const bad = { ...base, subject: "{{ghost}} hello", blocks: [...base.blocks, { id: "otp", type: "divider" as const }], variables: base.variables.map((v) => (v.key === "otpCode" ? { ...v, type: "string" as const } : v)) };
    const r = validateTemplate(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/\{\{ghost\}\}/);
    expect(r.errors.join(" ")).toMatch(/more than once/);
    expect(r.errors.join(" ")).toMatch(/must be declared with type otp_code/);
  });
});

describe("compiler", () => {
  it("never lets a variable inject markup", () => {
    const t = tpl("workspace_team_invitation");
    const out = compileEmailTemplate(t, { ...sample(t.id), inviterName: '<img src=x onerror=alert(1)> & "Eve"', workspaceName: "</td><script>x()</script>" });
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).not.toContain("<img src=x");
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Eve&quot;");
    expect(out.text).toContain('<img src=x onerror=alert(1)> & "Eve"'); // plain text is not escaped
  });

  it("formats currency and numbers, resolves defaults and showIfVariable", () => {
    const t = tpl("enterprise_wire_invoice");
    expect(compileEmailTemplate(t, sample(t.id)).subject).toBe("Invoice INV-2291: $62,000.00 due Nov 14, 2026");
    const m = tpl("magic_link_otp_verification");
    const withLoc = compileEmailTemplate(m, sample(m.id));
    const noLoc = compileEmailTemplate(m, { ...sample(m.id), location: "" });
    expect(withLoc.html).toContain("Berlin, DE");
    expect(noLoc.hiddenBlocks).toEqual(["kv"]);
    expect(noLoc.html).not.toContain("IP address");
    expect(compileEmailTemplate(m, { userName: "A", otpCode: "123456", signInUrl: "https://x.example/a" }).text).toContain("expires in 10 minutes");
  });

  it("leaves a missing token visible instead of dropping it", () => {
    const t = tpl("workspace_team_invitation");
    const out = compileEmailTemplate(t, { inviterName: "A" });
    expect(out.subject).toContain("{{workspaceName}}");
  });

  it("neutralises dangerous hrefs and wraps safe links for tracking", () => {
    const t = tpl("workspace_team_invitation");
    const evil = compileEmailTemplate(t, { ...sample(t.id), acceptUrl: "https://ok.example/x" });
    const tracked = compileEmailTemplate(t, sample(t.id), { tracking: { baseUrl: "https://t.example.com/", messageId: "<m1@d>" } });
    expect(evil.links).toEqual(["https://app.example.com/invite/9f31c2".replace("app.example.com/invite/9f31c2", "ok.example/x")]);
    expect(tracked.html).toContain("https://t.example.com/c/%3Cm1%40d%3E?u=https%3A%2F%2Fapp.example.com%2Finvite%2F9f31c2");
    expect(tracked.html).toContain("https://t.example.com/o/%3Cm1%40d%3E.gif");
    const bad = { ...t, blocks: t.blocks.map((b) => (b.type === "button" ? { ...b, urlTemplate: "JaVa\tScRiPt:alert(1)" } : b)) };
    const out = compileEmailTemplate(bad, sample(t.id));
    expect(out.html).toContain('href="#"');
    expect(out.urls.find((u) => u.blockId === "btn")?.safe).toBe(false);
  });

  it("escapes html helpers", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("pre-flight gate (EW-101..108)", () => {
  const base = (id = "magic_link_otp_verification") => ({ to: "user@example.org", variables: sample(id) });

  it("EW-101: blocks a missing or wrong-typed variable, and auto-fill clears it", async () => {
    const { otpCode: _drop, ...rest } = base().variables;
    void _drop;
    const miss = await evaluateDispatchPreflight({ to: "user@example.org", variables: rest }, ctx("magic_link_otp_verification"));
    expect(miss.gate).toBe("BLOCKED");
    expect(miss.checks.find((c) => c.code === "EW-101")?.severity).toBe("block");
    const wrong = await evaluateDispatchPreflight({ to: "user@example.org", variables: { ...base().variables, otpCode: "12" } }, ctx("magic_link_otp_verification"));
    expect(wrong.checks.find((c) => c.code === "EW-101")?.message).toMatch(/otpCode/);
    const healed = await evaluateDispatchPreflight({ to: "user@example.org", variables: autoFillSampleVariables(tpl("magic_link_otp_verification"), rest) }, ctx("magic_link_otp_verification"));
    expect(healed.gate).toBe("CLEAR");
  });

  it("EW-101: a missing optional variable falls back to its safe default", async () => {
    const t = "magic_link_otp_verification";
    const { expiresMinutes: _a, ipAddress: _b, ...rest } = base(t).variables;
    void _a;
    void _b;
    const r = await evaluateDispatchPreflight({ to: "user@example.org", variables: rest }, ctx(t));
    expect(r.gate).toBe("CLEAR");
    expect(r.defaultsUsed).toEqual(expect.arrayContaining(["expiresMinutes", "ipAddress"]));
  });

  it("EW-102: blocks CRLF header injection and malformed addresses", async () => {
    for (const to of ["a@example.org\r\nBcc: victim@evil.test", "not-an-email", "a@b", "x@example.org\0"]) {
      const r = await evaluateDispatchPreflight({ to, variables: base().variables }, ctx("magic_link_otp_verification"));
      expect(r.checks.find((c) => c.code === "EW-102")?.severity, to).toBe("block");
    }
    const subj = await evaluateDispatchPreflight({ to: "u@example.org", variables: { ...base().variables, userName: "x", otpCode: "123456" } }, { ...ctx("magic_link_otp_verification"), template: { ...tpl("magic_link_otp_verification"), subject: "Hi\r\nBcc: v@e.test" } });
    expect(subj.checks.find((c) => c.code === "EW-102")?.severity).toBe("block");
    const name = await evaluateDispatchPreflight({ to: "u@example.org", fromName: "Acme\r\nX: 1", variables: base().variables }, ctx("magic_link_otp_verification"));
    expect(name.checks.find((c) => c.code === "EW-102")?.severity).toBe("block");
  });

  it("EW-103: blocks a sender outside the domain, allows subdomains", async () => {
    const bad = await evaluateDispatchPreflight({ ...base(), fromEmail: "ceo@gmail.com" }, ctx("magic_link_otp_verification"));
    expect(bad.checks.find((c) => c.code === "EW-103")?.severity).toBe("block");
    const sub = await evaluateDispatchPreflight({ ...base(), fromEmail: "alerts@eu.mail.example.com" }, ctx("magic_link_otp_verification"));
    expect(sub.checks.find((c) => c.code === "EW-103")?.severity).toBe("ok");
    const look = await evaluateDispatchPreflight({ ...base(), fromEmail: "a@evilmail.example.com.attacker.io" }, ctx("magic_link_otp_verification"));
    expect(look.checks.find((c) => c.code === "EW-103")?.severity).toBe("block");
  });

  it("EW-104: blocks javascript:, data: and unexpanded links", async () => {
    const t = tpl("workspace_team_invitation");
    for (const u of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x"]) {
      const bad = { ...t, blocks: t.blocks.map((b) => (b.type === "button" ? { ...b, urlTemplate: u } : b)) };
      const r = await evaluateDispatchPreflight({ to: "u@example.org", variables: sample(t.id) }, { template: bad, domain: SAMPLE_DOMAIN });
      expect(r.checks.find((c) => c.code === "EW-104")?.severity, u).toBe("block");
    }
    const ph = await evaluateDispatchPreflight({ to: "u@example.org", variables: { ...sample(t.id), acceptUrl: "https://x.example/{{token}}" } }, ctx(t.id));
    expect(ph.gate).toBe("BLOCKED");
  });

  it("EW-105 / EW-106: warn on a long subject, empty preheader, shouting and spam phrases", async () => {
    const t = tpl("workspace_team_invitation");
    const loud = { ...t, subject: "ACT NOW!! FREE MONEY FOR YOU", preheader: "" };
    const r = await evaluateDispatchPreflight({ to: "u@example.org", variables: sample(t.id) }, { template: loud, domain: SAMPLE_DOMAIN });
    expect(r.gate).toBe("WARN");
    expect(r.checks.find((c) => c.code === "EW-105")?.severity).toBe("warn");
    expect(r.checks.find((c) => c.code === "EW-106")?.message).toMatch(/ALL CAPS[\s\S]*free money[\s\S]*act now/);
    expect(r.score).toBeLessThan(100);
    const long = await evaluateDispatchPreflight({ to: "u@example.org", variables: sample(t.id) }, { template: { ...t, subject: "x".repeat(90) }, domain: SAMPLE_DOMAIN });
    expect(long.checks.find((c) => c.code === "EW-105")?.message).toMatch(/90 characters/);
  });

  it("EW-107: a suppressed recipient is blocked before any socket", async () => {
    const list = addSuppression([], { email: "Bounced@Example.org", reason: "hard_bounce", atIso: "2026-10-01T00:00:00Z" });
    const r = await evaluateDispatchPreflight({ to: "bounced@example.org", variables: base().variables }, { ...ctx("magic_link_otp_verification"), suppressions: list });
    expect(r.checks.find((c) => c.code === "EW-107")?.severity).toBe("block");
    expect(r.gate).toBe("BLOCKED");
    const cc = await evaluateDispatchPreflight({ to: "ok@example.org", cc: ["BOUNCED@example.org"], variables: base().variables }, { ...ctx("magic_link_otp_verification"), suppressions: list });
    expect(cc.checks.find((c) => c.code === "EW-107")?.severity).toBe("block");
  });

  it("EW-108: the same send twice is a duplicate; any change makes a new key", async () => {
    const first = await evaluateDispatchPreflight(base(), ctx("magic_link_otp_verification"));
    const again = await evaluateDispatchPreflight(base(), { ...ctx("magic_link_otp_verification"), recentKeys: new Set([first.idempotencyKey]) });
    expect(again.checks.find((c) => c.code === "EW-108")?.severity).toBe("block");
    const other = await evaluateDispatchPreflight({ ...base(), variables: { ...base().variables, otpCode: "999999" } }, { ...ctx("magic_link_otp_verification"), recentKeys: new Set([first.idempotencyKey]) });
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(other.gate).toBe("CLEAR");
    const upper = await evaluateDispatchPreflight({ ...base(), to: "USER@example.org" }, ctx("magic_link_otp_verification"));
    expect(upper.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("validates email syntax", () => {
    for (const ok of ["a@example.org", "a.b+tag@sub.example.co.uk"]) expect(isValidEmail(ok)).toBe(true);
    for (const bad of ["", "a", "a@b", "a@@b.co", ".a@b.co", "a..b@c.co", "a b@c.co"]) expect(isValidEmail(bad)).toBe(false);
  });
});

describe("MIME (RFC 5322 / 2045 / 2047)", () => {
  it("round-trips quoted-printable, including non-ASCII, trailing space and long lines", () => {
    const text = `Grüße — café ☕\nA line that ends with a space \nequals = sign\n${"long ".repeat(60)}\n.leading dot`;
    const qp = encodeQuotedPrintable(text);
    expect(qp.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(qp).toContain("=\r\n");
    expect(qp).toContain("=3D");
    expect(qp).toMatch(/space=20\r\n/);
    expect(decodeQuotedPrintable(qp)).toBe(text.replace(/\n/g, "\r\n"));
  });

  it("encodes non-ASCII headers as RFC 2047 words, each ≤ 75 chars", () => {
    const subject = "Ihre Rechnung für Größe — 日本語のテキストをここに書きます ".repeat(3);
    const enc = encodeMimeWords(subject);
    expect(enc.split(" ").every((w) => w.length <= 75)).toBe(true);
    expect(decodeMimeWords(enc)).toBe(subject.trimEnd() === subject ? subject : subject);
    expect(encodeMimeWords("plain ascii")).toBe("plain ascii");
  });

  it("dot-stuffs and un-stuffs RFC 5321 data", () => {
    const body = "a\r\n.b\r\n..c\r\n.\r\nend";
    const stuffed = dotStuffSmtpData(body);
    expect(stuffed).toBe("a\r\n..b\r\n...c\r\n..\r\nend");
    expect(undotStuffSmtpData(stuffed)).toBe(body);
    expect(dotStuffSmtpData(".starts")).toBe("..starts");
  });

  it("builds multipart/alternative, adds attachments as multipart/mixed, and keeps bcc out of the headers", () => {
    const base = { from: { name: "Acme, Inc.", email: "hello@mail.example.com" }, to: ["a@example.org"], subject: "Hello wörld", text: "plain", html: "<p>html</p>", boundarySeed: "t1", date: new Date("2026-10-22T10:00:00Z"), messageId: "<id@mail.example.com>" };
    const plain = buildMimeMessage({ ...base, bcc: ["secret@example.org"], cc: ["c@example.org"], listUnsubscribe: ["https://u.example/x", "mailto:u@example.com"] });
    expect(plain.raw).toContain('From: "Acme, Inc." <hello@mail.example.com>');
    expect(plain.raw).toContain("Date: Thu, 22 Oct 2026 10:00:00 +0000");
    expect(plain.raw).toContain("Subject: =?UTF-8?B?");
    expect(plain.raw).toContain("Content-Type: multipart/alternative");
    expect(plain.raw).toContain("List-Unsubscribe: <https://u.example/x>, <mailto:u@example.com>");
    expect(plain.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(plain.raw).not.toContain("secret@example.org");
    expect(plain.raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    const att = buildMimeMessage({ ...base, attachments: [{ filename: "inv.pdf", contentType: "application/pdf", contentBase64: btoa("%PDF-1.4 fake") }] });
    expect(att.raw).toContain("Content-Type: multipart/mixed");
    expect(att.raw).toContain('Content-Disposition: attachment; filename="inv.pdf"');
    expect(att.raw).toContain(btoa("%PDF-1.4 fake"));
    expect(att.raw.trimEnd().endsWith("--=_ew_mix_t1--")).toBe(true);
  });

  it("refuses header and attachment injection", () => {
    const base = { from: { email: "h@mail.example.com" }, to: ["a@example.org"], subject: "s", text: "t", html: "h" };
    expect(() => buildMimeMessage({ ...base, headers: { "X-Test": "a\r\nBcc: v@e.test" } })).toThrow(/unsafe header/);
    expect(() => buildMimeMessage({ ...base, headers: { "Bad Name": "x" } })).toThrow(/unsafe header/);
    expect(() => buildMimeMessage({ ...base, attachments: [{ filename: 'a"\r\nX: 1', contentType: "text/plain", contentBase64: "eA==" }] })).toThrow(/unsafe attachment/);
  });
});

describe("DKIM (RFC 6376)", () => {
  it("matches the RFC 6376 §3.4.5 relaxed canonicalization examples", () => {
    expect(canonicalizeDkimBody(" C \r\nD \t E\r\n\r\n\r\n")).toBe(" C\r\nD E\r\n");
    expect(canonicalizeDkimBody("")).toBe("");
    expect(canonicalizeDkimBody("\r\n\r\n")).toBe("");
    expect(canonicalizeDkimHeaders([{ name: "A", raw: " X" }, { name: "B ", raw: " Y\t\r\n\tZ  " }])).toBe("a:X\r\nb:Y Z\r\n");
  });

  const message = (extra: Record<string, string> = {}) =>
    buildMimeMessage({ from: { name: "Acme", email: "hello@mail.example.com" }, to: ["user@example.org"], subject: "Your code is 482913", text: "Hello wörld\n", html: "<p>Hello wörld</p>", boundarySeed: "k1", date: new Date("2026-10-22T10:00:00Z"), messageId: "<k1@mail.example.com>", headers: extra });

  it("signs and verifies a real DKIM-Signature (rsa-sha256, relaxed/relaxed)", async () => {
    const signed = await signDkim(message().raw, { domain: "mail.example.com", selector: "sealpost", privateKey: dkim.keys.privateKey });
    expect(signed.raw).toMatch(/^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=mail\.example\.com;/);
    expect(signed.header.replace(/\r\n\t/g, " ")).toContain("s=sealpost;");
    expect(signed.header).toMatch(/h=from:to:subject:date:message-id:mime-version:content-type;/);
    expect(signed.header.split("\r\n").every((l) => l.length <= 78)).toBe(true);
    const v = await verifyDkimSignature(signed.raw, dkim.keys.publicKeyJwk);
    expect(v).toMatchObject({ ok: true, bodyHashOk: true, signatureOk: true, domain: "mail.example.com", selector: "sealpost" });
  });

  it("is verifiable by an independent implementation (node:crypto over the same canonical bytes)", async () => {
    const signed = await signDkim(message().raw, { domain: "mail.example.com", selector: "sealpost", privateKey: dkim.keys.privateKey });
    const { headerBlock } = splitMime(signed.raw);
    const headers = parseHeaders(headerBlock);
    const sigH = headers.find((h) => h.name === "DKIM-Signature");
    const b = /b=([^;]+)$/.exec(sigH?.raw.replace(/\s+/g, "") ?? "")?.[1] ?? "";
    const signedNames = /h=([^;]+);/.exec(sigH?.raw.replace(/\s+/g, "") ?? "")?.[1].split(":") ?? [];
    const picked = signedNames.map((n) => headers.find((h) => h.name.toLowerCase() === n)).filter((h): h is NonNullable<typeof h> => Boolean(h));
    const emptied = (sigH?.raw ?? "").replace(/b=[^;]*$/, "b=");
    const data = canonicalizeDkimHeaders(picked) + `dkim-signature:${emptied.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim()}`;
    const pem = `-----BEGIN PUBLIC KEY-----\n${dkim.keys.publicKeySpkiBase64.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----`;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(data);
    expect(verifier.verify(pem, Buffer.from(base64ToBytes(b)))).toBe(true);
  });

  it("detects a changed body, a changed signed header and a wrong key", async () => {
    const signed = await signDkim(message().raw, { domain: "mail.example.com", selector: "sealpost", privateKey: dkim.keys.privateKey });
    const body = await verifyDkimSignature(signed.raw.replace("Hello w=C3=B6rld", "Hello w=C3=B6rlD"), dkim.keys.publicKeyJwk);
    expect(body).toMatchObject({ ok: false, bodyHashOk: false });
    expect(body.reason).toMatch(/Body hash mismatch/);
    const subject = await verifyDkimSignature(signed.raw.replace("Subject: ", "Subject: X "), dkim.keys.publicKeyJwk);
    expect(subject).toMatchObject({ ok: false, bodyHashOk: true, signatureOk: false });
    const other = await createDkimKeyPair();
    expect((await verifyDkimSignature(signed.raw, other.keys.publicKeyJwk)).signatureOk).toBe(false);
    expect((await verifyDkimSignature(message().raw, dkim.keys.publicKeyJwk)).reason).toMatch(/No DKIM-Signature/);
  });

  it("is insensitive to harmless whitespace changes (relaxed) but not to content", async () => {
    const signed = await signDkim(message().raw, { domain: "mail.example.com", selector: "sealpost", privateKey: dkim.keys.privateKey });
    const rewrapped = signed.raw.replace("Subject: ", "Subject:   ").replace(/\r\n$/, "\r\n\r\n\r\n");
    expect((await verifyDkimSignature(rewrapped, dkim.keys.publicKeyJwk)).ok).toBe(true);
  });

  it("signs messages with attachments and round-trips through a persisted key", async () => {
    const withAtt = buildMimeMessage({ from: { email: "hello@mail.example.com" }, to: ["a@example.org"], subject: "inv", text: "t", html: "<b>h</b>", attachments: [{ filename: "a.bin", contentType: "application/octet-stream", contentBase64: btoa("x".repeat(500)) }] });
    const { loadDkimKeyPair } = await import("../src");
    const reloaded = await loadDkimKeyPair(dkim.privateKeyJwk);
    const signed = await signDkim(withAtt.raw, { domain: "mail.example.com", selector: "s1", privateKey: reloaded.privateKey });
    expect((await verifyDkimSignature(signed.raw, reloaded.publicKeyJwk)).ok).toBe(true);
    expect(reloaded.publicKeySpkiBase64).toBe(dkim.keys.publicKeySpkiBase64);
  });

  it("synthesizes SPF, DKIM, DMARC and MX records", () => {
    const recs = synthesizeDnsRecords({ ...SAMPLE_DOMAIN, spfInclude: "_spf.provider.net", dmarcPolicy: "quarantine" }, dkim.keys.publicKeySpkiBase64, { mxHost: "mx.provider.net" });
    expect(recs.map((r) => r.purpose)).toEqual(["SPF", "DKIM", "DMARC", "MX"]);
    expect(recs[0].value).toBe("v=spf1 include:_spf.provider.net ~all");
    expect(recs[1]).toMatchObject({ name: "sealpost._domainkey", fqdn: "sealpost._domainkey.mail.example.com" });
    expect(recs[1].value).toBe(`v=DKIM1; k=rsa; p=${dkim.keys.publicKeySpkiBase64}`);
    expect(recs[1].zoneValue.split('" "').every((c) => c.replace(/"/g, "").length <= 255)).toBe(true);
    expect(recs[2].value).toBe("v=DMARC1; p=quarantine; rua=mailto:dmarc@mail.example.com; adkim=s; aspf=s");
    expect(recs[3].value).toBe("10 mx.provider.net");
  });
});

describe("delivery receipts (evw_) and ledger", () => {
  async function receipt() {
    const issuer = await createSigningKey();
    const mime = buildMimeMessage({ from: { email: "hello@mail.example.com" }, to: ["user@example.org"], subject: "s", text: "t", html: "h", boundarySeed: "r1", date: new Date("2026-10-22T10:00:00Z"), messageId: "<r1@mail.example.com>" }).raw;
    const signed = await signDkim(mime, { domain: "mail.example.com", selector: "sealpost", privateKey: dkim.keys.privateKey });
    const r = await generateDeliveryReceipt({ templateId: "t", templateVersion: "1.0.0", to: "user@example.org", fromEmail: "hello@mail.example.com", subject: "s", messageId: "<r1@mail.example.com>", mimeSha256: await sha256OfMime(signed.raw), dkimBodyHash: signed.bodyHash, idempotencyKey: "k".repeat(64), smtpHost: "smtp.example.com", smtpStatusCode: 250, smtpBanner: "220 smtp ready", smtpQueuedResponse: "250 2.0.0 Ok: queued as ABC", deliverabilityScore: 100 }, issuer.material);
    return { r, raw: signed.raw, issuer };
  }

  it("seals, verifies offline against the message bytes, and exposes the receipt id format", async () => {
    const { r, raw, issuer } = await receipt();
    expect(r.token.startsWith("evw_")).toBe(true);
    expect(r.receiptId).toBe(`evw_${r.stateHashSha256.slice(0, 8)}${r.signatureHex.slice(0, 8)}`);
    expect(await verifyDeliveryReceipt(r.token, { rawMime: raw, issuerRegistry: await buildRegistry([issuer.material.publicKeyJwk]) })).toMatchObject({ ok: true, signature: true, mimeMatches: true, issuerTrusted: true });
    expect((await verifyDeliveryReceipt(r.token, { rawMime: `${raw}x` })).mimeMatches).toBe(false);
  });

  it("detects an altered recipient and a corrupted mime hash", async () => {
    const { r } = await receipt();
    for (const mode of ["alter-recipient", "corrupt-mime-hash"] as const) {
      const v = await verifyDeliveryReceipt(tamperDeliveryReceipt(r.token, mode));
      expect(v.ok, mode).toBe(false);
      expect(v.signature).toBe(false);
    }
    expect((await verifyDeliveryReceipt("evw_garbage")).ok).toBe(false);
  });

  it("chains receipts and pinpoints the first altered record", async () => {
    const records: DeliveryLedgerRecord[] = [];
    for (let i = 0; i < 3; i++) records.push(await buildLedgerRecord(records.at(-1), (await receipt()).r));
    expect(await verifyDeliveryLedger(records)).toMatchObject({ ok: true, count: 3 });
    const edited = records.map((x) => ({ ...x }));
    edited[1] = { ...edited[1], smtpStatusCode: 550 };
    expect(await verifyDeliveryLedger(edited)).toMatchObject({ ok: false, firstBrokenSeq: 2 });
    const forged = records.map((x) => ({ ...x }));
    forged[0] = { ...forged[0], token: tamperDeliveryReceipt(forged[0].token) };
    expect((await verifyDeliveryLedger(forged)).ok).toBe(false);
    const relinked = records.map((x) => ({ ...x }));
    relinked[0] = { ...relinked[0], chainHash: "f".repeat(64) };
    expect((await verifyDeliveryLedger(relinked, { verifyReceipts: false })).firstBrokenSeq).toBe(1);
  });
});

describe("suppression and retry", () => {
  it("classifies recipient replies and never suppresses on credential failures", () => {
    expect(classifyRecipientReply(250)).toBe("accepted");
    for (const c of [550, 551, 553, 554]) expect(classifyRecipientReply(c)).toBe("hard_bounce");
    for (const c of [421, 450, 451, 452, 552]) expect(classifyRecipientReply(c)).toBe("soft_bounce");
    for (const c of [530, 535]) expect(classifyRecipientReply(c)).toBe("rejected_policy");
  });
  it("retries at 10 s, 1 min and 5 min, then stops", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([10_000, 60_000, 300_000, null]);
  });
  it("keeps the first suppression reason", () => {
    const l = addSuppression(addSuppression([], { email: "a@b.co", reason: "hard_bounce", atIso: "1" }), { email: "A@b.co", reason: "unsubscribed", atIso: "2" });
    expect(l).toHaveLength(1);
    expect(l[0].reason).toBe("hard_bounce");
  });
});

describe("relay events", () => {
  it("parses SES bounces and complaints inside an SNS envelope", () => {
    const message = JSON.stringify({ notificationType: "Bounce", mail: { messageId: "m1" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "Gone@Example.org", diagnosticCode: "550 5.1.1 no such user" }] } });
    const r = parseRelayEvents("ses", { Type: "Notification", Message: message });
    expect(r.events).toEqual([{ kind: "hard_bounce", email: "gone@example.org", detail: "550 5.1.1 no such user", relayMessageId: "m1" }]);
    const c = parseRelayEvents("ses", { Type: "Notification", Message: JSON.stringify({ notificationType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "a@b.co" }] } }) });
    expect(c.events[0]).toMatchObject({ kind: "complaint", email: "a@b.co" });
    const soft = parseRelayEvents("ses", { notificationType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "full@b.co" }] } });
    expect(soft.events[0].kind).toBe("soft_bounce");
  });
  it("only surfaces genuine SNS confirmation URLs and never fetches them", () => {
    expect(parseRelayEvents("ses", { Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription" }).confirmationUrl).toContain("amazonaws.com");
    expect(parseRelayEvents("ses", { Type: "SubscriptionConfirmation", SubscribeURL: "http://169.254.169.254/latest" }).confirmationUrl).toBeUndefined();
  });
  it("parses SendGrid, Postmark and Mailgun payloads", () => {
    const sg = parseRelayEvents("sendgrid", [{ event: "bounce", email: "x@y.io", type: "bounce", reason: "550 nope" }, { event: "bounce", email: "z@y.io", type: "blocked" }, { event: "spamreport", email: "c@y.io" }, { event: "open", email: "o@y.io" }]);
    expect(sg.events.map((e) => e.kind)).toEqual(["hard_bounce", "soft_bounce", "complaint"]);
    const pm = parseRelayEvents("postmark", { RecordType: "Bounce", Type: "HardBounce", Email: "p@q.io", Details: "mailbox full?" });
    expect(pm.events[0]).toMatchObject({ kind: "hard_bounce", email: "p@q.io" });
    expect(parseRelayEvents("postmark", { RecordType: "SpamComplaint", Email: "s@q.io" }).events[0].kind).toBe("complaint");
    const mg = parseRelayEvents("mailgun", { "event-data": { event: "failed", severity: "permanent", recipient: "m@n.io" } });
    expect(mg.events[0].kind).toBe("hard_bounce");
    expect(parseRelayEvents("mailgun", { "event-data": { event: "failed", severity: "temporary", recipient: "m@n.io" } }).events[0].kind).toBe("soft_bounce");
  });
  it("ignores unknown shapes without throwing", () => {
    for (const p of RELAY_PROVIDERS) expect(parseRelayEvents(p, "garbage").events).toEqual([]);
    expect(parseRelayEvents("sendgrid", null).events).toEqual([]);
  });
});

describe("webhook signatures", () => {
  it("signs and verifies, and rejects tampering, staleness and malformed headers", async () => {
    const body = JSON.stringify({ type: "email.delivered" });
    const header = await signWebhookPayload("whsec", body, 1_000);
    expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature("whsec", body, header, { nowSeconds: 1_100 })).toEqual({ ok: true });
    expect(await verifyWebhookSignature("whsec", body + " ", header, { nowSeconds: 1_100 })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyWebhookSignature("other", body, header, { nowSeconds: 1_100 })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyWebhookSignature("whsec", body, header, { nowSeconds: 5_000 })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyWebhookSignature("whsec", body, "nonsense")).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyWebhookSignature("whsec", body, undefined)).toEqual({ ok: false, reason: "malformed" });
  });
  it("matches an independent node:crypto HMAC", async () => {
    const { createHmac } = await import("node:crypto");
    const header = await signWebhookPayload("k", "{}", 42);
    expect(header).toBe(`t=42,v1=${createHmac("sha256", "k").update("42.{}").digest("hex")}`);
  });
});

describe("DNS check", () => {
  it("compares published records with the expected ones", async () => {
    const recs = synthesizeDnsRecords({ domain: "mail.example.com", dkimSelector: "sealpost", dmarcPolicy: "none", spfInclude: "_spf.relay.test" }, "QUJDRA==");
    const answers: Record<string, string[][]> = {
      "mail.example.com": [["v=spf1 include:_spf.relay.test ~all"]],
      "sealpost._domainkey.mail.example.com": [["v=DKIM1; k=rsa; p=QUJD", "RA=="]],
      "_dmarc.mail.example.com": [["v=DMARC1; p=none"]],
    };
    const ok = await checkDnsRecords(recs, async (n) => answers[n] ?? [], { spfInclude: "_spf.relay.test" });
    expect(ok.map((r) => r.status)).toEqual(["ok", "ok", "ok", "skipped"]);
    const bad = await checkDnsRecords(recs, async (n) => (n.startsWith("sealpost") ? [["v=DKIM1; k=rsa; p=OLD"]] : n === "mail.example.com" ? [["v=spf1 mx ~all"], ["v=spf1 a ~all"]] : Promise.reject(new Error("NXDOMAIN"))), {});
    expect(bad.map((r) => r.status)).toEqual(["mismatch", "mismatch", "missing", "skipped"]);
  });
});

describe("Authentication-Results analysis", () => {
  const gmail = (ar: string, sigDomain = "mail.example.com"): string =>
    [
      "Delivered-To: me@gmail.com",
      `Authentication-Results: mx.google.com;`,
      ...ar.split("|").map((l) => `       ${l}`),
      "ARC-Authentication-Results: i=1; mx.google.com; dkim=fail",
      `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${sigDomain}; s=sealpost; h=from; bh=x; b=y`,
      'From: "Acme" <hello@mail.example.com>',
      "Subject: hi",
      "",
      "body",
    ].join("\n");

  it("passes when DKIM, SPF and DMARC all pass (LF line endings, ARC ignored)", () => {
    const r = analyzeAuthenticationResults(gmail("dkim=pass header.i=@mail.example.com header.s=sealpost header.b=abc;|spf=pass (google.com: domain of bounce@relay.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@relay.test;|dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=mail.example.com"));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.results.map((x) => `${x.method}:${x.verdict}`)).toEqual(["dkim:pass", "spf:pass", "dmarc:pass"]);
    expect(r.signedDomains).toEqual(["mail.example.com"]);
    expect(r.fromDomain).toBe("mail.example.com");
    expect(r.results[0].receiver).toBe("mx.google.com");
  });

  it("explains each failure in plain language", () => {
    const r = analyzeAuthenticationResults(gmail("dkim=fail header.i=@mail.example.com;|spf=softfail smtp.mailfrom=x@relay.test;|dmarc=fail header.from=mail.example.com"));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/DKIM is fail.*DKIM TXT record/);
    expect(r.problems.join(" ")).toMatch(/SPF is softfail.*spfInclude/);
    expect(r.problems.join(" ")).toMatch(/DMARC is fail/);
  });

  it("flags a missing header and a misaligned signing domain", () => {
    expect(analyzeAuthenticationResults("From: a@b.co\r\n\r\nx").problems[0]).toMatch(/No Authentication-Results/);
    const r = analyzeAuthenticationResults(gmail("dkim=pass;|spf=pass;|dmarc=pass", "other.net"));
    expect(r.problems.join(" ")).toMatch(/signed for other.net but the From domain is mail.example.com/);
  });

  it("checks MX only when asked, against the expected inbound host", async () => {
    const recs = synthesizeDnsRecords({ domain: "mail.example.com", dkimSelector: "sealpost", dmarcPolicy: "none" }, "QUJDRA==", { mxHost: "mx.example.net" });
    expect(recs[3].value).toBe("10 mx.example.net");
    const txt = async (): Promise<string[][]> => [];
    expect((await checkDnsRecords(recs, txt))[3].status).toBe("skipped");
    const mx = (list: Array<{ exchange: string; priority: number }>) => async () => list;
    expect((await checkDnsRecords(recs, txt, { resolveMx: mx([{ exchange: "MX.example.net.", priority: 10 }]), expectMxHost: "mx.example.net" }))[3].status).toBe("ok");
    const wrong = (await checkDnsRecords(recs, txt, { resolveMx: mx([{ exchange: "other.host", priority: 5 }]), expectMxHost: "mx.example.net" }))[3];
    expect(wrong).toMatchObject({ status: "mismatch", found: ["5 other.host"] });
    expect((await checkDnsRecords(recs, txt, { resolveMx: mx([]) }))[3].status).toBe("missing");
    expect((await checkDnsRecords(recs, txt, { resolveMx: async () => { throw new Error("NXDOMAIN"); } }))[3].status).toBe("missing");
  });
});

describe("image block", () => {
  const tpl = (srcTemplate: string, hrefTemplate?: string) => EmailTemplateSchema.parse({ id: "img_test", name: "Img", version: "1.0.0", category: "Growth", subject: "Hi", variables: [{ key: "logo", label: "Logo", type: "url", required: false, sampleValue: "https://cdn.example.com/l.png" }], blocks: [{ id: "i1", type: "image", srcTemplate, alt: "Acme <logo>", hrefTemplate, width: 120, align: "center" }] });
  it("renders a safe, escaped image with an optional tracked link and never tracks the src", () => {
    const c = compileForImage(tpl("{{logo}}", "https://acme.test/home"), { logo: "https://cdn.example.com/l.png" }, { tracking: { baseUrl: "https://t.example.com", messageId: "m1" } });
    expect(c.html).toContain('<img src="https://cdn.example.com/l.png" alt="Acme &lt;logo&gt;" width="120"');
    expect(c.html).toContain("https://t.example.com/c/m1?u=https%3A%2F%2Facme.test%2Fhome");
    expect(c.links).toEqual(["https://acme.test/home"]);
    expect(c.text).toContain("[Acme <logo>] https://acme.test/home");
    expect(c.urls.find((u) => u.image)?.safe).toBe(true);
  });
  it("marks javascript: and data: sources unsafe and emits no src", () => {
    for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "{{logo}}"]) {
      const c = compileForImage(tpl(bad), {}, {});
      expect(c.html).toContain('<img src=""');
      expect(c.urls.find((u) => u.image)?.safe).toBe(false);
    }
  });
});
