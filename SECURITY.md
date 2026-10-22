# Security policy

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/isagarpinninti/sealpost/security/advisories/new). Please do not open a public issue.

You can expect an acknowledgement within a few days. Fixes ship in a patch release with a credit if you want one.

## Scope and design

- **Header injection**: CR/LF/NUL are rejected by the gate (EW-102) and again inside the MIME builder.
- **XSS in templates**: template text and variable values are HTML-escaped; `javascript:`, `data:` and similar URLs are neutralised; previews run in `sandbox=""` iframes.
- **SSRF**: SMTP targets and webhooks resolving to private, loopback or link-local addresses are refused unless `allowPrivateNetworks` is set. IP literals are checked directly.
- **TLS**: STARTTLS is never downgraded; credentials are not sent in clear to non-private hosts; credentials are masked in transcripts.
- **Webhooks to your app**: every delivery is HMAC-SHA256 signed over `timestamp.body` (5-minute tolerance, constant-time comparison); the secret comes from an environment variable; redirects are not followed and private targets are refused unless `allowPrivateNetworks` is set.
- **Receiving mail**: the MX listener accepts only configured domains and never relays; it caps size, recipients, connections per address, messages and time per session; the original bytes are stored untouched. Delivery and abuse reports are only acted on when they quote mail this server sent and name one of its recipients, so a forged report cannot suppress an arbitrary address. Received HTML is shown in a script-free, network-free sandbox and attachments are served as opaque downloads. SPF/DMARC are not evaluated on inbound mail.
- **Template import**: MJML, HTML and React Email JSX are parsed as text only. Nothing in an imported file is executed, no imports are resolved and no network request is made; size, nesting depth and node count are capped.
- **API keys and audit**: keys are stored as SHA-256 only, carry scopes and optional expiry, and are revocable at runtime; every write and every failed sign-in is recorded with the actor, IP and request id (never query strings or bodies).
- **Unsubscribe links**: signed with an HMAC (server secret, constant-time check) so they cannot be forged or aimed at another address; GET is read-only; the undo only reverses an `unsubscribed` entry, never a bounce or complaint.
- **SMTP submission**: needs an API key with `send`; refuses to start on a public address without TLS; From must be on a configured domain.
- **MCP**: sending is disabled unless the server is started with `--allow-send`; received mail is returned as plain, capped, `untrusted` text.
- **Postgres**: the connection string is read from the environment, never the config; the database holds your private keys, so protect it like a secret store.
- **Multiple domains**: each domain signs with its own key (mode `0600`); EW-103 binds the From address to the selected domain.
- **Secrets**: SMTP passwords are never persisted (`passwordEnv` only). Keys are written with mode `0600`.
- **Server**: refuses a non-loopback bind without an API key; `/api/*` requires a bearer key; the click redirect only follows URLs recorded for that message.

Out of scope: weaknesses in a third-party SMTP relay, DNS misconfiguration, and the simulated delivery of the browser-only demo.
