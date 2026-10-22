# Guide: from `init` to production

## 1. Scaffold

```bash
sealpost init my-mail && cd my-mail
sealpost validate
```

`init` writes `sealpost.config.json`, five templates (magic link/OTP, wire invoice, incident alert, team invitation, usage-cap warning) and generates two keys in `.sealpost/` (mode `0600`): an RSA-2048 DKIM key and an ECDSA P-256 receipt key.

## 2. Compile and gate

```bash
sealpost compile magic_link_otp_verification            # BLOCKED: required variables missing (exit 2)
sealpost compile magic_link_otp_verification --auto-fill
sealpost compile magic_link_otp_verification --auto-fill --mime   # print the DKIM-signed message
```

## 3. Send to the local sink

```bash
sealpost send magic_link_otp_verification --to you@example.org --auto-fill
```

With `transport: "sink"` Sealpost starts a loopback SMTP server, talks to it over a real socket, verifies the DKIM signature on arrival, and stores the message in `.sealpost/inbox/`. Sending the identical message again is blocked by EW-108.

## 4. Open the Studio

```bash
sealpost studio --open     # http://127.0.0.1:4320
```

| Page | Shortcut | What it does |
| --- | --- | --- |
| Overview | ⌘1 | Delivery and engagement for the last 14 days, a setup checklist, recent emails and replies |
| Studio | ⌘2 | Block editor with desktop, mobile, plain-text and raw MIME previews; **Import** from MJML, React Email or HTML |
| Send | ⌘3 | The gate, dispatch, SMTP transcript and the test inbox |
| Broadcasts | ⌘4 | Audiences, scheduled sends and webhook status |
| Logs | ⌘5 | Every email sent (status timeline, opens, clicks, replies) and every message received |
| Ledger | ⌘6 | Signed receipts, chain verification, tamper simulation |
| Domains | ⌘7 | Domains, DNS records with live checks, mailboxes, suppressions |
| Setup | ⌘8 | The first-run wizard (shown until the relay is configured) |
| Developers | ⌘9 | Copy-paste SDK and embed code |
| Settings | ⌘, | Theme, accent, density, workspace import and export |

Press ⌘K anywhere for the command bar.

Without the CLI server (for example the static site opened on its own) the Studio runs in a **local demo mode**: delivery is captured in your browser and labelled simulated. It cannot open SMTP sockets.

## 4b. First-run wizard

On a fresh install, the Studio opens a **Setup** tab: domain and From address, relay (presets for SES, Postmark, SendGrid, Mailgun or any SMTP server, with a login test that sends nothing), DNS records with Copy buttons and automatic re-checking, a real test send, and a paste-the-original check that tells you what Gmail or Outlook decided about DKIM, SPF and DMARC. After that, the **Logs** tab shows every email with its timeline.

## 5. Go live

Follow [CUSTOM_DOMAIN_SETUP.md](CUSTOM_DOMAIN_SETUP.md), switch `transport` to `smtp`, and add mailboxes.

## 6. Receipts and the ledger

```bash
sealpost ledger list
sealpost ledger verify                       # exit 2 if any line was altered
sealpost receipt verify evw_4ca0b9d1b917d00c
sealpost receipt verify receipt.json --eml message.eml
```

## 7. Bounces, retries, suppression

A hard bounce (550/551/553/554) suppresses the recipient. Temporary failures queue the already-signed message and retry after 10 s, 1 min, 5 min. Inspect with `sealpost queue list`, force with `sealpost queue run`, manage with `sealpost suppress …`.

## 8. Tracking

Set `trackingBaseUrl` to a public URL. Opens are a 1×1 GIF, clicks go through `/c/<id>?u=…` and only redirect to links recorded for that message. Events land in `.sealpost/events.jsonl` and `GET /api/events`.

## 9. Docker

```bash
export SEALPOST_API_KEY="$(openssl rand -hex 24)"
docker compose up -d
```

The first start scaffolds a project inside the `sealpost-data` volume. Edit its `sealpost.config.json` (for example with `docker compose exec sealpost sh`), pass relay and webhook secrets through the environment (see `docker-compose.yml`), and run `docker compose exec sealpost sealpost doctor`.
