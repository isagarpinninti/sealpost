"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Code2, Copy, FileText, Heading, Image as ImageIcon, Info, KeyRound, LayoutTemplate, ListOrdered, Minus, Monitor, MousePointerClick, PanelBottom, Plus, Smartphone, Trash2, Type } from "lucide-react";
import { autoFillSampleVariables, compileEmailTemplate, type DomainProfile, type EmailBlock, type EmailBlockType, type EmailTemplate, type TemplateVariable, type VariableValues } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, Toggle } from "../ui";
import { cn } from "../utils";

export interface VisualEmailStudioProps {
  template: EmailTemplate;
  onChange: (next: EmailTemplate) => void;
  /** Live values for the template's variables. Missing ones fall back to their sample in the preview. */
  variables: VariableValues;
  onVariablesChange: (next: VariableValues) => void;
  domain?: Pick<DomainProfile, "unsubscribeUrl">;
  /** The DKIM-signed RFC 5322 message for the "Raw MIME" tab (built server-side or with `signDkim`). */
  rawMime?: string | null;
  readOnly?: boolean;
}

type Preview = "desktop" | "mobile" | "text" | "raw";
type Side = "blocks" | "variables" | "settings";

const BLOCK_TYPES: Array<{ type: EmailBlockType; label: string; icon: typeof Type }> = [
  { type: "header", label: "Header", icon: LayoutTemplate },
  { type: "heading", label: "Heading", icon: Heading },
  { type: "paragraph", label: "Paragraph", icon: Type },
  { type: "otp_code", label: "OTP code", icon: KeyRound },
  { type: "key_value", label: "Key / value", icon: ListOrdered },
  { type: "line_items", label: "Line items", icon: ListOrdered },
  { type: "button", label: "Button", icon: MousePointerClick },
  { type: "callout", label: "Callout", icon: Info },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "divider", label: "Divider", icon: Minus },
  { type: "footer", label: "Footer", icon: PanelBottom },
];
const ICON = Object.fromEntries(BLOCK_TYPES.map((b) => [b.type, b.icon])) as Record<EmailBlockType, typeof Type>;

function newBlock(type: EmailBlockType, id: string): EmailBlock {
  switch (type) {
    case "header": return { id, type, brandName: "Your Brand", badgeText: "" };
    case "heading": return { id, type, text: "A clear heading", level: "h1" };
    case "paragraph": return { id, type, text: "Write your message here. Use {{variables}} for dynamic content." };
    case "otp_code": return { id, type, label: "Your code", variableKey: "otpCode" };
    case "key_value": return { id, type, rows: [{ label: "Label", valueTemplate: "Value" }] };
    case "line_items": return { id, type, items: [{ description: "Item", amountTemplate: "$0.00" }], totalLabel: "Total", totalTemplate: "$0.00" };
    case "button": return { id, type, label: "Click here", urlTemplate: "https://example.com", style: "primary" };
    case "callout": return { id, type, tone: "info", title: "Heads up", text: "Something worth noticing." };
    case "image": return { id, type, srcTemplate: "https://example.com/logo.png", alt: "Logo", width: 160, align: "left" };
    case "divider": return { id, type };
    case "footer": return { id, type, companyAddress: "Your Company, 1 Main Street", unsubscribeText: "Unsubscribe" };
  }
}

function summary(b: EmailBlock): string {
  switch (b.type) {
    case "header": return b.brandName;
    case "heading": return b.text;
    case "paragraph": return b.text.slice(0, 48);
    case "otp_code": return b.label;
    case "key_value": return `${b.rows.length} row${b.rows.length === 1 ? "" : "s"}`;
    case "line_items": return `${b.items.length} item${b.items.length === 1 ? "" : "s"} · ${b.totalLabel}`;
    case "button": return b.label;
    case "callout": return b.title;
    case "image": return b.alt || b.srcTemplate;
    case "divider": return "Divider";
    case "footer": return b.companyAddress.split("\n")[0];
  }
}

const field = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 shadow-sm outline-none placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-white dark:focus:ring-white/10";

function F({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </label>
  );
}

const uniqueId = (base: string, taken: readonly string[]): string => {
  const root = base.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40) || "block";
  let id = root;
  for (let n = 2; taken.includes(id); n++) id = `${root}${n}`;
  return id;
};

function BlockForm({ block, onChange, disabled, variableKeys }: { block: EmailBlock; onChange: (b: EmailBlock) => void; disabled: boolean; variableKeys: string[] }) {
  const t = (key: string, label: string, mono = false): ReactNode => (
    <F label={label}>
      <input className={cn(field, mono && "font-mono")} disabled={disabled} value={String((block as unknown as Record<string, unknown>)[key] ?? "")} onChange={(e) => onChange({ ...block, [key]: e.target.value } as EmailBlock)} />
    </F>
  );
  const a = (key: string, label: string, rows = 3): ReactNode => (
    <F label={label}>
      <textarea rows={rows} className={cn(field, "resize-y")} disabled={disabled} value={String((block as unknown as Record<string, unknown>)[key] ?? "")} onChange={(e) => onChange({ ...block, [key]: e.target.value } as EmailBlock)} />
    </F>
  );
  const common = (
    <F label="Show only if variable is set (optional)">
      <select className={field} disabled={disabled} value={block.showIfVariable ?? ""} onChange={(e) => onChange({ ...block, showIfVariable: e.target.value || undefined } as EmailBlock)}>
        <option value="">Always show</option>
        {variableKeys.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
    </F>
  );
  let body: ReactNode;
  switch (block.type) {
    case "header":
      body = <>{t("brandName", "Brand name")}{t("badgeText", "Badge text")}{t("subtitle", "Subtitle")}</>;
      break;
    case "heading":
      body = <>{a("text", "Text", 2)}<F label="Level"><select className={field} disabled={disabled} value={block.level ?? "h1"} onChange={(e) => onChange({ ...block, level: e.target.value as "h1" | "h2" })}><option value="h1">H1</option><option value="h2">H2</option></select></F></>;
      break;
    case "paragraph":
      body = <>{a("text", "Text", 5)}<div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><Toggle checked={Boolean(block.muted)} onChange={(v) => onChange({ ...block, muted: v })} label="Muted" locked={disabled} /> Muted (secondary colour)</div></>;
      break;
    case "otp_code":
      body = <>{t("label", "Label")}<F label="Variable"><select className={field} disabled={disabled} value={block.variableKey} onChange={(e) => onChange({ ...block, variableKey: e.target.value })}>{variableKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select></F>{t("expiryNote", "Expiry note")}</>;
      break;
    case "key_value":
      body = (
        <div className="space-y-2">
          {block.rows.map((r, i) => (
            <div key={i} className="flex gap-1.5">
              <input aria-label="Row label" className={field} disabled={disabled} value={r.label} onChange={(e) => onChange({ ...block, rows: block.rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
              <input aria-label="Row value" className={cn(field, "font-mono")} disabled={disabled} value={r.valueTemplate} onChange={(e) => onChange({ ...block, rows: block.rows.map((x, k) => (k === i ? { ...x, valueTemplate: e.target.value } : x)) })} />
              <button type="button" aria-label="Remove row" disabled={disabled || block.rows.length <= 1} onClick={() => onChange({ ...block, rows: block.rows.filter((_, k) => k !== i) })} className="cursor-pointer rounded p-1 text-rose-500 disabled:opacity-30"><Trash2 size={13} /></button>
            </div>
          ))}
          <Button variant="secondary" disabled={disabled} onClick={() => onChange({ ...block, rows: [...block.rows, { label: "Label", valueTemplate: "Value" }] })}><Plus size={12} /> Add row</Button>
        </div>
      );
      break;
    case "line_items":
      body = (
        <div className="space-y-2">
          {block.items.map((r, i) => (
            <div key={i} className="flex gap-1.5">
              <input aria-label="Item description" className={field} disabled={disabled} value={r.description} onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })} />
              <input aria-label="Item amount" className={cn(field, "w-28 font-mono")} disabled={disabled} value={r.amountTemplate} onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === i ? { ...x, amountTemplate: e.target.value } : x)) })} />
              <button type="button" aria-label="Remove item" disabled={disabled || block.items.length <= 1} onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== i) })} className="cursor-pointer rounded p-1 text-rose-500 disabled:opacity-30"><Trash2 size={13} /></button>
            </div>
          ))}
          <Button variant="secondary" disabled={disabled} onClick={() => onChange({ ...block, items: [...block.items, { description: "Item", amountTemplate: "$0.00" }] })}><Plus size={12} /> Add item</Button>
          {t("totalLabel", "Total label")}{t("totalTemplate", "Total amount", true)}
        </div>
      );
      break;
    case "button":
      body = <>{t("label", "Label")}{t("urlTemplate", "URL (https://… or {{variable}})", true)}<F label="Style"><select className={field} disabled={disabled} value={block.style ?? "primary"} onChange={(e) => onChange({ ...block, style: e.target.value as "primary" | "amber" | "outline" })}><option value="primary">Primary</option><option value="amber">Amber</option><option value="outline">Outline</option></select></F></>;
      break;
    case "callout":
      body = <><F label="Tone"><select className={field} disabled={disabled} value={block.tone} onChange={(e) => onChange({ ...block, tone: e.target.value as "info" | "warn" | "emerald" | "rose" })}><option value="info">Info</option><option value="warn">Warning</option><option value="emerald">Success</option><option value="rose">Critical</option></select></F>{t("title", "Title")}{a("text", "Text", 3)}</>;
      break;
    case "image":
      body = <>{t("srcTemplate", "Image URL (https://… or {{variable}})", true)}{t("alt", "Alt text")}{t("hrefTemplate", "Link URL (optional)", true)}<F label="Width (px)"><input type="number" min={16} max={600} className={field} disabled={disabled} value={block.width ?? ""} onChange={(e) => onChange({ ...block, width: e.target.value === "" ? undefined : Math.min(600, Math.max(16, Number(e.target.value) || 16)) })} /></F><F label="Align"><select className={field} disabled={disabled} value={block.align ?? "left"} onChange={(e) => onChange({ ...block, align: e.target.value as "left" | "center" })}><option value="left">Left</option><option value="center">Center</option></select></F></>;
      break;
    case "footer":
      body = <>{a("companyAddress", "Company address", 3)}{t("unsubscribeText", "Unsubscribe link text")}</>;
      break;
    default:
      body = <p className="text-xs text-slate-500">A divider has no settings.</p>;
  }
  return (
    <div className="space-y-2.5">
      {body}
      {common}
    </div>
  );
}

export function VisualEmailStudio({ template, onChange, variables, onVariablesChange, domain, rawMime = null, readOnly = false }: VisualEmailStudioProps) {
  const [selected, setSelected] = useState<string>(template.blocks[0]?.id ?? "");
  const [preview, setPreview] = useState<Preview>("desktop");
  const [side, setSide] = useState<Side>("blocks");
  const block = template.blocks.find((b) => b.id === selected) ?? template.blocks[0];
  const filled = useMemo(() => autoFillSampleVariables(template, variables), [template, variables]);
  const compiled = useMemo(() => compileEmailTemplate(template, filled, { domain }), [template, filled, domain]);
  const keys = template.variables.map((v) => v.key);
  const ids = template.blocks.map((b) => b.id);

  const setBlocks = (blocks: EmailBlock[]): void => onChange({ ...template, blocks });
  const index = block ? template.blocks.findIndex((b) => b.id === block.id) : -1;
  const move = (dir: -1 | 1): void => {
    const j = index + dir;
    if (index < 0 || j < 0 || j >= template.blocks.length) return;
    const next = [...template.blocks];
    [next[index], next[j]] = [next[j], next[index]];
    setBlocks(next);
  };
  const add = (type: EmailBlockType): void => {
    const nb = newBlock(type, uniqueId(type, ids));
    const at = index < 0 ? template.blocks.length : index + 1;
    setBlocks([...template.blocks.slice(0, at), nb, ...template.blocks.slice(at)]);
    setSelected(nb.id);
  };
  const duplicate = (): void => {
    if (!block) return;
    const copy = { ...structuredClone(block), id: uniqueId(`${block.id}_copy`, ids) } as EmailBlock;
    setBlocks([...template.blocks.slice(0, index + 1), copy, ...template.blocks.slice(index + 1)]);
    setSelected(copy.id);
  };
  const remove = (): void => {
    if (!block || template.blocks.length <= 1) return;
    const next = template.blocks.filter((b) => b.id !== block.id);
    setBlocks(next);
    setSelected(next[Math.min(index, next.length - 1)].id);
  };
  const setVar = (i: number, patch: Partial<TemplateVariable>): void => onChange({ ...template, variables: template.variables.map((v, k) => (k === i ? { ...v, ...patch } : v)) });

  const previewFrame = (width: number | "100%"): ReactNode => (
    <div className="overflow-auto rounded-lg border border-slate-200 bg-slate-100 p-3 dark:border-slate-800 dark:bg-slate-950">
      <iframe title="Email preview" sandbox="" srcDoc={compiled.html} style={{ width, maxWidth: "100%", height: 640, border: 0, background: "#fff", margin: "0 auto", display: "block", borderRadius: 8 }} />
    </div>
  );

  return (
    <Card>
      <CardHeader icon={<LayoutTemplate size={16} />} title="Visual Email Studio" subtitle="Edit blocks, variables and theme. No HTML, no deploy." right={<Badge tone="slate">{template.blocks.length} blocks · {template.variables.length} variables</Badge>} />
      <div className="grid grid-cols-1 @xl:grid-cols-[minmax(270px,310px)_minmax(0,1fr)]">
        <div className="border-b border-slate-200 p-4 @xl:border-b-0 @xl:border-r dark:border-slate-800">
          <div role="tablist" aria-label="Editor sections" className="mb-3 flex gap-1 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800/80">
            {(["blocks", "variables", "settings"] as const).map((s) => (
              <button key={s} type="button" role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={cn("flex-1 cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50", side === s ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white" : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white")}>
                {s}
              </button>
            ))}
          </div>

          {side === "blocks" ? (
            <div className="space-y-3">
              <ul className="space-y-1" aria-label="Blocks">
                {template.blocks.map((b) => {
                  const Icon = ICON[b.type];
                  const active = b.id === block?.id;
                  return (
                    <li key={b.id}>
                      <button type="button" onClick={() => setSelected(b.id)} aria-current={active ? "true" : undefined} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50", active ? "border-slate-900 bg-slate-50 dark:border-white dark:bg-white/10" : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-white/5")}>
                        <Icon size={13} className="shrink-0 text-slate-500" />
                        <span className="w-16 shrink-0 font-mono text-[10px] uppercase text-slate-400">{b.type.replace("_", " ")}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-100">{summary(b)}</span>
                        {b.showIfVariable ? <Badge tone="cyan">if {b.showIfVariable}</Badge> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="secondary" disabled={readOnly || index <= 0} onClick={() => move(-1)} aria-label="Move block up"><ArrowUp size={13} /> Up</Button>
                <Button variant="secondary" disabled={readOnly || index < 0 || index >= template.blocks.length - 1} onClick={() => move(1)} aria-label="Move block down"><ArrowDown size={13} /> Down</Button>
                <Button variant="secondary" disabled={readOnly || !block} onClick={duplicate}><Copy size={13} /> Duplicate</Button>
                <Button variant="danger" disabled={readOnly || template.blocks.length <= 1} onClick={remove}><Trash2 size={13} /> Delete</Button>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Add block</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {BLOCK_TYPES.map(({ type, label, icon: Icon }) => (
                    <button key={type} type="button" disabled={readOnly} onClick={() => add(type)} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1.5 text-left text-xs text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
              </div>
              {block ? (
                <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Edit {block.type.replace("_", " ")}</p>
                  <BlockForm block={block} variableKeys={keys} disabled={readOnly} onChange={(nb) => setBlocks(template.blocks.map((b) => (b.id === nb.id ? nb : b)))} />
                </div>
              ) : null}
            </div>
          ) : null}

          {side === "variables" ? (
            <div className="space-y-3">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Declare every <code className="font-mono">{"{{variable}}"}</code> with a type. Callers that omit a required one are stopped by EW-101, or fall back to the default.</p>
              {template.variables.map((v, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <input aria-label="Variable key" className={cn(field, "font-mono")} disabled={readOnly} value={v.key} onChange={(e) => setVar(i, { key: e.target.value })} />
                    <button type="button" aria-label={`Remove ${v.key}`} disabled={readOnly} onClick={() => onChange({ ...template, variables: template.variables.filter((_, k) => k !== i) })} className="cursor-pointer rounded p-1 text-rose-500 disabled:opacity-30"><Trash2 size={13} /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <F label="Label"><input className={field} disabled={readOnly} value={v.label} onChange={(e) => setVar(i, { label: e.target.value })} /></F>
                    <F label="Type">
                      <select className={field} disabled={readOnly} value={v.type} onChange={(e) => setVar(i, { type: e.target.value as TemplateVariable["type"] })}>
                        {["string", "number", "currency", "url", "otp_code", "boolean"].map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </F>
                    <F label="Sample value"><input className={cn(field, "font-mono")} disabled={readOnly} value={String(v.sampleValue)} onChange={(e) => setVar(i, { sampleValue: v.type === "number" || v.type === "currency" ? (Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value) : v.type === "boolean" ? e.target.value === "true" : e.target.value })} /></F>
                    <F label="Default (fallback)"><input className={cn(field, "font-mono")} disabled={readOnly} placeholder="none" value={v.defaultValue === undefined ? "" : String(v.defaultValue)} onChange={(e) => setVar(i, { defaultValue: e.target.value === "" ? undefined : e.target.value })} /></F>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><Toggle checked={v.required} onChange={(r) => setVar(i, { required: r })} label={`${v.key} required`} locked={readOnly} /> Required</div>
                  <F label="Live value for the preview">
                    <input className={cn(field, "font-mono")} placeholder={`sample: ${String(v.sampleValue)}`} value={variables[v.key] === undefined ? "" : String(variables[v.key])} onChange={(e) => {
                      const next = { ...variables };
                      if (e.target.value === "") delete next[v.key];
                      else next[v.key] = v.type === "number" || v.type === "currency" ? (Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value) : v.type === "boolean" ? e.target.value === "true" : e.target.value;
                      onVariablesChange(next);
                    }} />
                  </F>
                </div>
              ))}
              <Button variant="secondary" disabled={readOnly} onClick={() => onChange({ ...template, variables: [...template.variables, { key: uniqueId("variable", keys), label: "New variable", type: "string", required: false, sampleValue: "sample" }] })}><Plus size={12} /> Add variable</Button>
            </div>
          ) : null}

          {side === "settings" ? (
            <div className="space-y-3">
              <F label="Subject"><input className={field} disabled={readOnly} value={template.subject} onChange={(e) => onChange({ ...template, subject: e.target.value })} /></F>
              <F label="Preheader (inbox preview text)"><input className={field} disabled={readOnly} value={template.preheader} onChange={(e) => onChange({ ...template, preheader: e.target.value })} /></F>
              <div className="grid grid-cols-3 gap-2">
                {(["accentColor", "canvasColor", "cardColor"] as const).map((k) => (
                  <F key={k} label={k.replace("Color", "")}>
                    <input type="color" aria-label={k} disabled={readOnly} value={/^#[0-9a-fA-F]{6}$/.test(template.theme[k]) ? template.theme[k] : "#000000"} onChange={(e) => onChange({ ...template, theme: { ...template.theme, [k]: e.target.value } })} className="h-8 w-full cursor-pointer rounded border border-slate-200 bg-transparent dark:border-slate-700" />
                  </F>
                ))}
              </div>
              <F label="Font family"><input className={cn(field, "font-mono")} disabled={readOnly} value={template.theme.fontFamily} onChange={(e) => onChange({ ...template, theme: { ...template.theme, fontFamily: e.target.value } })} /></F>
            </div>
          ) : null}
        </div>

        <div className="min-w-0 p-4">
          <div role="tablist" aria-label="Preview mode" className="mb-3 flex flex-wrap gap-1">
            {(
              [
                ["desktop", "Desktop", Monitor],
                ["mobile", "Mobile 375px", Smartphone],
                ["text", "Plain text", FileText],
                ["raw", "Raw MIME + DKIM", Code2],
              ] as const
            ).map(([id, label, Icon]) => (
              <button key={id} type="button" role="tab" aria-selected={preview === id} onClick={() => setPreview(id)} className={cn("flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50", preview === id ? "border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <p className="mb-2 truncate text-xs text-slate-600 dark:text-slate-300"><span className="font-semibold">Subject:</span> {compiled.subject}</p>
          {preview === "desktop" ? previewFrame("100%") : null}
          {preview === "mobile" ? previewFrame(375) : null}
          {preview === "text" ? <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-mono text-xs leading-relaxed text-slate-800 dark:bg-slate-950 dark:text-slate-200">{compiled.text}</pre> : null}
          {preview === "raw" ? (
            rawMime ? <pre className="max-h-[640px] overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-[10.5px] leading-relaxed text-slate-100 dark:bg-slate-950">{rawMime}</pre> : <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">The signed message appears here once the pre-flight gate has cleared the recipient.</p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
