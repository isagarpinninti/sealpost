# Receiving email

Sealpost can receive mail for your domains: replies, delivery failures (bounces) and abuse reports. Everything it receives is parsed, checked, stored and, where it matters, acted on.

| What arrives | What Sealpost does |
| --- | --- |
| A reply to something you sent | Stores it, adds a **replied** event to that email's timeline (matched by `In-Reply-To`/`References`), sends `email.received` |
| A delivery failure report (RFC 3464) | If it quotes mail this server sent **and** names one of that mail's recipients: suppresses a hard-bounced address, marks the email `bounced` (or `deferred` for 4.x), sends `email.bounced` |
| An abuse report (ARF, RFC 5965) | Same rule: suppresses the complaining address, marks the email `complained` |
| An out-of-office / automatic reply | Stores it with `autoReply: true` so your app can skip it |
| Anything else | Stores it and sends `email.received` |

**Forged reports do nothing.** A bounce or complaint is only acted on when it matches mail you really sent, so nobody can get an arbitrary address suppressed by mailing you a fake report. Unmatched reports are stored with `reportVerified` unset so you can see them.

## Two ways in

### 1. Sealpost listens on port 25 (the MX target)

```json
"inbound": {
  "enabled": true,
  "host": "0.0.0.0",
  "port": 2525,
  "mxHost": "mx.yourdomain.com",
  "tls": { "keyFile": "certs/privkey.pem", "certFile": "certs/fullchain.pem" },
  "maxMessageMb": 25,
  "retentionDays": 90
}
```

1. Point `mx.yourdomain.com` (an `A` record) at this server.
2. Publish the MX record that `sealpost dns` prints (`10 mx.yourdomain.com`) for each domain you want to receive for. `inbound.domains` limits which domains are accepted; empty means every sending domain.
3. Senders always connect to **port 25**; an MX record cannot name a port. Either let Sealpost bind 25 or redirect it:
   ```bash
   sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
   ```
4. `sealpost doctor` checks the MX record, the port, TLS, the bind address and retention.

Many cloud providers block inbound port 25. If yours does, use the second option.

### 2. Your relay forwards mail to Sealpost

Set `SEALPOST_WEBHOOK_SECRET` and point the relay's inbound feature at `POST /hooks/inbound/raw?token=<secret>`. Accepted bodies:

| Relay | Configure |
| --- | --- |
| Amazon SES | Receipt rule → SNS action with the message content → HTTPS subscription to the URL |
| SendGrid | Inbound Parse with "Send Raw, full MIME message" (posts the `email` field) |
| Mailgun | A route that forwards to the URL in MIME format (posts `body-mime`) |
| Anything else | `POST` the raw message as `message/rfc822`, or JSON `{ "raw": "…" }` / `{ "rawBase64": "…" }` |
| A file | `sealpost inbound import message.eml` |

The endpoint is off (404) until a secret is set. SNS signatures are not verified (the token is the authentication), and SNS subscription confirmation is not performed automatically.

## Reading it

```bash
sealpost inbound list --kind message --q refund
sealpost inbound show in_3f9c…
sealpost inbound attachment in_3f9c… 0 --out invoice.pdf
sealpost inbound raw in_3f9c… --out original.eml
```

REST: `GET /api/inbound` (filters `from`, `to`, `q`, `kind`, `since`, `until`; pages with `limit` and `before`), `GET /api/inbound/{id}` (decoded `text`, `html`, headers), `/raw`, `/attachments/{n}`, `DELETE /api/inbound/{id}`. The SDKs have `inbound.list/get/raw/attachment/delete`. The Studio **Logs → Received** tab lists mail and shows it safely.

```ts
const { data: page } = await mail.inbound.list({ kind: "message" });
const msg = (await mail.inbound.get(page!.data[0].id)).data!;
await mail.emails.send({ template: "support_reply", to: msg.from!.address, inReplyTo: msg.id, variables: { … } });
```

`inReplyTo` accepts a Message-ID or an `in_…` id. It adds `In-Reply-To` and `References` (DKIM-signed) so mail clients thread your reply. Replies still go through the template, the gate and the ledger like any other send; there is no free-form reply body.

## What is checked on the way in

- **Recipients**: only your domains are accepted. Everything else gets `550 5.7.1 Relay access denied`; Sealpost never relays.
- **DKIM**: the first `DKIM-Signature` is verified against the sender's published key (`pass`, `fail`, `none`, `temperror`). SPF and DMARC are **not** evaluated; treat the result as one signal, not proof of sender identity. Messages with non-UTF-8 8-bit bodies are stored but not DKIM-verified.
- **Limits**: size (`maxMessageMb`, also enforced from the `SIZE=` parameter), 50 recipients, 10 connections per address, 200 in total, 50 messages and 5 minutes per session, 60 s idle, 10 protocol errors.
- **Bytes**: the original message is stored untouched (`.eml`); 8-bit content survives.
- **Parsing**: nesting is capped at 10 levels and 300 parts; unknown charsets and broken boundaries are reported in `problems`, never fatal.

## Showing received mail safely

Received content is attacker-controlled. The Studio renders HTML in an iframe with `sandbox=""` and a CSP that blocks all remote loads (no tracking pixels fire when you open a message), and downloads attachments as opaque files. If you render it yourself, do the same. The API serves attachments with `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: sandbox`, and anything a browser could execute (HTML, SVG, unknown types) as `application/octet-stream`.

## Limits of this version

- No SPF/DMARC evaluation and no spam scoring or greylisting. Put a spam filter in front if you publish an MX for a busy mailbox.
- No per-address mailboxes, forwarding rules or catch-all routing; use the `email.received` webhook for that.
- The same message delivered twice is stored twice.
- Storage is one file pair per message; listing scans the folder. Fine for thousands, not millions.
- A change to `inbound` needs a server restart.
