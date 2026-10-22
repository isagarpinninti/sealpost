# MIME, DKIM and SMTP: what Sealpost puts on the wire

This document describes the bytes Sealpost produces and accepts. Every section names the RFC it follows and the test that pins it down.

## 1. Message construction (RFC 5322, RFC 2045–2047)

`buildMimeMessage` in `@sealpost/core` produces:

```text
From: "Acme Platform" <hello@mail.example.com>
To: user@example.org
Subject: =?UTF-8?B?...?=            (only when the subject is not plain ASCII)
Date: Thu, 22 Oct 2026 09:14:02 +0000
Message-ID: <mvj5a9rd.81f91b4c7b648b145dd5@mail.example.com>
MIME-Version: 1.0
List-Unsubscribe: <https://app.example.com/unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
Content-Type: multipart/alternative; boundary="..."
```

- Body is `multipart/alternative` with `text/plain` first and `text/html` last, so clients prefer the richer part.
- With attachments the tree becomes `multipart/mixed` containing the alternative part, then each attachment base64-encoded in 76-column lines.
- Text parts use **quoted-printable** (RFC 2045 §6.7): lines at most 76 columns, `=` soft breaks, `=XX` for non-ASCII and trailing whitespace.
- Non-ASCII header values use **RFC 2047 encoded words** (UTF-8, base64), split so no encoded word exceeds 75 characters.
- Headers fold at 78 columns on whitespace (RFC 5322 §2.2.3).
- Line endings are CRLF everywhere.
- `List-Unsubscribe` is added when the domain has an `unsubscribeUrl`, together with the RFC 8058 one-click header.
- `Bcc` recipients are used for `RCPT TO` but never written into the headers.

### Injection guard

`buildMimeMessage` throws if CR, LF or NUL appears in `from`, `to`, `cc`, `reply-to`, `message-id`, `list-unsubscribe`, a custom header name or value, or an attachment filename. EW-102 reports the same condition earlier, at the gate, as a block.

## 2. DKIM (RFC 6376)

Algorithm `rsa-sha256`, canonicalization `relaxed/relaxed`, 2048-bit RSA keys, Web Crypto `RSASSA-PKCS1-v1_5`.

**Body hash (`bh=`)**, §3.4.4: reduce runs of WSP to one space, strip trailing WSP on each line, drop trailing empty lines, end with a single CRLF (an empty body canonicalizes to the empty string). SHA-256, base64.

**Header canonicalization**, §3.4.2: lowercase names, unfold, collapse WSP runs, trim around the colon.

**Signed headers (`h=`)**: by default `from`, `to`, `subject`, `date`, `message-id`, `mime-version`, `content-type` (only those present); override with the `headers` option.

**Signature header** (`DKIM-Signature`), tags in this order: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=; s=; t=; h=; bh=; b=`. The signature is computed over the canonicalized signed headers followed by the canonicalized `DKIM-Signature` header with an empty `b=` and **no trailing CRLF** (§3.7).

**Folding.** The header is folded at `; ` (the space becomes CRLF + TAB, which relaxed canonicalization collapses back to one space, so signing before or after folding yields the same bytes) and inside `b=`, with the first chunk filled so no line exceeds 76 columns.

**Verification** (`verifyDkimSignature`) parses the tags, rebuilds the signed header list from `h=`, empties `b=`, recomputes `bh=` and checks the RSA signature against the public key. Failures are specific: `Body hash mismatch`, `Signature does not verify`, `Missing tag`, `Unsupported algorithm`.

**Independent check.** The test suite verifies signed output with `node:crypto` `createVerify("RSA-SHA256")` and against the RFC 6376 §3.4.5 canonicalization vectors, so the implementation is not only agreeing with itself.

### DNS records

`synthesizeDnsRecords` returns:

| Record | Host | Value |
| --- | --- | --- |
| SPF | `domain` | `v=spf1 mx include:<spfInclude> ~all` |
| DKIM | `<selector>._domainkey.domain` | `v=DKIM1; k=rsa; p=<base64 SPKI>` |
| DMARC | `_dmarc.domain` | `v=DMARC1; p=<policy>; rua=mailto:dmarc@domain; adkim=s; aspf=s` |
| MX | `domain` | your mail host (optional) |

TXT values longer than 255 characters are split into multiple quoted strings (`zoneValue`), as DNS requires.

## 3. SMTP client (RFC 5321, RFC 3207, RFC 4954)

Written on `node:net` and `node:tls`.

```text
S: 220 mx.example.org ESMTP
C: EHLO mail.example.com
S: 250-mx.example.org
S: 250-STARTTLS
S: 250 AUTH PLAIN LOGIN
C: STARTTLS
S: 220 Ready
   (TLS handshake, then EHLO again)
C: AUTH PLAIN ********
S: 235 2.7.0 Authentication successful
C: MAIL FROM:<hello@mail.example.com>
C: RCPT TO:<user@example.org>
C: DATA
S: 354 End data with <CR><LF>.<CR><LF>
C: (dot-stuffed message)
C: .
S: 250 2.0.0 Ok: queued as e1ecd224f7102284
C: QUIT
```

- **Replies**: `250-` continues, `250 ` ends; the parser handles multi-line replies split across TCP chunks.
- **Dot-stuffing** (§4.5.2): any line starting with `.` gets a second `.` on send and loses it on receipt.
- **Security modes**: `starttls` (upgrade is required; if the server does not offer it the send fails, there is no downgrade), `tls` (implicit TLS), `none`.
- **Auth**: PLAIN, falling back to LOGIN. Credentials are masked as `********` in the transcript.
- **Plaintext guard**: credentials are never sent over an unencrypted connection to a non-private host.
- **SSRF guard**: unless `allowPrivateNetworks` is true, private, loopback and link-local targets are refused. IP literals are checked directly (Node skips `lookup` for literals); hostnames resolve through `safeLookup`, which checks the address actually connected to.
- **Transcript**: every client and server line is recorded with millisecond offsets, available to `SmtpTranscriptInspector`.

### Per-recipient classification

| Reply | Meaning | Action |
| --- | --- | --- |
| 550, 551, 553, 554 | hard bounce | suppress the address |
| 552, 4xx | soft failure | retry on schedule |
| 530, 535 | policy or auth failure | never suppresses the recipient; tries the next mailbox |

### Failover and retry

`dispatchWithFailover` tries mailboxes in order. It moves on after a network error, a 4xx or an auth failure, and stops on a permanent 5xx. Messages that could not be delivered are queued **already DKIM-signed** in `.sealpost/queue.json` and retried after 10 s, 1 min and 5 min, then marked failed.

## 4. Receipts and ledger

A receipt token is `evw_` + the first 8 bytes of the state hash + the first 8 bytes of the signature (hex), carrying an ECDSA P-256 signature (raw `r‖s`) over the canonical payload: message id, recipients, template, SMTP reply, and the SHA-256 of the exact MIME bytes. Verifying with the raw `.eml` additionally proves the message was not altered after sealing.

The ledger is JSONL; each record's `chainHash` is `SHA-256(prevHash | receiptId | messageId | stateHash | signatureHex)`. Editing, deleting or reordering any line breaks every later hash, and `sealpost ledger verify` exits `2`.
