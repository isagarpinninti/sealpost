# Getting started

This takes about ten minutes and needs only Node.js 20 or newer. No account, no DNS and no internet are required until step 6.

## 1. Create a project

```bash
npx @sealpost/cli init my-mail
cd my-mail
```

You get `sealpost.config.json`, five ready-made templates in `templates/`, and two private keys in `.sealpost/` (a DKIM key and a receipt-signing key). `.sealpost/` is git-ignored: never commit it.

## 2. Send a test email

```bash
npx @sealpost/cli send magic_link_otp_verification --to you@example.org --auto-fill
```

With the default `"transport": "sink"` Sealpost starts a loopback SMTP server, delivers to it over a real socket, checks the DKIM signature on arrival and stores the message. Nothing leaves your machine. The output includes an `evw_…` receipt and a ledger entry.

Try the gate: leave out `--auto-fill` and the send is blocked with a list of what is wrong; send the same email twice and the second is blocked as a duplicate (EW-108).

## 3. Open the Studio

```bash
npx @sealpost/cli studio --open
```

Studio runs on <http://127.0.0.1:4320>. Use **Studio** to edit blocks and preview desktop, mobile, plain text and raw MIME, **Send** to run the gate and see the SMTP transcript, **Logs** to follow every email, and **Setup** for the guided wizard.

Install the CLI once if you prefer to type less: `npm i -g @sealpost/cli`, then use `sealpost …`.

## 4. Write your own template

Add a JSON file to `templates/` (copy one of the examples) or import what you have:

```bash
sealpost template import welcome.mjml        # also React Email .tsx and plain HTML
sealpost validate
```

Variables are written `{{userName}}`, must be declared in the template, and are HTML-escaped on output.

## 5. Send from your code

Create a key, then call the REST API through an SDK:

```bash
sealpost auth add-key my-app --scope send --expires 365     # prints the key once
sealpost studio                                             # the API is served next to Studio
```

```ts
import { Sealpost } from "@sealpost/sdk";

const mail = new Sealpost({ apiKey: process.env.SEALPOST_KEY!, baseUrl: "http://127.0.0.1:4320" });
const { data, error } = await mail.emails.send({
  template: "magic_link_otp_verification",
  to: "user@example.org",
  idempotencyKey: "signup-42",
  variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" },
});
if (error) console.error(error.code); else console.log(data.receipt);
```

SDKs for [Python](../sdks/python), [Go](../sdks/go), [Ruby](../sdks/ruby) and [PHP](../sdks/php) share the same shape. Any other language can call the HTTP API: the spec is served at `/api/openapi.json`.

## 6. Go live with your own domain

1. In Studio open **Setup** (or run `sealpost dns`) and publish the SPF, DKIM and DMARC records it prints.
2. Pick a relay (SES, Postmark, SendGrid, Mailgun or any SMTP server) and put its password in an environment variable named by the mailbox's `passwordEnv`.
3. Set `"transport": "smtp"` in `sealpost.config.json`.
4. Run `sealpost doctor --send you@gmail.com`, then `sealpost auth-check message.eml` on the received original to confirm DKIM, SPF and DMARC pass.

Details: [Custom domain setup](CUSTOM_DOMAIN_SETUP.md) and [Real-world test](REAL_WORLD_TEST.md).

## 7. Deploy

```bash
export SEALPOST_API_KEY="$(openssl rand -hex 24)"
docker compose up -d          # Studio and API on :4320, data in the sealpost-data volume
```

Put it behind HTTPS (Caddy, nginx or your platform's proxy). Back up the data volume: it contains your private keys. For more than one instance use [Postgres storage](POSTGRES.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `BLOCKED` with EW-101 | A variable is missing or undeclared; pass `--var name=value` or `--auto-fill` |
| `EW-103` | The From address is not on the configured domain |
| `EW-108` | This exact email was already sent inside `dedupeWindowMinutes`; change a variable or the idempotency key |
| Studio refuses to start on `0.0.0.0` | Set `SEALPOST_API_KEY` or create a key with `sealpost auth add-key` |
| Mail lands in spam | Run `sealpost doctor` and `sealpost auth-check`; check DNS and that your relay allows your From domain |
| Anything else | `sealpost doctor --json` and open an issue ([SUPPORT.md](../SUPPORT.md)) |
