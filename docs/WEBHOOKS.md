# Webhooks to your app

Sealpost can notify your application about what happens to your mail. Deliveries are **signed**, **persisted** and **retried**.

## Configure

```bash
sealpost webhook add app --url https://app.example.com/hooks/sealpost --secret-env SEALPOST_WHSEC --events "email.*,broadcast.completed"
export SEALPOST_WHSEC="$(openssl rand -hex 32)"      # the signing secret; never stored in the config file
sealpost webhook test app                             # sends a webhook.ping and reports the result
```

Or in `sealpost.config.json`:

```json
"webhooks": [{ "id": "app", "url": "https://app.example.com/hooks/sealpost", "events": ["email.*", "broadcast.completed"], "secretEnv": "SEALPOST_WHSEC" }]
```

`events` accepts exact names, a family such as `email.*`, or `*`. Up to 10 endpoints.

## Events

| Type | When | `data` |
| --- | --- | --- |
| `email.delivered` | The relay accepted the message (or, with `source`, the relay reported delivery) | `messageId`, `to`, `templateId`, `domain`, `receiptId` |
| `email.queued` | Temporary failure; queued for retry | `messageId`, `to`, `templateId`, `domain`, `error` |
| `email.failed` | Permanent failure or retries exhausted | `messageId`, `to`, `templateId`, `domain`, `error` |
| `email.bounced` | Hard bounce; the address is now suppressed | `email`, `source` (`smtp`, `inbound` for a verified delivery report, or the relay name), `detail` |
| `email.deferred` | Soft bounce reported by the relay | `email`, `source`, `detail` |
| `email.complained` | Spam complaint reported by the relay; the address is suppressed | `email`, `source` |
| `email.received` | A message arrived (SMTP listener, relay webhook or import) | `id` (`in_…`), `kind` (`message`, `bounce`, `complaint`), `autoReply`, `from`, `to`, `subject`, `snippet`, `hasHtml`, `attachments`, `dkim`, `threadEmailId`, `reportVerified`, `source` |
| `email.opened` | Tracking pixel loaded | `messageId`, `to`, `templateId` |
| `email.clicked` | A tracked link was followed | `messageId`, `to`, `templateId`, `url` |
| `broadcast.started` | A scheduled broadcast began | `broadcastId`, `name`, `total` |
| `broadcast.completed` | Every contact processed | `broadcastId`, `name`, `counts` |
| `webhook.ping` | `sealpost webhook test` | `message` |

Body envelope:

```json
{ "id": "evt_3f9c…", "type": "email.delivered", "createdAt": "2026-10-22T09:14:02.000Z", "data": { "messageId": "<…>", "to": "user@example.org", "templateId": "magic_link_otp_verification", "domain": "mail.example.com", "receiptId": "evw_…" } }
```

Headers: `Sealpost-Signature`, `Sealpost-Event-Id` (same `id` on every retry: de-duplicate on it), `Sealpost-Event-Type`.

## Verifying the signature

`Sealpost-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Verify against the **raw** body, before parsing JSON, and reject timestamps more than 5 minutes old.

```ts
import { verifyWebhook } from "@sealpost/sdk";
const body = await req.text();
const { ok } = await verifyWebhook(process.env.SEALPOST_WHSEC!, body, req.headers.get("sealpost-signature"));
if (!ok) return new Response("bad signature", { status: 401 });
```

```python
from sealpost import verify_webhook
ok, reason = verify_webhook(SECRET, request.get_data(), request.headers.get("Sealpost-Signature"))
```

```go
body, _ := io.ReadAll(r.Body)
if err := sealpost.VerifyWebhook(secret, body, r.Header.Get(sealpost.SignatureHeader), 0, time.Time{}); err != nil { /* 401 */ }
```

## Delivery guarantees

- Events are written to `.sealpost/webhook-outbox.json` before the API call that caused them returns, so a crash does not lose them.
- Respond with any `2xx` within 8 seconds. Anything else retries after 10 s, 1 min, 5 min, 30 min and 2 h; after the sixth failure the delivery is marked `failed` (visible in `sealpost webhook log` and the Studio).
- Delivery is at-least-once. Use `Sealpost-Event-Id` to de-duplicate.
- Redirects are not followed, and endpoints resolving to private or loopback addresses are refused unless `allowPrivateNetworks` is set.
- The retry worker runs inside `sealpost studio`. Without it, run `sealpost webhook run`.
