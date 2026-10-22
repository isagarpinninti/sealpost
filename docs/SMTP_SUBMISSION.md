# SMTP submission: send from any app that speaks SMTP

Plenty of software only knows how to send mail over SMTP (WordPress, Laravel's mailer, `sendmail` replacements, legacy apps). Sealpost can accept that mail, sign it, and deliver it through your relay with the same bookkeeping as an API send.

```json
"submission": { "enabled": true, "host": "127.0.0.1", "port": 2587 }
```

```bash
export SEALPOST_API_KEY="$(openssl rand -hex 24)"      # or: sealpost auth add-key wordpress --scope send
sealpost studio
```

Point the application at the server:

| Setting | Value |
| --- | --- |
| Host / port | your Sealpost host, `2587` (or 465 with `"implicitTls": true`) |
| Security | STARTTLS (or TLS on 465) |
| Username | anything (`sealpost`) |
| Password | an API key with the `send` scope, or the master key |

## What happens to a message

1. The sender authenticates with an API key. A key without the `send` scope is refused.
2. **From must be on one of your configured domains** (the same guarantee as the gate's domain-alignment check), otherwise `550 5.7.1`.
3. Recipients on the suppression list are refused at `RCPT` with `550 5.7.1`.
4. Sealpost strips `Bcc`, `Return-Path`, any `Received` header and any existing `DKIM-Signature`, adds `Message-ID` and `Date` if missing, and **signs with the domain's DKIM key**.
5. It is delivered through your mailboxes with failover, queued for retry on a temporary failure, rate-limited by `limits.sendsPerMinute`, and sealed into the ledger with an `evw_` receipt. It appears in the Logs (tagged `source:smtp-submission`) and fires `email.delivered` / `email.bounced` webhooks.
6. A client that retries a message with the same `Message-ID` to the same recipients is acknowledged but not sent again.

## What it does not do

- **No template gate.** The body is whatever the application wrote, so the content checks EW-101 to EW-106 do not apply; sender alignment, suppression and de-duplication do. If you need the full gate, send through the API with a template.
- Messages must be UTF-8 (7bit, quoted-printable or base64 bodies are fine; raw 8-bit in another charset is refused with `554 5.6.0`).
- No per-sender quotas beyond the global rate limit, and no open or click tracking for submitted mail (it is not rewritten).

## Safety

- The server **refuses to start** on a non-loopback address without `submission.tls`, because clients send their API key as the SMTP password, and without any API key.
- `AUTH` is advertised only over TLS or to loopback clients.
- The listener caps message size, recipients (100), connections per address, messages per session and idle time.
- Use a dedicated key per application so you can revoke one without touching the others (`sealpost auth add-key wordpress --scope send --expires 365`).
