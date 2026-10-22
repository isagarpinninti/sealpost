# CLI, REST API and embedding

## CLI

Every command accepts `--dir <path>` (default `.`) and `--json`. Exit codes: `0` success, `1` error, `2` blocked by the gate or a failed verification.

| Command | Purpose |
| --- | --- |
| `init [dir]` | Scaffold config, 5 templates, DKIM (RSA-2048) and receipt (ECDSA P-256) keys |
| `template import <file> \| list` | Import MJML, React Email (.tsx) or HTML as a template (`--format --id --name --category --force --dry-run`; see [IMPORT.md](IMPORT.md)) |
| `auth add-key\|list\|revoke`, `audit` | API keys with scopes (`send`, `read`, `write`) and expiry; the audit log of writes and failed sign-ins |
| `scheduled list\|cancel\|run`, `send --at <ISO>` | Sends scheduled for later (up to 90 days) |
| `storage status\|migrate` | Where state lives; copy `.sealpost/` into Postgres (see [POSTGRES.md](POSTGRES.md)) |
| `mcp [--allow-send]` | Model Context Protocol server for AI assistants (see [MCP.md](MCP.md)) |
| `inbound list\|show\|raw\|attachment\|import\|delete` | Received mail (see [INBOUND.md](INBOUND.md)): filter with `--from --to --q --kind`, save attachments, import a `.eml` |
| `logs [show <em_id>]` | What happened to each email: status timeline, opens, clicks, tags. Filters `--status --to --tag name:value --template --domain --limit --before` |
| `doctor [--send you@gmail.com]` | Pre-launch check: relay login (nothing sent), live DNS, tracking and unsubscribe settings, webhook secrets. Exit 2 on blocking problems; `--send` then sends one real test email |
| `auth-check <file.eml>` | Reads the `Authentication-Results` a receiving inbox added and reports DKIM, SPF and DMARC with plain-language fixes. Exit 2 unless all pass |
| `validate [dir]` | Validate config and templates |
| `dns [dir]` | Print SPF, DKIM, DMARC, MX records |
| `dns --domain <d>`, `send --domain <d>` | Act on one of several sending domains |
| `compile <templateId>` | Compile and run EW-101…108. `--var k=v`, `--to`, `--auto-fill`, `--mime` |
| `send <templateId> --to <email>` | Compile, sign, send, seal. `--cc`, `--bcc`, `--var`, `--auto-fill` |
| `domain list\|add\|remove\|check` | Several sending domains; `check` does a live SPF/DKIM/DMARC lookup (exit 2 if wrong) |
| `audience create\|list\|show\|add\|import\|remove\|delete` | Contact lists; `import` reads a CSV |
| `broadcast create\|list\|show\|cancel\|run` | Scheduled sends to an audience: `--audience`, `--template`, `--at`, `--rate`, `--domain`, `--var` |
| `webhook list\|add\|remove\|test\|log\|run` | Signed event webhooks to your app (see [WEBHOOKS.md](WEBHOOKS.md)) |
| `studio [dir]` | Studio + REST API + test inbox on `127.0.0.1:4320`. `--host`, `--port`, `--open` |
| `ledger verify|list` | Verify or list the delivery ledger |
| `receipt verify <file\|evw_…>` | Verify offline. `--eml message.eml` also checks the MIME hash |
| `queue list|run` | Show or process the retry queue |
| `suppress list|add|remove [email]` | Manage suppressions (`--reason hard_bounce|unsubscribed|complaint`) |
| `sink [--port 2525]` | Standalone loopback SMTP sink |
| `key show` | Receipt key fingerprint and DKIM public key |
| `auth add-key <label>` | Create an `evk_` API key |

## REST API

Served by `sealpost studio`. Send `Authorization: Bearer evk_…` (or the master `SEALPOST_API_KEY`). The two tracking endpoints are public.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Mode, version, DKIM public key |
| GET / PUT | `/api/workspace` | Config and templates (PUT needs the master key) |
| POST | `/api/compile` | Preview + gate result for a stored or inline template |
| POST | `/api/send` | `{ templateId, to, variables? }`. 201 delivered, 202 queued, 403 `preflight_blocked`, 502 `smtp_failed` |
| GET / DELETE | `/api/inbox`, `/api/inbox/:id` | Test inbox (16-hex ids) |
| GET / POST / DELETE | `/api/suppressions` | Suppression list |
| GET | `/api/ledger`, `/api/ledger/verify` | Ledger and chain check |
| POST | `/api/verify` | Verify a receipt token, optionally with raw MIME |
| GET | `/api/dns` | DNS records |
| GET / POST | `/api/queue`, `/api/queue/run` | Retry queue |
| POST | `/api/send/batch` | `{ emails: [...] }`, 1 to 100 send requests; per-item `delivered`, `queued`, `blocked` or `failed` |
| GET / DELETE | `/api/inbound`, `/api/inbound/{id}`, `/api/inbound/{id}/raw`, `/api/inbound/{id}/attachments/{n}` | Received mail; filters `from`, `to`, `q`, `kind`, `since`, `until`; pages with `limit` and `before` |
| POST | `/hooks/inbound/raw?token=` | A relay posts a received message (needs `SEALPOST_WEBHOOK_SECRET`; 404 without) |
| GET | `/api/emails`, `/api/emails/{id}` | Email records with a status timeline; filters `status`, `to`, `template`, `domain`, `tag`, `since`, `until`; pages with `limit` and `before` (see `hasMore`, `nextCursor`) |
| POST | `/api/doctor`, `/api/auth-check` | Pre-launch checks (admin key); parse a received message's Authentication-Results |
| PUT | `/api/setup` | Save domain, transport and mailboxes immediately (admin key) |
| POST | `/api/import` | Preview importing MJML, React Email JSX or HTML: `{ source, format?, id?, name?, category? }` → `{ template, warnings }`; nothing is saved |
| GET | `/api/stats/timeseries?days=14` | Per-day sent, delivered, bounced, failed, opens, clicks (UTC) |
| GET / POST / DELETE | `/api/keys`, `/api/keys/{id}` | API keys (admin key): create with `{ label, scopes?, expiresInDays? }`, list, revoke with immediate effect |
| GET | `/api/audit?limit=&actor=` | Audit log (admin key): writes and failed sign-ins, with the key, IP and request id |
| GET / DELETE | `/api/scheduled`, `/api/scheduled/{id}` | Scheduled sends; cancel one that has not run |
| POST | `/api/unsubscribe-link` | Mint a hosted one-click unsubscribe URL for an address |
| GET / POST | `/u/{token}` | The public unsubscribe page (GET only shows it; POST, including RFC 8058 one-click, unsubscribes) |
| GET | `/api/stats` | Sent, queued, suppressed, opens, clicks, bounces, complaints, rates |
| GET | `/api/events` | Open, click, delivered, bounce, deferred and complaint events |
| GET | `/api/openapi.json` | OpenAPI 3.1 description (public) |
| GET | `/api/domains`, `/api/domains/{domain}/check` | Sending domains; live DNS lookup |
| GET / POST | `/api/audiences`, `/api/audiences/{id}`, `/api/audiences/{id}/contacts` | Audiences and contacts |
| GET / POST | `/api/broadcasts`, `/api/broadcasts/{id}`, `/api/broadcasts/{id}/cancel` | Broadcasts |
| GET / POST | `/api/webhooks`, `/api/webhooks/deliveries`, `/api/webhooks/{id}/test` | Outbound webhook status |
| POST | `/hooks/relay/<ses\|sendgrid\|postmark\|mailgun>?token=` | Relay feedback; needs `SEALPOST_WEBHOOK_SECRET` (404 without); hard bounces and complaints suppress the recipient |
| GET | `/o/<id>.gif`, `/c/<id>?u=` | Tracking (public; redirects only to URLs recorded for that message) |

```bash
curl -s -X POST http://127.0.0.1:4320/api/send \
  -H "Authorization: Bearer $EVK" -H "Content-Type: application/json" \
  -d '{"templateId":"magic_link_otp_verification","to":["you@example.org"],"variables":{"userName":"Ada","otpCode":"482913","signInUrl":"https://app.example.com/in"}}'
```

## `@sealpost/core`

```ts
import {
  TEMPLATE_PACKS, SAMPLE_DOMAIN, autoFillSampleVariables,
  evaluateDispatchPreflight, composeSignedMessage,
  createDkimKeyPair, verifyDkimSignature,
} from "@sealpost/core";

const template = TEMPLATE_PACKS[0];
const pre = await evaluateDispatchPreflight(
  { to: "user@example.org", variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" } },
  { template, domain: SAMPLE_DOMAIN },
);
if (pre.gate === "BLOCKED") throw new Error(`Blocked at ${pre.score}/100`);
```

Runtime dependency: none. `zod` is a peer dependency (`^3.23.0 || ^4.0.0`).

### Scopes, scheduling and hosted unsubscribe

- **Scopes.** A key has `send` (send, batch, preview), `read` (every GET, verify, import preview) and/or `write` (suppressions, audiences, broadcasts, deleting received mail…). The master key is also admin (keys, audit, workspace). A missing scope is `403 insufficient_scope` with the `requiredScope`. Keys can expire; legacy label-only keys keep every scope.
- **`scheduledAt`** on a send (ISO 8601, up to 90 days ahead) returns `202` with `status: "scheduled"` and an `sch_…` id. The gate runs immediately, so a bad request fails now, and again at send time, so a recipient who unsubscribes in between is honoured. The server's worker sends it.
- **Hosted unsubscribe:** set `"unsubscribe": { "hosted": true }` and a public `trackingBaseUrl`; every email then carries a per-recipient signed link in its footer and `List-Unsubscribe` header (with the RFC 8058 one-click header). The link never expires, GET never changes anything (link scanners are harmless), and the page offers an undo. It adds the address to the suppression list, logs `unsubscribed` on the email and fires `email.unsubscribed`.
- **`limits.sendsPerMinute`** queues sends above the rate instead of dropping them.

### Idempotency, tags and errors

- **`Idempotency-Key` header** on `POST /api/send`: the same key and body within 24 h returns the original response with `Idempotent-Replayed: true` and sends nothing; the same key with a different body is `409 idempotency_key_reuse`. Only successful sends are remembered, so a blocked or failed attempt can be retried with the same key. Concurrent requests with one key collapse into one send.
- **`tags`** (up to 10 `{ name, value }`) and **`metadata`** (up to 20 string keys) on every send, stored with the email record and filterable in `GET /api/emails`.
- **Every send returns an `id`** (`em_…`) for `GET /api/emails/{id}`. `status` is the latest of `queued`, `delivered`, `failed`, `bounced`, `complained`, `deferred`; `events` is the full timeline including opens and clicks.
- **Errors** always carry `{ ok: false, error, code, requestId }`; `requestId` equals the `x-request-id` response header. Codes: `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `idempotency_key_reuse`, `payload_too_large`, `validation_error`, `rate_limited` (with `Retry-After`), `preflight_blocked`, `smtp_failed`, `internal_error`.

## `@sealpost/react`

Peers: `react`, `react-dom`, `lucide-react`. Import the scoped stylesheet once:

```tsx
import "@sealpost/react/styles.css";
import { VisualEmailStudio, DeliverabilityPreflightGate, DomainMailboxVault, SmtpTranscriptInspector } from "@sealpost/react";
```

| Component | Key props |
| --- | --- |
| `VisualEmailStudio` | `template`, `onChange`, `variables`, `onVariablesChange`, `domain?`, `rawMime?`, `readOnly?` |
| `DeliverabilityPreflightGate` | `preflight`, `to`, `onToChange`, `onAutoFill`, `onDispatch`, `dispatching?` |
| `DomainMailboxVault` | `domain`, `onDomainChange`, `dns`, `mailboxes`, `onMailboxesChange`, `transport`, `onTransportChange` |
| `SmtpTranscriptInspector` | `transcript`, `rawMime?`, `receiptToken?`, `dkimPublicKeyJwk?`, `simulated?` |

All styles are scoped under `.ew-root`, so the primitives do not leak into your app. The layout uses container queries, so it adapts to the width of the box you place it in, not the viewport. Previews render inside `sandbox=""` iframes.

```tsx
import { TEMPLATE_PACKS } from "@sealpost/core";

function Editor() {
  const [template, setTemplate] = useState(TEMPLATE_PACKS[0]);
  const [vars, setVars] = useState({});
  return <VisualEmailStudio template={template} onChange={setTemplate} variables={vars} onVariablesChange={setVars} />;
}
```

## `@sealpost/sdk`

```ts
import { Sealpost } from "@sealpost/sdk";
const mail = new Sealpost({ apiKey: "evk_…", baseUrl: "http://127.0.0.1:4320" });
```

Every method resolves to `{ data, error }` and never throws for API or network errors. `error` is `{ status, code?, message, preflight? }`; `status` is `0` for a network failure or timeout. A gate rejection is `error.code === "preflight_blocked"` with the full check list in `error.preflight`, and nothing was sent.

| Method | Endpoint |
| --- | --- |
| `emails.send(opts)` | `POST /api/send` |
| `emails.batch(items)` | `POST /api/send/batch` |
| `emails.preview(opts)` | `POST /api/compile` |
| `emails.get(id)`, `emails.list(filters)` | `GET /api/emails…` |
| `inbound.list/get/raw/attachment/delete` | `/api/inbound…` |
| `stats.get()` | `GET /api/stats` |
| `events.list()` | `GET /api/events` |
| `suppressions.list/add/remove` | `/api/suppressions` |
| `receipts.verify(token, inboxId?)` | `POST /api/verify` |
| `ledger.verify()` | `GET /api/ledger/verify` |
| `domains.list()`, `domains.check(d)` | `/api/domains` |
| `audiences.create/list/get/addContacts/removeContact/delete` | `/api/audiences…` |
| `broadcasts.create/list/get/cancel` | `/api/broadcasts…` |
| `webhooks.verify(secret, rawBody, header)`, `webhooks.test(id)`, `webhooks.deliveries()` | signature check; `/api/webhooks…` |

The Python (`sdks/python`) and Go (`sdks/go`) clients expose the same calls; see their READMEs.

Safe retries: an identical send inside `dedupeWindowMinutes` is rejected by EW-108, so a client that retries after a timeout cannot double-send.
