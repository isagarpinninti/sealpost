"use client";

import { useEffect, useMemo, useState } from "react";
import { Inbox, Mail, Trash2 } from "lucide-react";
import { autoFillSampleVariables, decodeQuotedPrintable, parseHeaders, splitMime, type DomainProfile, type EmailTemplate, type VariableValues } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, DeliverabilityPreflightGate, SmtpTranscriptInspector, cn } from "@sealpost/react";
import type { InboxItem, MailClient, PreviewView, SendView } from "@/lib/client";
import type { LogFn } from "../log";
import { EmptyState, Label, PageHeader, Select, TextInput } from "../ui";

interface Props {
  client: MailClient | null;
  templates: EmailTemplate[];
  template: EmailTemplate | null;
  domain: DomainProfile;
  onTemplate: (id: string) => void;
  log: LogFn;
  inboxVersion: number;
  onSent: () => void;
}

/** The text and html parts of a captured message, decoded from quoted-printable. */
function parts(raw: string): { html: string; text: string; headers: Array<[string, string]> } {
  const { headerBlock, body } = splitMime(raw);
  const section = (type: string): string => {
    const i = body.indexOf(`Content-Type: ${type}`);
    if (i < 0) return "";
    const rest = body.slice(i);
    const start = rest.indexOf("\r\n\r\n") + 4;
    const end = rest.indexOf("\r\n--", start);
    return decodeQuotedPrintable(rest.slice(start, end < 0 ? undefined : end));
  };
  return { html: section("text/html"), text: section("text/plain"), headers: parseHeaders(headerBlock).filter((h) => h.name.toLowerCase() !== "dkim-signature").map((h) => [h.name, h.value] as [string, string]) };
}

export function DispatchView({ client, templates, template, domain, onTemplate, log, inboxVersion, onSent }: Props) {
  const [to, setTo] = useState("user@example.org");
  const [values, setValues] = useState<Record<string, VariableValues>>({});
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [sent, setSent] = useState<SendView | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [open, setOpen] = useState<{ meta: InboxItem; raw: string } | null>(null);
  const [tab, setTab] = useState<"html" | "text" | "headers" | "raw">("html");

  const vars: VariableValues = template ? (values[template.id] ?? autoFillSampleVariables(template, {})) : {};
  const setVar = (k: string, v: string | number | boolean | undefined): void => {
    if (!template) return;
    const next = { ...vars };
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
    setValues((cur) => ({ ...cur, [template.id]: next }));
  };

  useEffect(() => {
    if (!client || !template) return;
    let live = true;
    const t = setTimeout(() => {
      client.preview({ template, domain, to, variables: vars, includeMime: false }).then((p) => live && setPreview(p)).catch(() => undefined);
    }, 100);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // `vars` is derived from `values` and `template`; both are dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, template, domain, to, values]);

  useEffect(() => {
    if (!client) return;
    let live = true;
    void client.inbox().then((m) => live && setInbox(m)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, inboxVersion]);

  const decoded = useMemo(() => (open ? parts(open.raw) : null), [open]);

  const dispatch = async (): Promise<void> => {
    if (!client || !template) return;
    setDispatching(true);
    try {
      const r = await client.send(template.id, template, domain, to, vars);
      setSent(r);
      if (r.status === "delivered") log("ok", `Delivered ${template.id} → ${to} · ${r.receiptId}`);
      else log(r.status === "queued" ? "warn" : "err", r.status === "blocked" ? "Blocked by the pre-flight gate" : (r.error ?? r.status));
      onSent();
    } catch (e) {
      log("err", e instanceof Error ? e.message : "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  };

  if (!template) return <p className="text-sm text-slate-500">No templates yet. Create one in the Visual Studio.</p>;
  return (
    <div>
      <PageHeader
        title="Live Dispatch & Test Inbox"
        description="Send over a real SMTP handshake, watch the wire, and verify the DKIM signature and the evw_ receipt on the message that actually arrived."
        actions={<div className="min-w-[260px] flex-1 sm:flex-none"><Select value={template.id} onChange={(e) => { setSent(null); onTemplate(e.target.value); }} aria-label="Template">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></div>}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Card>
            <CardHeader icon={<Mail size={16} />} title="Variables" subtitle="Typed values for this send" right={<Badge tone="slate">{template.variables.length}</Badge>} />
            <div className="grid grid-cols-1 gap-3 p-4 @md:grid-cols-2 sm:grid-cols-2">
              {template.variables.map((v) => (
                <div key={v.key}>
                  <Label hint={`${v.type}${v.required ? " · required" : ""}`}>{v.label}</Label>
                  {v.type === "boolean" ? (
                    <Select aria-label={v.label} value={vars[v.key] === undefined ? "" : String(vars[v.key])} onChange={(e) => setVar(v.key, e.target.value === "" ? undefined : e.target.value === "true")}><option value="">(unset)</option><option value="true">true</option><option value="false">false</option></Select>
                  ) : (
                    <TextInput aria-label={v.label} className="font-mono text-xs" value={vars[v.key] === undefined ? "" : String(vars[v.key])} placeholder={v.defaultValue !== undefined ? `default: ${String(v.defaultValue)}` : String(v.sampleValue)} onChange={(e) => setVar(v.key, v.type === "number" || v.type === "currency" ? (Number.isFinite(Number(e.target.value)) && e.target.value !== "" ? Number(e.target.value) : e.target.value) : e.target.value)} />
                  )}
                </div>
              ))}
            </div>
          </Card>
          <DeliverabilityPreflightGate preflight={preview?.preflight ?? null} to={to} onToChange={setTo} onAutoFill={() => setValues((cur) => ({ ...cur, [template.id]: autoFillSampleVariables(template, vars) }))} onDispatch={() => void dispatch()} dispatching={dispatching} />
          <SmtpTranscriptInspector transcript={sent?.transcript ?? null} rawMime={sent?.rawMime ?? null} receiptToken={sent?.receiptToken ?? null} dkimPublicKeyJwk={client?.dkimPublicKeyJwk ?? null} simulated={sent?.simulated} />
          {sent && sent.status !== "delivered" ? <p role="alert" className={cn("rounded-lg border p-3 text-xs", sent.status === "queued" ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200" : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200")}>{sent.status === "queued" ? `Queued for retry (10 s → 1 min → 5 min): ${sent.error}` : sent.status === "blocked" ? "Blocked by the pre-flight gate: no socket was opened." : `Delivery failed: ${sent.error}`}{sent.suppressed?.length ? ` ${sent.suppressed.join(", ")} added to the suppression list.` : ""}</p> : null}
        </div>

        <Card>
          <CardHeader icon={<Inbox size={16} />} title="Test Inbox" subtitle="Everything the loopback SMTP sink captured" right={<Button variant="danger" disabled={inbox.length === 0} onClick={() => void client?.clearInbox().then(() => { setOpen(null); onSent(); })}><Trash2 size={13} /> Clear</Button>} />
          <div className="p-4">
            {inbox.length === 0 ? <EmptyState icon={<Inbox size={26} />} title="The inbox is empty">Dispatch an email to a transport set to “Built-In Loopback Test Sink”.</EmptyState> : (
              <ul className="space-y-1.5" aria-label="Inbox">
                {inbox.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => void client?.inboxMessage(m.id).then((r) => { setOpen(r); setTab("html"); })} aria-current={open?.meta.id === m.id ? "true" : undefined} className={cn("flex w-full cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50", open?.meta.id === m.id ? "border-slate-900 bg-slate-50 dark:border-white dark:bg-white/10" : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-white/5")}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-slate-900 dark:text-slate-100">{m.subject}</span>
                        <span className="block truncate text-slate-500 dark:text-slate-400">{m.to} · {new Date(m.receivedAtIso).toLocaleTimeString()} · {m.size} B</span>
                      </span>
                      {m.dkim ? <Badge tone={m.dkim.ok ? "emerald" : "rose"}>{m.dkim.ok ? "DKIM pass" : "DKIM fail"}</Badge> : <Badge tone="slate">no DKIM</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {open && decoded ? (
              <div className="mt-4 space-y-3">
                <div role="tablist" aria-label="Message view" className="flex gap-1">
                  {(["html", "text", "headers", "raw"] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium capitalize", tab === t ? "border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")}>{t}</button>
                  ))}
                </div>
                {tab === "html" ? <iframe title="Captured message" sandbox="" srcDoc={decoded.html} className="h-[520px] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800" /> : null}
                {tab === "text" ? <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 font-mono text-xs dark:bg-slate-950">{decoded.text}</pre> : null}
                {tab === "headers" ? <dl className="space-y-1 rounded-lg bg-slate-50 p-3 font-mono text-[11px] dark:bg-slate-950">{decoded.headers.map(([k, v], i) => <div key={i}><dt className="inline text-slate-500">{k}: </dt><dd className="inline text-slate-900 dark:text-slate-100">{v}</dd></div>)}</dl> : null}
                {tab === "raw" ? <pre className="max-h-[520px] overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[10.5px] leading-relaxed text-slate-100 dark:bg-slate-950">{open.raw}</pre> : null}
                {open.meta.dkim ? <p className="text-xs text-slate-600 dark:text-slate-300">{open.meta.dkim.reason}</p> : null}
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
