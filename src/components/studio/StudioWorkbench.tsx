"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDown, MailPlus, Plus, Search, Trash2 } from "lucide-react";
import { autoFillSampleVariables, validateTemplate, type DomainProfile, type EmailTemplate, type VariableValues } from "@sealpost/core";
import { DeliverabilityPreflightGate, VisualEmailStudio, cn } from "@sealpost/react";
import { blankTemplate } from "@/lib/blankTemplate";
import type { MailClient, PreviewView } from "@/lib/client";
import type { LogFn, TerminalEvent } from "./log";
import { ImportDialog } from "./ImportDialog";
import { EmptyState, IconButton, TextInput } from "./ui";
import { TerminalSquare } from "lucide-react";

export type StudioCommand = { id: number; name: "new-template" | "focus-filter" } | null;

interface Props {
  templates: EmailTemplate[];
  domain: DomainProfile;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSave: (t: EmailTemplate) => void;
  onDelete: (id: string) => void;
  onIssues: (n: number) => void;
  events: TerminalEvent[];
  onClearEvents: () => void;
  log: LogFn;
  client: MailClient | null;
  command: StudioCommand;
  onSent: () => void;
}

const TONE = { info: "text-slate-300", ok: "text-emerald-400", warn: "text-amber-300", err: "text-rose-400" } as const;
const MARK = { info: "·", ok: "✔", warn: "▲", err: "✖" } as const;

/** Visual Studio: template rail, the block editor, and a dock with the pre-flight gate and dispatch terminal. */
export function StudioWorkbench({ templates, domain, selectedId, onSelect, onSave, onDelete, onIssues, events, onClearEvents, log, client, command, onSent }: Props) {
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { template: EmailTemplate; errors: string[] }>>({});
  const [values, setValues] = useState<Record<string, VariableValues>>({});
  const [to, setTo] = useState("user@example.org");
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [importing, setImporting] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const lastCommand = useRef(0);

  const saved = templates.find((t) => t.id === selectedId) ?? templates[0] ?? null;
  const draft = saved ? drafts[saved.id] : undefined;
  const current = draft?.template ?? saved;
  const issueCount = Object.keys(drafts).length;

  useEffect(() => {
    onIssues(issueCount);
  }, [issueCount, onIssues]);

  const vars: VariableValues = current ? (values[current.id] ?? autoFillSampleVariables(current, {})) : {};

  useEffect(() => {
    if (!client || !saved) return;
    let live = true;
    const t = setTimeout(() => {
      client
        .preview({ template: saved, domain, to, variables: values[saved.id] ?? autoFillSampleVariables(saved, {}), includeMime: true })
        .then((p) => {
          if (live) setPreview(p);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, saved, domain, to, values]);

  const create = (t?: EmailTemplate): void => {
    const ids = templates.map((x) => x.id);
    let n = 1;
    while (ids.includes(`new_template_${n}`)) n++;
    const next = t ?? blankTemplate(`new_template_${n}`, `New template ${n}`);
    onSave(next);
    onSelect(next.id);
  };

  useEffect(() => {
    if (!command || command.id === lastCommand.current) return;
    lastCommand.current = command.id;
    const t = setTimeout(() => {
      if (command.name === "new-template") create();
      else filterRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
    // `create` closes over the latest templates; the command id gates re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  const edit = (next: EmailTemplate): void => {
    const v = validateTemplate(next);
    if (v.ok && v.template) {
      setDrafts((d) => {
        const { [next.id]: _removed, ...rest } = d;
        void _removed;
        return rest;
      });
      onSave(v.template);
    } else setDrafts((d) => ({ ...d, [next.id]: { template: next, errors: v.errors } }));
  };

  const visible = useMemo(() => templates.filter((t) => `${t.name} ${t.id} ${t.category}`.toLowerCase().includes(filter.toLowerCase())), [templates, filter]);

  const dispatch = async (): Promise<void> => {
    if (!client || !saved) return;
    setDispatching(true);
    try {
      const r = await client.send(saved.id, saved, domain, to, values[saved.id] ?? autoFillSampleVariables(saved, {}));
      if (r.status === "delivered") log("ok", `Delivered ${saved.id} → ${to} · ${r.receiptId} · ledger #${r.ledgerSeq}`);
      else if (r.status === "queued") log("warn", `Queued ${saved.id} → ${to}: ${r.error ?? "transient failure"}`);
      else if (r.status === "blocked") log("err", `Blocked: ${r.preflight.checks.filter((c) => c.severity === "block").map((c) => c.code).join(", ")}`);
      else log("err", `Delivery failed: ${r.error}`);
      onSent();
    } catch (e) {
      log("err", e instanceof Error ? e.message : "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[216px_minmax(0,1fr)] xl:grid-cols-[216px_minmax(0,1fr)_316px]">
      {importing ? <ImportDialog existingIds={templates.map((t) => t.id)} onClose={() => setImporting(false)} onImport={(t) => { setImporting(false); create(t); log("ok", `Imported ${t.name} (${t.blocks.length} blocks, ${t.variables.length} variables)`); }} /> : null}
      <nav aria-label="Templates" className="flex min-h-0 flex-col border-b border-slate-200/80 bg-white/50 lg:border-b-0 lg:border-r dark:border-white/[0.07] dark:bg-transparent">
        <div className="space-y-2 border-b border-slate-200/80 p-3 dark:border-white/[0.07]">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-50">Templates <span className="ml-1 font-normal text-slate-400">{templates.length}</span></h2>
            <div className="flex items-center gap-0.5">
              <IconButton label="Import a template (MJML, React Email, HTML)" onClick={() => setImporting(true)}><FileDown size={15} /></IconButton>
              <IconButton label="New template (N)" onClick={() => create()}><Plus size={15} /></IconButton>
            </div>
          </div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput ref={filterRef} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter templates" className="h-8 py-0 pl-8 text-xs" />
          </div>
        </div>
        <ul className="min-h-0 flex-1 space-y-px overflow-y-auto p-2 max-lg:max-h-48">
          {visible.map((t) => {
            const active = t.id === current?.id;
            return (
              <li key={t.id}>
                <button type="button" onClick={() => onSelect(t.id)} aria-current={active ? "true" : undefined} className={cn("group flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/25", active ? "bg-slate-900/[0.06] dark:bg-white/[0.08]" : "hover:bg-slate-900/[0.035] dark:hover:bg-white/[0.04]")}>
                  <span className="flex w-full items-center gap-2">
                    <span className={cn("truncate text-[13px] font-medium", active ? "text-slate-900 dark:text-white" : "text-slate-700 dark:text-slate-300")}>{t.name}</span>
                    {drafts[t.id] ? <span title="Has unapplied errors" className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
                  </span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">{t.category} · {t.blocks.length} blocks</span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 ? <li className="px-3 py-6 text-center text-xs text-slate-400">No templates match.</li> : null}
        </ul>
      </nav>

      <section className="@container flex min-h-0 min-w-0 flex-col">
        {current ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 px-5 py-3 lg:px-7 dark:border-white/[0.07]">
              <div className="min-w-0">
                <h1 className="truncate text-[17px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">{current.name}</h1>
                <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">templates/{current.id}.json · v{current.version}</p>
              </div>
              <IconButton label={`Delete ${current.name}`} danger disabled={templates.length <= 1} onClick={() => onDelete(current.id)}><Trash2 size={15} /></IconButton>
            </div>
            {draft ? (
              <ul role="alert" className="mx-5 mt-3 space-y-0.5 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-900 lg:mx-7 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">
                <li className="font-semibold">Changes are held until the template validates:</li>
                {draft.errors.slice(0, 5).map((e) => <li key={e}>• {e}</li>)}
              </ul>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-5">
              <VisualEmailStudio template={current} onChange={edit} variables={vars} onVariablesChange={(v) => setValues((cur) => ({ ...cur, [current.id]: v }))} domain={domain} rawMime={preview?.rawMime ?? null} />
            </div>
          </>
        ) : (
          <div className="p-6"><EmptyState icon={<MailPlus size={20} />} title="No templates yet" action={<div className="flex gap-2"><button type="button" onClick={() => create()} className="cursor-pointer rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-medium text-white dark:bg-white dark:text-slate-950">New template</button><button type="button" onClick={() => setImporting(true)} className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] font-medium dark:border-white/10">Import</button></div>}>Create one, or import an MJML, React Email or HTML file.</EmptyState></div>
        )}
      </section>

      {current ? (
        <aside className="hidden h-full min-h-0 flex-col border-l border-slate-200/80 bg-white/50 xl:flex dark:border-white/[0.07] dark:bg-transparent" aria-label="Dispatch dock">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <DeliverabilityPreflightGate preflight={preview?.preflight ?? null} to={to} onToChange={setTo} onAutoFill={() => setValues((cur) => ({ ...cur, [current.id]: autoFillSampleVariables(current, vars) }))} onDispatch={() => void dispatch()} dispatching={dispatching} />
          </div>
          <div className="dark flex h-44 flex-col border-t border-white/10 bg-slate-950">
            <div className="flex h-9 shrink-0 items-center gap-2 px-4 font-mono text-[11px] uppercase tracking-wider text-slate-300">
              <TerminalSquare size={13} /> Dispatch terminal <span className="text-slate-500">{events.length}</span>
              {events.length ? <button type="button" onClick={onClearEvents} className="ml-auto cursor-pointer text-slate-400 hover:text-white">clear</button> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 font-mono text-[11px] leading-5" role="log" aria-live="polite">
              {events.length === 0 ? <p className="text-slate-500">$ waiting for dispatch activity…</p> : null}
              {events.map((e) => (
                <p key={e.id} className={TONE[e.kind]}><span className="text-slate-500">{e.at}</span> {MARK[e.kind]} {e.text}</p>
              ))}
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
