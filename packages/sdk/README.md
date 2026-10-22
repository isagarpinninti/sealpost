# @sealpost/sdk

Zero-dependency TypeScript client for the Sealpost API. Works in Node 18+, browsers, Deno, Bun and edge runtimes. Results are `{ data, error }`; methods never throw for API or network errors.

```bash
npm i @sealpost/sdk
```

```ts
import { Sealpost } from "@sealpost/sdk";

const mail = new Sealpost({ apiKey: process.env.SEALPOST_KEY!, baseUrl: "https://mail.yourdomain.com" });

const { data, error } = await mail.emails.send({
  template: "magic_link_otp_verification",
  to: "user@example.org",
  variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" },
});

if (error?.code === "preflight_blocked") console.log(error.preflight?.checks); // nothing was sent
else if (data) console.log(data.messageId, data.receipt);                      // evw_… receipt
```

```ts
const aud = (await mail.audiences.create("Customers")).data!;
await mail.audiences.addContacts(aud.id, [{ email: "ada@example.org", name: "Ada", variables: { userName: "Ada" } }]);
await mail.broadcasts.create({ name: "Launch", audienceId: aud.id, template: "workspace_team_invitation", scheduledAt: new Date("2026-11-01T09:00:00Z"), ratePerMinute: 300 });
await mail.domains.check("news.example.org");   // live SPF / DKIM / DMARC lookup
```

Verify webhooks with `verifyWebhook(secret, rawBody, signatureHeader)`.

See the [API reference](../../docs/CLI_AND_EMBEDDING.md#sealpostsdk). MIT.
