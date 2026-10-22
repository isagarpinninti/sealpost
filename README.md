<div align="center">

# Sealpost

**The self-hosted, UI-native email operating system, with a zero-dependency SMTP/DKIM engine.**

Design an email visually, run it through an eight-check deliverability gate, sign it with real RFC 6376 DKIM, deliver it over a raw SMTP socket, and keep a tamper-evident, cryptographically receipted ledger of every send. No nodemailer, no SaaS, no per-email fee.

[![CI](https://github.com/isagarpinninti/sealpost/actions/workflows/ci.yml/badge.svg)](https://github.com/isagarpinninti/sealpost/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@sealpost/cli?label=%40sealpost%2Fcli)](https://www.npmjs.com/package/@sealpost/cli)
[![license](https://img.shields.io/badge/license-MIT-black)](LICENSE)

</div>

<p>
<a href="docs/GETTING_STARTED.md">Getting started</a> ·
<a href="docs/README.md">Docs</a> ·
<a href="CHANGELOG.md">Changelog</a> ·
<a href="CONTRIBUTING.md">Contributing</a>
</p>

## Quick start

Requires Node.js 20 or newer.

```bash
npx @sealpost/cli init my-mail && cd my-mail
npx @sealpost/cli send magic_link_otp_verification --to you@example.org --auto-fill
npx @sealpost/cli studio --open
```

The default transport is a loopback **SMTP sink**, so the whole pipeline (compile, gate, MIME, DKIM, SMTP, receipt, ledger) runs end to end on your laptop without touching the internet.

## Contents

[Why](#why) · [Packages](#packages) · [How it works](#how-it-works) · [The gate](#the-pre-flight-gate) · [Use the SDK](#use-the-sdk) · [Deploy](#deploy) · [Docs](#docs) · [Security](#security-notes) · [Limits](#honest-limits) · [Develop](#develop)

## Why

| Pain | Sealpost |
| --- | --- |
| Email is a SaaS tax: per-email pricing, vendor lock-in, a dashboard you cannot embed | Self-hosted. Your SMTP mailboxes, your DNS, your data |
| Hand-written table HTML breaks in Outlook | Blocks compile to table-based, inline-styled HTML plus a plain-text part |
| Sends fail silently into spam | Pre-flight gate `EW-101`…`EW-108` blocks a bad send **before a socket opens** |
| DKIM/SPF/DMARC is folklore | Real RFC 6376 signing, verify-at-the-sink, and the exact DNS records generated for you |
| Retries double-send | Idempotency key: the same template, recipient and variables never goes out twice |
| "Delivered?" is a guess | Every send gets an `evw_` ECDSA P-256 receipt chained into a hash-linked ledger |
| One brand per install | Several sending domains, each with its own DKIM key, selected per send |
| No campaigns without another SaaS | Audiences, CSV import and scheduled, rate-limited broadcasts |
| Your app has to poll for results | Signed, retried webhooks for delivery, bounce, complaint, open and click |
| Bounces never reach your app | Relay webhooks (SES, SendGrid, Postmark, Mailgun) feed the suppression list and the stats |
| Transactional engines drag in a dependency tree | `@sealpost/core` has **zero runtime dependencies**; MIME, DKIM and SMTP are written against RFCs |
| Variable typos reach customers | Undeclared or missing `{{variables}}` fail EW-101; values are HTML-escaped |

## Packages

| Package | What it is |
| --- | --- |
| [`@sealpost/core`](packages/core) | Zero-dependency compiler, pre-flight gate, MIME, DKIM sign/verify, receipts, ledger, suppression |
| [`@sealpost/react`](packages/react) | `VisualEmailStudio`, `DeliverabilityPreflightGate`, `DomainMailboxVault`, `SmtpTranscriptInspector` |
| [`@sealpost/sdk`](packages/sdk) | Zero-dependency TypeScript client with Resend-style `{ data, error }` results |
| [`sdks/python`](sdks/python), [`sdks/go`](sdks/go), [`sdks/ruby`](sdks/ruby), [`sdks/php`](sdks/php) | The same client for Python, Go, Ruby and PHP |
| [`@sealpost/cli`](packages/cli) | `sealpost` binary: raw SMTP client with failover and retry queue, sink, tracking, Studio server |

## How it works

```text
 template (blocks + {{variables}})
        │  compile → table-based HTML + plain text
        ▼
 pre-flight gate EW-101…108 ──blocked──▶ nothing is sent
        │ pass
        ▼
 MIME + RFC 6376 DKIM signature
        │
        ▼
 raw SMTP (your mailboxes, failover, retry queue) ──▶ recipient
        │
        ▼
 evw_ receipt  →  hash-chained ledger  →  logs, webhooks, stats
```

Studio, the REST API, schedulers, the optional inbound MX listener and the SMTP submission listener run in one `sealpost studio` process. State lives in `.sealpost/` or, for several instances, in Postgres.

## What it looks like

```text
$ sealpost compile magic_link_otp_verification --to you@example.org
BLOCKED  deliverability score 40/100
  ✖ EW-101 Required variable “userName” is missing. …
  ✔ EW-102 No CR/LF/NUL injection and every address is well-formed.
  ✔ EW-103 From domain mail.example.com aligns with mail.example.com.
  ✖ EW-104 Unsafe or unresolved link(s): btn → {{signInUrl}}.
  …
$ echo $?
2

$ sealpost send magic_link_otp_verification --to you@example.org --auto-fill
✔ Delivered via 127.0.0.1:50975  250 2.0.0 Ok: queued as e1ecd224f7102284
  receipt   evw_4ca0b9d1b917d00c  ledger #1

$ sealpost send … (same again)
✖ EW-108 This exact send (template, recipient, variables) was already dispatched
✖ BLOCKED by the pre-flight gate: no socket was opened.

$ sealpost ledger verify
✔ Chain intact across 1 record(s). Chain and every delivery receipt verified.
```

## The pre-flight gate

| Check | Guards against |
| --- | --- |
| EW-101 | Missing, undeclared or mistyped variables; token parity between subject and body |
| EW-102 | CR/LF/NUL header injection and malformed addresses |
| EW-103 | From domain not aligned with the configured sending domain (DMARC) |
| EW-104 | `javascript:`/`data:` links and unresolved `{{tokens}}` in URLs |
| EW-105 | Subject length, empty or oversized preheader |
| EW-106 | Spam-trigger phrases, low text-to-HTML ratio |
| EW-107 | Recipients on the suppression list |
| EW-108 | Duplicate sends (SHA-256 idempotency key over template, sorted recipients, variables) |

Score is 100 minus 30 per block and 8 per warning. `BLOCKED` stops the send; `compile` exits `2`.

## First-run wizard and logs

A fresh Studio opens a five-step setup (domain, relay, DNS with live re-checking, real test send, authentication check). The **Logs** tab then shows every email with its delivery, bounce, complaint, open and click timeline, filterable by status, recipient and tag. The same data is at `GET /api/emails`, in the SDKs and in `sealpost logs`.

## More ways in, more ways to run

- **SMTP submission:** let WordPress, Laravel or any SMTP-only app send through Sealpost (DKIM, failover, suppression, receipts): [SMTP submission](docs/SMTP_SUBMISSION.md).
- **Scheduled sends and hosted unsubscribe:** `sealpost send --at …` / `scheduledAt`, one-click unsubscribe pages and RFC 8058 headers, a per-minute send limit.
- **API keys:** scopes (`send`, `read`, `write`), expiry, revocation, and an audit log of every change and failed sign-in.
- **Postgres and several processes:** a shared database with cross-process locking and leases: [Postgres storage](docs/POSTGRES.md).
- **For AI assistants:** `sealpost mcp` exposes read tools, and an opt-in send tool, over MCP: [Sealpost for AI assistants](docs/MCP.md).

## Import what you already have

```bash
sealpost template import welcome.mjml      # MJML, a React Email .tsx file, or any email HTML
```

Blocks, variables, theme and preheader are mapped, a live preview shows the result before it is added, and anything that could not be carried over is listed. JSX is read, never executed. See [Importing templates](docs/IMPORT.md).

## Receiving email

Run Sealpost as your MX target (or have your relay forward mail to it) and replies, bounces and abuse reports are parsed and stored. Replies appear on the original email's timeline, verified bounces and complaints suppress the address automatically, and `email.received` webhooks tell your app. Forged reports are ignored. You can reply in-thread with `inReplyTo`. See [Receiving email](docs/INBOUND.md).

## Use the SDK

```ts
import { Sealpost } from "@sealpost/sdk";

const mail = new Sealpost({ apiKey: process.env.SEALPOST_KEY!, baseUrl: "https://mail.yourdomain.com" });
const { data, error } = await mail.emails.send({ template: "magic_link_otp_verification", to: "user@example.org", idempotencyKey: "signup-42", tags: [{ name: "campaign", value: "welcome" }], variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" } });
if (error) console.error(error.code, error.preflight?.gate); // nothing was sent when code === "preflight_blocked"
else console.log(data.messageId, data.receipt);              // evw_… receipt
```

Also `emails.batch` (up to 100), `emails.preview`, `stats.get`, `events.list`, `suppressions.*`, `receipts.verify`, `ledger.verify`. The full REST surface is described by an OpenAPI 3.1 document at `/api/openapi.json`.

## One install, many brands

```bash
sealpost domain add news.example.org --from news@news.example.org --name "Acme News" --selector n1
sealpost domain check                    # live SPF / DKIM / DMARC lookup for every domain
sealpost send workspace_team_invitation --to you@example.org --auto-fill --domain news.example.org
```

Every domain has its own From identity, DKIM selector and key, and its mail is verified end to end at the sink with the right key.

## Audiences and broadcasts

```bash
sealpost audience create "Customers" && sealpost audience import aud_… people.csv
sealpost broadcast create "Launch" --audience aud_… --template workspace_team_invitation --at 2026-11-01T09:00:00Z --rate 300
```

Scheduled, rate-limited, restart-safe sends to a list, with suppressed contacts skipped automatically. See [Audiences and broadcasts](docs/AUDIENCES_AND_BROADCASTS.md).

## Webhooks to your own app

```bash
sealpost webhook add app --url https://app.example.com/hooks/sealpost --secret-env SEALPOST_WHSEC
```

`email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `broadcast.completed` and more, HMAC-signed, persisted and retried for hours. See [Webhooks](docs/WEBHOOKS.md).

## SDKs

| Language | Install | Notes |
| --- | --- | --- |
| TypeScript / JavaScript | `npm i @sealpost/sdk` | Node 18+, browsers, Deno, Bun, edge |
| Ruby 2.6+ | `gem install sealpost` (source: [`sdks/ruby`](sdks/ruby)) | standard library only |
| PHP 7.4+ | `composer require sealpost/sealpost` (source: [`sdks/php`](sdks/php)) | needs ext-curl; not yet run by its author |
| Python 3.8+ | `pip install sealpost` (source: [`sdks/python`](sdks/python)) | standard library only |
| Go 1.20+ | `go get github.com/isagarpinninti/sealpost/sdks/go` | standard library only |

## Close the feedback loop

Point your relay's webhooks at Sealpost and bounces and complaints suppress recipients automatically:

```bash
export SEALPOST_WEBHOOK_SECRET="$(openssl rand -hex 24)"
# SES (via SNS HTTPS), SendGrid, Postmark and Mailgun are supported
#   POST https://mail.yourdomain.com/hooks/relay/<ses|sendgrid|postmark|mailgun>?token=$SEALPOST_WEBHOOK_SECRET
```

`GET /api/stats` then reports sent, opens, clicks, bounces, complaints and the rates.

## Deploy with Docker

```bash
export SEALPOST_API_KEY="$(openssl rand -hex 24)"
docker compose up -d        # http://localhost:4320, signed in with SEALPOST_API_KEY
```

The first start scaffolds a project in a volume. Back that volume up: it holds your DKIM private keys. (The Dockerfile and compose file have not been exercised on a Docker host yet.)

## Use it in a React app

```tsx
import { VisualEmailStudio, DeliverabilityPreflightGate } from "@sealpost/react";
import "@sealpost/react/styles.css";
import { evaluateDispatchPreflight, TEMPLATE_PACKS } from "@sealpost/core";
```

See [docs/CLI_AND_EMBEDDING.md](docs/CLI_AND_EMBEDDING.md) for the full props and a working example.

## Use the engine from code

```ts
import { evaluateDispatchPreflight, composeSignedMessage, createDkimKeyPair } from "@sealpost/core";
// evaluateDispatchPreflight(request, { template, domain }) -> composeSignedMessage({ preflight, domain, privateKey, … })
```

`composeSignedMessage` is the same function the CLI and the browser demo use: preflight, MIME, DKIM.

## Docs

- [Getting started](docs/GETTING_STARTED.md): ten minutes from zero to a sent email, then your own domain
- [Guide](docs/GUIDE.md): a walkthrough from `init` to production
- [Docs index](docs/README.md): every document by task
- [Real-world test](docs/REAL_WORLD_TEST.md): prove it against Gmail and Outlook with `sealpost doctor` and `sealpost auth-check`
- [Custom domain setup](docs/CUSTOM_DOMAIN_SETUP.md): SPF, DKIM, DMARC, MX and real mailboxes
- [MIME, DKIM and SMTP spec](docs/MIME_DKIM_SMTP_SPEC.md): exactly what bytes go on the wire
- [CLI and embedding](docs/CLI_AND_EMBEDDING.md): every command, the REST API, the React primitives
- [Postgres storage](docs/POSTGRES.md), [SMTP submission](docs/SMTP_SUBMISSION.md), [Sealpost for AI assistants](docs/MCP.md), [Importing templates](docs/IMPORT.md), [Receiving email](docs/INBOUND.md), [Audiences and broadcasts](docs/AUDIENCES_AND_BROADCASTS.md), [Webhooks](docs/WEBHOOKS.md)
- [Publishing](docs/PUBLISHING.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

## Deploy

```bash
export SEALPOST_API_KEY="$(openssl rand -hex 24)"
docker compose up -d        # http://localhost:4320
```

Put it behind HTTPS and back up the data volume (it holds your DKIM private keys). See the [Guide](docs/GUIDE.md#9-docker) and [Postgres storage](docs/POSTGRES.md) for multi-instance setups.

## Security notes

- STARTTLS is never silently downgraded; credentials are refused over plaintext to non-private hosts.
- SMTP passwords are never stored. A mailbox names an environment variable (`passwordEnv`) instead.
- Private and loopback targets are refused unless `allowPrivateNetworks` is set (SSRF guard, enforced for IP literals and resolved hostnames).
- Studio refuses to bind a non-loopback address without an API key. Click tracking redirects only to URLs recorded for that message.
- Keys live in `.sealpost/` with mode `0600`. That directory is git-ignored.

## Honest limits

- The browser-only demo cannot open SMTP sockets; delivery there is captured locally and flagged simulated. Its DKIM key lives in your browser's IndexedDB.
- Deliverability still depends on your domain's reputation and DNS. Sealpost gets the protocol side right; it cannot warm an IP for you.
- Storage is document-style (files on disk or in Postgres), which suits tens of thousands of records rather than millions.
- It is a sender, not a mailbox host: there are no mailboxes or IMAP, inbound mail has no SPF/DMARC evaluation or spam scoring, and broadcasts are a sender-side scheduler, not a marketing suite (no segmentation, A/B tests or drag-and-drop campaign analytics).
- Sealpost does not own sending IPs. Inbox placement depends on the relay and domain reputation you bring; there is no hosted dashboard, multi-tenant accounts or compliance certification.
- Relay webhooks are authenticated by a shared token. SNS message signatures are not verified, and SNS subscription confirmation URLs are surfaced, never fetched automatically.

## Develop

```bash
npm install
npm run ci      # build packages, studio, lint, typecheck, test, smoke
npm run dev     # Studio on http://localhost:3000 (local demo mode)
```

## Project layout

```text
packages/core    compiler, gate, MIME, DKIM, receipts (zero dependencies)
packages/cli     the `sealpost` binary, REST API, SMTP engine, schedulers
packages/react   embeddable Studio components
packages/sdk     TypeScript client
sdks/            Python, Go, Ruby and PHP clients
src/             Studio (Next.js, exported statically into the CLI)
docs/  examples/  scripts/
```

## License

MIT © Sagar Pinninti. See [LICENSE](LICENSE).
