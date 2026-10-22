# @sealpost/core

Zero-dependency email engine: block compiler, EW-101…108 deliverability gate, RFC 5322/2045 MIME, RFC 6376 DKIM (sign and verify), `evw_` ECDSA receipts and a hash-chained delivery ledger. Runs on Web Crypto, so it works in Node 20+, browsers and edge runtimes.

```bash
npm i @sealpost/core zod
```

```ts
import { TEMPLATE_PACKS, SAMPLE_DOMAIN, evaluateDispatchPreflight } from "@sealpost/core";

const pre = await evaluateDispatchPreflight(
  { to: "user@example.org", variables: { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" } },
  { template: TEMPLATE_PACKS[0], domain: SAMPLE_DOMAIN },
);
pre.gate;    // "CLEAR" | "WARN" | "BLOCKED"
pre.score;   // 0..100
```

Then `composeSignedMessage` turns a cleared result into DKIM-signed bytes ready for SMTP. See the [spec](../../docs/MIME_DKIM_SMTP_SPEC.md) and [embedding guide](../../docs/CLI_AND_EMBEDDING.md).

Peer dependency: `zod ^3.23.0 || ^4.0.0`. MIT.
