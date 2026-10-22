import { describe, expect, it } from "vitest";
import { classifyInbound, htmlToText, parseAddressList, parseMimeMessage, parseParams } from "../src";

const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");
const b64 = (s: string | Uint8Array): string => Buffer.from(s).toString("base64").replace(/(.{76})/g, "$1\r\n");

describe("addresses and parameters", () => {
  it("parses names, quotes, comments, groups and encoded words", () => {
    expect(parseAddressList('"Smith, Ada" <ada@x.io>, bob@y.io, Carol (boss) <carol@z.io>, Team: d@a.io, e@b.io;')).toEqual([
      { name: "Smith, Ada", address: "ada@x.io" },
      { address: "bob@y.io" },
      { name: "Carol", address: "carol@z.io" },
      { address: "d@a.io" },
      { address: "e@b.io" },
    ]);
    expect(parseAddressList("=?UTF-8?B?w4lsw6g=?= <eleve@x.io>, not an address, <>")).toEqual([{ name: "Élè", address: "eleve@x.io" }]);
  });

  it("decodes RFC 2231 filenames, continuations and quoted values", () => {
    expect(parseParams("attachment; filename*=utf-8''%E2%82%AC%20rates.pdf").params.filename).toBe("€ rates.pdf");
    expect(parseParams('attachment; filename*0="very-long-"; filename*1="name.txt"').params.filename).toBe("very-long-name.txt");
    expect(parseParams('text/plain; charset="utf-8"; name="a;b.txt"').params).toEqual({ charset: "utf-8", name: "a;b.txt" });
  });
});

describe("parseMimeMessage", () => {
  it("reads a multipart/alternative message with an encoded subject and QP text", () => {
    const m = parseMimeMessage(crlf(`From: =?UTF-8?Q?Caf=C3=A9?= <cafe@shop.io>
To: Me <me@mail.example.com>
Cc: a@x.io, b@x.io
Subject: =?UTF-8?B?SGVsbG8g8J+RiyB3b3JsZA==?=
Date: Thu, 22 Oct 2026 09:14:02 +0000
Message-ID: <abc.123@shop.io>
In-Reply-To: <orig.1@mail.example.com>
References: <r1@x.io> <orig.1@mail.example.com>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="BOUND"

--BOUND
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 au lait =E2=80=94 is=
 ready
--BOUND
Content-Type: text/html; charset=utf-8

<p>Café <b>au lait</b></p>
--BOUND--
`));
    expect(m.from).toEqual({ name: "Café", address: "cafe@shop.io" });
    expect(m.subject).toBe("Hello 👋 world");
    expect(m.to).toEqual([{ name: "Me", address: "me@mail.example.com" }]);
    expect(m.cc.map((a) => a.address)).toEqual(["a@x.io", "b@x.io"]);
    expect(m.text).toBe("Café au lait — is ready");
    expect(m.html).toBe("<p>Café <b>au lait</b></p>");
    expect(m.messageId).toBe("abc.123@shop.io");
    expect(m.inReplyTo).toBe("orig.1@mail.example.com");
    expect(m.references).toEqual(["r1@x.io", "orig.1@mail.example.com"]);
    expect(m.dateIso).toBe("2026-10-22T09:14:02.000Z");
    expect(m.attachments).toEqual([]);
    expect(m.problems).toEqual([]);
  });

  it("extracts binary attachments byte for byte, with inline images and unicode filenames", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x1a]);
    const m = parseMimeMessage(crlf(`From: a@x.io
Subject: files
Content-Type: multipart/mixed; boundary="M"

--M
Content-Type: multipart/related; boundary="R"

--R
Content-Type: text/html; charset=utf-8

<img src="cid:logo@x">
--R
Content-Type: image/png
Content-ID: <logo@x>
Content-Transfer-Encoding: base64

${b64(png)}
--R--
--M
Content-Type: application/pdf; name="fallback.pdf"
Content-Disposition: attachment; filename*=utf-8''%E2%82%AC%20rates.pdf
Content-Transfer-Encoding: base64

${b64("%PDF-1.4 hello")}
--M
Content-Type: message/rfc822
Content-Disposition: attachment

Subject: forwarded

body
--M--
`));
    expect(m.html).toBe('<img src="cid:logo@x">');
    expect(m.attachments.map((a) => [a.filename, a.contentType, a.disposition, a.contentId, a.size])).toEqual([
      ["attachment-1", "image/png", "inline", "logo@x", png.length],
      ["€ rates.pdf", "application/pdf", "attachment", undefined, 14],
      ["message.eml", "message/rfc822", "attachment", undefined, 26],
    ]);
    expect(Array.from(m.attachments[0].content)).toEqual(Array.from(png));
    expect(new TextDecoder().decode(m.attachments[1].content)).toBe("%PDF-1.4 hello");
  });

  it("decodes legacy charsets from raw bytes (8-bit ISO-8859-1 and Shift_JIS via base64)", () => {
    const latin1 = Buffer.concat([Buffer.from("From: a@x.io\r\nSubject: =?ISO-8859-1?Q?caf=E9?=\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80])]);
    const m = parseMimeMessage(latin1);
    expect(m.subject).toBe("café");
    expect(m.text).toBe("café €"); // 0x80 is the euro sign in the Windows-1252 superset that browsers use for iso-8859-1
    const sjis = parseMimeMessage(crlf(`From: a@x.io\nContent-Type: text/plain; charset=shift_jis\nContent-Transfer-Encoding: base64\n\n${Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]).toString("base64")}\n`));
    expect(sjis.text).toBe("こんにちは");
  });

  it("copes with LF-only input, no body, a missing boundary and unknown charsets", () => {
    expect(parseMimeMessage("From: a@x.io\nSubject: hi\n\nplain body\n").text).toBe("plain body\n");
    expect(parseMimeMessage("Subject: only headers").text).toBeUndefined();
    const noBoundary = parseMimeMessage("Content-Type: multipart/mixed\r\n\r\nstuff");
    expect(noBoundary.problems.join()).toMatch(/boundary/);
    const unknown = parseMimeMessage("Content-Type: text/plain; charset=x-made-up\r\n\r\nhello");
    expect(unknown.text).toBe("hello");
    expect(unknown.problems.join()).toMatch(/Unknown charset/);
    expect(parseMimeMessage("").subject).toBe("");
  });

  it("limits nesting depth and part count, and survives hostile structure", () => {
    let nested = "Subject: deep\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n";
    for (let i = 0; i < 14; i++) nested += `--b${i}\r\nContent-Type: multipart/mixed; boundary=b${i + 1}\r\n\r\n`;
    nested += "--b14\r\nContent-Type: text/plain\r\n\r\nbottom\r\n";
    const deep = parseMimeMessage(nested);
    expect(deep.problems.join()).toMatch(/nesting deeper/);
    expect(deep.text).toBeUndefined();

    let many = "Content-Type: multipart/mixed; boundary=x\r\n\r\n";
    for (let i = 0; i < 400; i++) many += `--x\r\nContent-Type: application/octet-stream; name=f${i}\r\n\r\nd\r\n`;
    many += "--x--\r\n";
    const big = parseMimeMessage(many);
    expect(big.attachments.length).toBeLessThanOrEqual(300);
    expect(big.problems.join()).toMatch(/MIME parts/);
  });

  it("sanitises hostile attachment names", () => {
    const m = parseMimeMessage(crlf(`Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain; name="../../etc/passwd\u0001"\nContent-Disposition: attachment\n\nx\n--b\nContent-Type: text/plain\nContent-Disposition: attachment; filename="..\\\\win\\\\evil.exe"\n\ny\n--b--\n`));
    expect(m.attachments.map((a) => a.filename)).toEqual(["passwd", "evil.exe"]);
  });

  it("makes a plain-text snippet from HTML without executing anything", () => {
    expect(htmlToText("<style>p{}</style><p>Hi&nbsp;<b>there</b> &amp; welcome</p><script>alert(1)</script><br>bye")).toBe("Hi there & welcome\nbye");
  });
});

describe("classifyInbound", () => {
  const dsn = (status: string, action: string, diag: string): string => crlf(`From: MAILER-DAEMON@relay.example.net
To: hello@mail.example.com
Subject: Undelivered Mail Returned to Sender
Auto-Submitted: auto-replied
Content-Type: multipart/report; report-type=delivery-status; boundary="D"

--D
Content-Type: text/plain

This is the mail system. I'm sorry to have to inform you that your message could not be delivered.
--D
Content-Type: message/delivery-status

Reporting-MTA: dns; relay.example.net
Arrival-Date: Thu, 22 Oct 2026 09:14:02 +0000

Final-Recipient: rfc822; Gone@Example.ORG
Original-Recipient: rfc822;gone@example.org
Action: ${action}
Status: ${status}
Diagnostic-Code: smtp; ${diag}
--D
Content-Type: message/rfc822

Message-ID: <sent.1@mail.example.com>
From: hello@mail.example.com
To: gone@example.org
Subject: Welcome

hi
--D--
`);

  it("reads a delivery status report: hard vs soft, recipient, diagnostic and the bounced Message-ID", () => {
    const hard = classifyInbound(parseMimeMessage(dsn("5.1.1", "failed", "550 5.1.1 <gone@example.org>: User unknown")));
    expect(hard.kind).toBe("bounce");
    expect(hard.autoReply).toBe(false);
    expect(hard.bounce).toMatchObject({ originalMessageId: "sent.1@mail.example.com", unparsed: false });
    expect(hard.bounce?.recipients).toEqual([{ email: "gone@example.org", status: "5.1.1", action: "failed", diagnostic: "550 5.1.1 <gone@example.org>: User unknown", hard: true }]);
    const soft = classifyInbound(parseMimeMessage(dsn("4.2.2", "delayed", "452 mailbox full")));
    expect(soft.bounce?.recipients[0]).toMatchObject({ action: "delayed", hard: false, status: "4.2.2" });
  });

  it("flags a bare mailer-daemon notice as an unparsed bounce and reads an abuse report", () => {
    const bare = classifyInbound(parseMimeMessage(crlf("From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\nSubject: Delivery Status Notification (Failure)\n\nAddress not found")));
    expect(bare).toMatchObject({ kind: "bounce", bounce: { unparsed: true, recipients: [] } });
    const arf = classifyInbound(parseMimeMessage(crlf(`From: fbl@isp.test
Subject: FW: Welcome
Content-Type: multipart/report; report-type=feedback-report; boundary="F"

--F
Content-Type: text/plain

complaint
--F
Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: ISP/1.0
Original-Rcpt-To: <Angry@Example.org>
--F
Content-Type: message/rfc822

Message-ID: <sent.2@mail.example.com>
To: angry@example.org
Subject: Welcome

x
--F--
`)));
    expect(arf).toMatchObject({ kind: "complaint", complaint: { recipient: "angry@example.org", feedbackType: "abuse", originalMessageId: "sent.2@mail.example.com" } });
  });

  it("recognises automatic replies and treats everything else as a message", () => {
    expect(classifyInbound(parseMimeMessage("From: a@x.io\r\nAuto-Submitted: auto-replied\r\nSubject: Out of office\r\n\r\nback soon")).autoReply).toBe(true);
    expect(classifyInbound(parseMimeMessage("From: a@x.io\r\nPrecedence: auto_reply\r\n\r\nx")).autoReply).toBe(true);
    expect(classifyInbound(parseMimeMessage("From: a@x.io\r\nAuto-Submitted: no\r\n\r\nx"))).toEqual({ kind: "message", autoReply: false });
  });
});
