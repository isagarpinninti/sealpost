# Real-world test: does it land in a real inbox?

Everything in the test suite runs against a local sink. This walkthrough proves the same pipeline against **real relays and real mailboxes**. Budget about 30 minutes plus DNS propagation. It sends one email per mailbox you test.

## You need

- A domain you control and can add DNS records to (use a subdomain such as `mail.yourdomain.com`).
- An SMTP relay account: Amazon SES, Postmark, SendGrid, Mailgun, or your own server. Outbound port 25 is blocked on most hosts, so use 587 or 465.
- Mailboxes you own at Gmail, Outlook.com and, ideally, Yahoo.

## 1. Configure

```bash
sealpost init my-mail --domain mail.yourdomain.com --from hello@mail.yourdomain.com && cd my-mail
```

Edit `sealpost.config.json`:

```json
"transport": "smtp",
"mailboxes": [{ "id": "main", "label": "My relay", "host": "smtp.yourrelay.com", "port": 587, "security": "starttls", "username": "…", "passwordEnv": "SMTP_PASSWORD" }],
"domain": { "spfInclude": "your relay's SPF host, e.g. amazonses.com", "dmarcPolicy": "none", "unsubscribeUrl": "https://yourdomain.com/unsubscribe", "trackingBaseUrl": "" }
```

```bash
export SMTP_PASSWORD='…'
```

## 2. Publish DNS

```bash
sealpost dns
```

Add the SPF, DKIM and DMARC TXT records at your DNS host. Then:

```bash
sealpost domain check      # repeat until SPF, DKIM and DMARC all show ✔
```

## 3. Run the doctor

```bash
sealpost doctor
```

It logs in to your relay (sending nothing), re-checks DNS and warns about settings that hurt deliverability. Fix every ✖ before continuing; each one prints what to do.

## 4. Send a real test

```bash
sealpost doctor --send you@gmail.com
```

This sends the OTP template once, only if the doctor found no blocking problems.

## 5. Check what the receiver decided

In Gmail open the message, then ⋮ → **Show original** → **Download original**. Then:

```bash
sealpost auth-check ~/Downloads/original_message.eml
```

You want: `DKIM pass`, `SPF pass`, `DMARC pass`. Anything else prints a plain-language reason. (Outlook.com: open the message → ⋯ → View → View message source. Yahoo: ⋯ → View raw message.)

Also note where it landed: Inbox, Promotions or Spam.

## 6. Record the result

| Mailbox | Folder | DKIM | SPF | DMARC | Notes |
| --- | --- | --- | --- | --- | --- |
| Gmail | | | | | |
| Outlook.com | | | | | |
| Yahoo | | | | | |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| DKIM `fail` / body hash mismatch | The relay rewrote the message (footers, link tracking, re-encoding) after Sealpost signed it | Turn off the relay's own tracking and footer injection, or let the relay sign instead |
| DKIM `none` | Receiver found no key | The DKIM TXT record is missing or at the wrong name; `sealpost domain check` |
| SPF `softfail` / `fail` | Relay not authorised for your domain | Set `spfInclude` and republish SPF |
| SPF `pass`, DMARC `fail` | SPF passed for the relay's domain, not yours, and DKIM did not align | Fix DKIM; its `d=` must match the From domain |
| Delivered but in Spam | New domain with no reputation, or content | Send low volume to engaged recipients first; keep DMARC aligned; add `unsubscribeUrl` |
| Relay rejects with 5xx | Sender domain not verified at the relay | Verify the domain in the relay's dashboard |
| `sealpost doctor` times out on the mailbox | Port blocked | Use 587/465, not 25 |

## Optional outside checks

These are third-party services; use them at your discretion: a spam-score test inbox such as mail-tester.com, and Google Postmaster Tools for domain reputation once you send volume.

## Share the result

If something fails that you believe is a Sealpost bug, open an issue with the `sealpost auth-check --json` output and the SMTP transcript (`sealpost send … --json`), with credentials redacted.
