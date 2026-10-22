"use client";

import { useMemo, useState } from "react";
import { Check, Code2, Copy } from "lucide-react";
import type { EmailTemplate } from "@sealpost/core";
import { Button, Card, CardHeader } from "@sealpost/react";
import { buildSdkSnippets, type SdkSnippets } from "@/lib/sdkCode";
import { PageHeader, Select, Tabs } from "../ui";

type Tab = keyof SdkSnippets;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "install", label: "Install" },
  { id: "send", label: "Send (REST)" },
  { id: "embed", label: "Embed the editor" },
  { id: "core", label: "Core SDK" },
  { id: "cli", label: "CLI" },
  { id: "curl", label: "cURL" },
  { id: "template", label: "Template JSON" },
];

export function SdkView({ templates, template, onTemplate }: { templates: EmailTemplate[]; template: EmailTemplate | null; onTemplate: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("send");
  const [copied, setCopied] = useState(false);
  const snippets = useMemo(() => (template ? buildSdkSnippets(template) : null), [template]);
  const copy = async (): Promise<void> => {
    if (!snippets) return;
    try {
      await navigator.clipboard.writeText(snippets[tab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div>
      <PageHeader title="SDK & Embed" description="Send from any backend, drop the visual editor into any admin dashboard, or use the engine directly. Templates stay in the Studio, not in your code." actions={template ? <div className="min-w-[260px] flex-1 sm:flex-none"><Select value={template.id} onChange={(e) => onTemplate(e.target.value)} aria-label="Template">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></div> : null} />
      <Card>
        <CardHeader icon={<Code2 size={16} />} title="Generated from the selected template" subtitle="Copy, paste, ship" />
        <div className="p-4 sm:p-5">
          <Tabs value={tab} onChange={setTab} tabs={TABS} />
          <div className="relative mt-3">
            <Button variant="secondary" onClick={() => void copy()} className="absolute right-2 top-2 z-10" aria-label="Copy snippet">{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</Button>
            <pre className="max-h-[560px] overflow-auto rounded-lg bg-slate-900 p-4 pt-12 font-mono text-[11.5px] leading-relaxed text-slate-100 dark:bg-slate-950">{snippets ? snippets[tab] : ""}</pre>
          </div>
        </div>
      </Card>
    </div>
  );
}
