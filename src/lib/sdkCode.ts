import type { EmailTemplate } from "@sealpost/core";

export interface SdkSnippets {
  install: string;
  send: string;
  embed: string;
  core: string;
  cli: string;
  curl: string;
  template: string;
}

export function buildSdkSnippets(t: EmailTemplate): SdkSnippets {
  const vars = Object.fromEntries(t.variables.map((v) => [v.key, v.sampleValue]));
  return {
    template: JSON.stringify(t, null, 2),
    install: `# the engine + CLI (no nodemailer)\nnpx @sealpost/cli init my-mail && cd my-mail\nnpx @sealpost/cli validate\nnpx @sealpost/cli studio --open\n\n# in your own app\nnpm install @sealpost/core zod\nnpm install @sealpost/react @sealpost/core lucide-react react react-dom`,
    send: `// From your backend: templates live in the Studio, not in your code.\nconst res = await fetch("http://127.0.0.1:4320/api/send", {\n  method: "POST",\n  headers: { "content-type": "application/json", authorization: "Bearer evk_…" },\n  body: JSON.stringify({\n    templateId: "${t.id}",\n    to: "user@example.org",\n    variables: ${JSON.stringify(vars, null, 4).replace(/\n/g, "\n    ")},\n  }),\n});\nconst { status, receipt } = await res.json();   // "delivered" + an evw_ receipt\n// 403 preflight_blocked → a required variable is missing or wrong-typed (EW-101)`,
    embed: `"use client";\nimport { useState } from "react";\nimport { getTemplatePack } from "@sealpost/core";\nimport { SurfaceRoot, VisualEmailStudio } from "@sealpost/react";\nimport "@sealpost/react/styles.css";\n\n// Drop the whole visual editor into any admin dashboard.\nexport function TemplateEditor() {\n  const [template, setTemplate] = useState(getTemplatePack("${t.id}")!);\n  const [variables, setVariables] = useState({});\n  return (\n    <SurfaceRoot>\n      <VisualEmailStudio template={template} onChange={setTemplate} variables={variables} onVariablesChange={setVariables} />\n    </SurfaceRoot>\n  );\n}`,
    core: `import { getTemplatePack, evaluateDispatchPreflight, composeSignedMessage, createDkimKeyPair, SAMPLE_DOMAIN } from "@sealpost/core";\n\nconst template = getTemplatePack("${t.id}")!;\nconst pre = await evaluateDispatchPreflight(\n  { to: "user@example.org", variables: ${JSON.stringify(vars)} },\n  { template, domain: SAMPLE_DOMAIN },\n);\nif (pre.gate === "BLOCKED") throw new Error(pre.checks.filter((c) => c.severity === "block").map((c) => c.message).join(" "));\n\nconst dkim = await createDkimKeyPair();\nconst { raw } = await composeSignedMessage({ preflight: pre, domain: SAMPLE_DOMAIN, messageId: "<id@mail.example.com>", privateKey: dkim.keys.privateKey });\n// \`raw\` is a complete RFC 5322 message with a real DKIM-Signature, ready for any SMTP client.`,
    cli: `sealpost compile ${t.id} --auto-fill                    # pre-flight EW-101…108 (exit 2 when blocked)\nsealpost send ${t.id} --to you@example.org --auto-fill  # DKIM-sign, raw SMTP, seal an evw_ receipt\nsealpost dns                                              # SPF / DKIM / DMARC records for your domain\nsealpost receipt verify receipt.evw.json --eml message.eml\nsealpost ledger verify`,
    curl: `curl -s http://127.0.0.1:4320/api/compile -H 'content-type: application/json' -d '${JSON.stringify({ template: { id: t.id }, variables: vars, to: "user@example.org" })}'\ncurl -s http://127.0.0.1:4320/api/send    -H 'content-type: application/json' -d '${JSON.stringify({ templateId: t.id, to: "user@example.org", variables: vars })}'\ncurl -s http://127.0.0.1:4320/api/inbox\ncurl -s http://127.0.0.1:4320/api/ledger/verify`,
  };
}
