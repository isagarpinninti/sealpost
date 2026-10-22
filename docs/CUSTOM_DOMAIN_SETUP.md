# Custom domain setup

Goal: send from `hello@mail.yourdomain.com` so receivers see DKIM, SPF and DMARC all passing and aligned.

## 1. Configure the domain

Edit `sealpost.config.json`:

```json
{
  "domain": {
    "domain": "mail.yourdomain.com",
    "fromName": "Your Product",
    "fromEmail": "hello@mail.yourdomain.com",
    "replyTo": "support@yourdomain.com",
    "dkimSelector": "sealpost",
    "dmarcPolicy": "none",
    "unsubscribeUrl": "https://app.yourdomain.com/unsubscribe",
    "trackingBaseUrl": "https://mail.yourdomain.com"
  }
}
```

Use a **subdomain** (`mail.`) for sending so a reputation problem never touches your root domain. EW-103 blocks any send whose From address is not on `domain`.

## 2. Print the DNS records

```bash
sealpost dns
```

Add the three records at your DNS host (Cloudflare, Namecheap, Route 53, …):

| Type | Name | Value |
| --- | --- | --- |
| TXT (SPF) | `mail.yourdomain.com` | `v=spf1 mx include:_spf.yourprovider.com ~all` |
| TXT (DKIM) | `sealpost._domainkey.mail.yourdomain.com` | `v=DKIM1; k=rsa; p=…` (printed for you) |
| TXT (DMARC) | `_dmarc.mail.yourdomain.com` | `v=DMARC1; p=none; rua=mailto:dmarc@mail.yourdomain.com; adkim=s; aspf=s` |

Set `spfInclude` in the domain config to your SMTP provider's SPF host (the `dns` output tells you when it is missing). Some DNS hosts want the long DKIM value as a single string; others require it split at 255 characters. The CLI already prints it split.

The DKIM private key stays in `.sealpost/` (mode `0600`). Back it up; if you lose it, generate a new key with a new selector and publish the new record.

## 3. Add a real mailbox

```json
{
  "transport": "smtp",
  "mailboxes": [
    { "id": "primary", "label": "Primary relay", "host": "smtp.yourprovider.com", "port": 587, "security": "starttls", "username": "apikey", "passwordEnv": "SMTP_PRIMARY_PASSWORD" },
    { "id": "backup",  "label": "Backup relay",  "host": "smtp.other.com",        "port": 465, "security": "tls",      "username": "me",     "passwordEnv": "SMTP_BACKUP_PASSWORD" }
  ]
}
```

Passwords are read from the named environment variable at send time and are never written to disk.

```bash
export SMTP_PRIMARY_PASSWORD='…'
sealpost send workspace_team_invitation --to you@gmail.com --auto-fill
```

Mailboxes are tried in order; a network error, 4xx or auth failure falls through to the next. Port 25 outbound is blocked by most cloud hosts, so use 587 or 465 through a relay.

## 4. Bounce and complaint feedback

SMTP replies only tell you what the relay said at hand-off. To learn about later bounces and spam complaints, point your relay's event webhook at Sealpost:

```bash
export SEALPOST_WEBHOOK_SECRET="$(openssl rand -hex 24)"
sealpost studio --host 0.0.0.0        # behind TLS, with SEALPOST_API_KEY set
```

| Relay | Configure | URL |
| --- | --- | --- |
| Amazon SES | SNS topic with an HTTPS subscription for bounce and complaint notifications | `https://mail.yourdomain.com/hooks/relay/ses?token=…` |
| SendGrid | Event Webhook (bounce, dropped, deferred, spam report, delivered) | `…/hooks/relay/sendgrid?token=…` |
| Postmark | Webhooks (bounce, spam complaint, delivery) | `…/hooks/relay/postmark?token=…` |
| Mailgun | Webhooks (failed, complained, delivered) | `…/hooks/relay/mailgun?token=…` |

Hard bounces and complaints add the recipient to the suppression list, so EW-107 stops further sends. For SES, the subscription request is answered with a `confirmationUrl`; open that URL yourself to confirm. Sealpost never fetches it for you.

## 5. Verify

1. Send to a Gmail address and choose **Show original**: expect `DKIM: PASS`, `SPF: PASS`, `DMARC: PASS`.
2. Run `sealpost ledger verify` and keep the receipt.
3. Move DMARC from `p=none` to `quarantine`, then `reject`, once the aggregate reports at `rua` look clean.

## 5b. Receive replies and bounces (optional)

Publishing the MX record that `sealpost dns` prints and enabling `inbound` lets Sealpost receive mail for the domain. See [INBOUND.md](INBOUND.md). `sealpost domain check` verifies the MX record against `inbound.mxHost` once receiving is enabled.

## 6. Several sending domains

One install can send for many brands. Each domain has its own From identity, DKIM selector and key.

```bash
sealpost domain add news.example.org --from news@news.example.org --name "Acme News" --selector n1
sealpost dns --domain news.example.org            # the records to publish
sealpost domain check                             # live lookup of SPF, DKIM and DMARC for every domain (exit 2 if wrong)
sealpost send workspace_team_invitation --to you@gmail.com --auto-fill --domain news.example.org
```

- Pick the domain per send with `domain` (CLI `--domain`, REST/SDK `domain`, broadcasts `--domain`); omit it for the default.
- Each additional domain's key lives in `.sealpost/dkim-<domain>.json` (mode `0600`). Back them up.
- EW-103 ties the From address to the selected domain, so a send for one brand cannot leave with another brand's identity.
- The suppression list is shared across domains: an address that hard-bounced is unreachable for all of them.
- Mailboxes (SMTP relays) are shared; the relay must be allowed to send for every domain, so publish each domain's SPF `include`.

## 7. Production hygiene

- Keep `allowPrivateNetworks` false unless your relay is genuinely on a private address.
- Run `sealpost studio --host 0.0.0.0` only with `SEALPOST_API_KEY` set, behind TLS.
- Include `unsubscribeUrl` on anything that is not strictly transactional, and honour it with `sealpost suppress add`.
- Hard bounces are suppressed automatically; check `sealpost suppress list` and the retry queue with `sealpost queue list`.
