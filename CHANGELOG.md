# Changelog

## Unreleased

- API keys with scopes (`send`, `read`, `write`) and expiry, runtime create/revoke, `sealpost auth list|revoke`, and an audit log (`GET /api/audit`, `sealpost audit`, Studio Settings).
- Scheduled single sends (`scheduledAt`, `sealpost send --at`, `sealpost scheduled`), a per-minute send limit (`limits.sendsPerMinute`).
- Hosted one-click unsubscribe (`/u/<token>`, RFC 8058), `POST /api/unsubscribe-link`, `email.unsubscribed` webhook.
- SMTP submission server: apps send over SMTP (AUTH with an API key) and get DKIM, failover, suppression, receipts and logs.
- `sealpost mcp`: a Model Context Protocol server (read tools; `send_email` only with `--allow-send`).
- Postgres storage (`storage.type: "postgres"`, `sealpost storage migrate`) with cross-process locking, leases for queue, webhooks, broadcasts and scheduled sends, and shared idempotency reservations, tested against a real Postgres.
- Ruby and PHP SDKs; scheduling and unsubscribe links in the TypeScript, Python and Go SDKs.

- Template import from MJML, React Email (JSX read statically, never executed) and HTML: `sealpost template import`, `POST /api/import`, and an Import dialog with live preview in the Studio. New `image` block (editor, compiler, gate). `importTemplate` in core.
- A new interface: sidebar navigation, an Overview dashboard (stats, 14-day chart, recent activity, setup checklist), refreshed typography, surfaces, buttons, badges and empty states, a responsive layout with a mobile drawer, and a lighter, more neutral palette in both themes. `GET /api/stats/timeseries`.

- Inbound email: an MX-facing SMTP listener (STARTTLS, size/recipient/connection limits, no relaying), a relay webhook (`/hooks/inbound/raw` for SES/SNS, SendGrid, Mailgun or a plain POST), `sealpost inbound import`, a tolerant MIME parser in core (`parseMimeMessage`, RFC 2047/2231, charsets, attachments), DKIM verification of received mail, `GET /api/inbound…`, `sealpost inbound`, SDK `inbound.*`, Studio **Logs → Received**, `email.received` webhook, retention.
- Delivery reports (DSN) and abuse reports (ARF) are parsed and, when they match mail this server sent, suppress the recipient and update the email's timeline. Replies join the original email's timeline (`replied`).
- `inReplyTo` on sends builds DKIM-signed In-Reply-To/References headers.
- MX records are published from `inbound.mxHost` and verified by `sealpost domain check` and `sealpost doctor`.

- API: `Idempotency-Key` header with replay, `tags` and `metadata` on sends, `id` on every send, `GET /api/emails` (filters, cursor pagination) and `GET /api/emails/{id}` with a status timeline, stable error `code` and `requestId` on every error, `Retry-After` on 429.
- `sealpost logs` and the Studio **Logs** tab.
- Studio first-run **Setup** wizard; `PUT /api/setup`, `POST /api/doctor`, `POST /api/auth-check`.
- All three SDKs: idempotency key and replay flag, tags, metadata, `emails.get`, `emails.list`, request ids.

- `sealpost doctor`: relay login probe (no mail sent), live DNS, tracking, unsubscribe and webhook-secret checks, optional real test send.
- `sealpost auth-check` and `analyzeAuthenticationResults`: parse a receiving inbox's `Authentication-Results` into DKIM/SPF/DMARC verdicts with fixes.
- Docker: multi-stage Dockerfile built from source, `docker-compose.yml`, first-start scaffolding.
- `docs/REAL_WORLD_TEST.md`.

- Multiple sending domains in one install: `domains` in the config, `sealpost domain add|list|remove|check`, per-domain DKIM keys, `domain` on sends, broadcasts and the API, live DNS verification (`checkDnsRecords`).
- Audiences and broadcasts: CSV import, scheduled and rate-limited sends, restart-safe cursor, suppressed contacts skipped; Studio view (⌘7).
- Outbound webhooks to your app with HMAC `Sealpost-Signature`, a persistent outbox and retries (10 s → 2 h); `signWebhookPayload` / `verifyWebhookSignature` in core.
- Python (`sdks/python`) and Go (`sdks/go`) SDKs.

- `@sealpost/sdk`: zero-dependency client with Resend-style `{ data, error }` results (send, batch, preview, stats, events, suppressions, receipts, ledger).
- Relay feedback webhooks for SES, SendGrid, Postmark and Mailgun at `/hooks/relay/<provider>`; hard bounces and complaints suppress recipients; new event types.
- `POST /api/send/batch`, `GET /api/stats`, `GET /api/openapi.json` (OpenAPI 3.1).
- `parseRelayEvents` in `@sealpost/core`.

## 0.1.0

Initial release.

- `@sealpost/core`: block compiler, EW-101…108 pre-flight gate, RFC 5322/2045 MIME, RFC 6376 DKIM sign and verify, DNS record synthesis, `evw_` receipts, hash-chained ledger, suppression engine, five template packs.
- `@sealpost/react`: `VisualEmailStudio`, `DeliverabilityPreflightGate`, `DomainMailboxVault`, `SmtpTranscriptInspector`, scoped stylesheet.
- `@sealpost/cli`: raw SMTP client (STARTTLS, implicit TLS, AUTH PLAIN/LOGIN), multi-mailbox failover, persistent retry queue, loopback sink, open/click tracking, REST API and bundled Studio.
