# @sealpost/cli

The `sealpost` command: scaffold a project, run the deliverability gate, DKIM-sign and deliver over a raw SMTP socket (no nodemailer), keep a verifiable ledger, and serve the visual Studio.

```bash
npx @sealpost/cli init my-mail && cd my-mail
npx @sealpost/cli send magic_link_otp_verification --to you@example.org --auto-fill
npx @sealpost/cli studio --open
```

Node 20+. Default transport is a loopback SMTP sink; switch to real mailboxes in `sealpost.config.json` ([domain setup](../../docs/CUSTOM_DOMAIN_SETUP.md)). Full command and REST reference: [CLI and embedding](../../docs/CLI_AND_EMBEDDING.md). MIT.
