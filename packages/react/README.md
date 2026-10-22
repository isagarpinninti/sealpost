# @sealpost/react

Four embeddable primitives for the Sealpost email studio: `VisualEmailStudio`, `DeliverabilityPreflightGate`, `DomainMailboxVault`, `SmtpTranscriptInspector`, plus a `CommandPalette`.

```bash
npm i @sealpost/react @sealpost/core react react-dom lucide-react
```

```tsx
import "@sealpost/react/styles.css";
import { VisualEmailStudio } from "@sealpost/react";
```

Styles are precompiled and scoped under `.ew-root`; layout uses container queries, so components respond to their own width. Previews render in sandboxed iframes. Props are listed in the [embedding guide](../../docs/CLI_AND_EMBEDDING.md). MIT.
