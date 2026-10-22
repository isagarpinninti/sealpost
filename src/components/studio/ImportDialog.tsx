"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileUp, X } from "lucide-react";
import { ImportError, autoFillSampleVariables, compileEmailTemplate, detectImportFormat, importTemplate, type EmailTemplate, type ImportFormat } from "@sealpost/core";
import { Badge, Button, Segmented } from "@sealpost/react";
import { TextArea, TextInput } from "./ui";

interface Props {
  existingIds: string[];
  onClose: () => void;
  onImport: (template: EmailTemplate) => void;
}

type Pick = "auto" | ImportFormat;
const PLACEHOLDER = "Paste MJML, React Email JSX, or the HTML of any email…";

/** Unique id: `welcome`, then `welcome_2`, `welcome_3`… */
const uniqueId = (base: string, taken: readonly string[]): string => {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base.slice(0, 58)}_${n}`)) n++;
  return `${base.slice(0, 58)}_${n}`;
};

/** Brings an existing template into the workspace. Runs entirely in the browser: the source is never uploaded and JSX is never executed. */
export function ImportDialog({ existingIds, onClose, onImport }: Props) {
  const [source, setSource] = useState("");
  const [pick, setPick] = useState<Pick>("auto");
  const [debounced, setDebounced] = useState("");
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(source), 250);
    return () => window.clearTimeout(t);
  }, [source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector("textarea")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const result = useMemo(() => {
    if (debounced.trim() === "") return null;
    try {
      const r = importTemplate(debounced, { format: pick === "auto" ? undefined : pick });
      return { ok: true as const, ...r };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Import failed", issues: e instanceof ImportError ? e.issues : [] };
    }
  }, [debounced, pick]);

  const final = useMemo<EmailTemplate | null>(() => {
    if (!result?.ok) return null;
    const t = result.template;
    return { ...t, id: uniqueId(t.id, existingIds), name: name.trim() || t.name };
  }, [result, existingIds, name]);

  const html = useMemo(() => {
    if (!final) return "";
    try {
      return compileEmailTemplate(final, autoFillSampleVariables(final, {})).html;
    } catch {
      return "";
    }
  }, [final]);

  const detected = source.trim() ? detectImportFormat(source) : null;
  const load = (file: File): void => {
    void file.text().then((t) => {
      setSource(t);
      setPick("auto");
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8" role="dialog" aria-modal="true" aria-label="Import a template" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className="studio-fade w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_30px_80px_-20px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-slate-900">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-50">Import a template</h2>
            <p className="text-[12.5px] text-slate-500 dark:text-slate-400">From MJML, a React Email component, or any email HTML. Nothing leaves your browser, and code is read, never run.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer rounded-md p-1.5 text-slate-500 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07]"><X size={16} /></button>
        </header>

        <div className="grid gap-0 lg:grid-cols-2">
          <div className="space-y-3 border-b border-slate-200 p-5 lg:border-b-0 lg:border-r dark:border-white/[0.08]">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[260px] flex-1">
                <Segmented<Pick> ariaLabel="Format" value={pick} onChange={setPick} options={[{ value: "auto", label: detected && pick === "auto" ? `Auto · ${detected}` : "Auto" }, { value: "mjml", label: "MJML" }, { value: "react", label: "React Email" }, { value: "html", label: "HTML" }]} />
              </div>
              <Button onClick={() => fileRef.current?.click()}><FileUp size={13} /> Open file</Button>
              <input ref={fileRef} type="file" accept=".mjml,.tsx,.jsx,.html,.htm,.txt,text/html" className="hidden" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
            </div>
            <TextArea
              aria-label="Template source"
              rows={16}
              value={source}
              placeholder={PLACEHOLDER}
              spellCheck={false}
              onChange={(e) => setSource(e.target.value)}
              onDrop={(e) => {
                const f = e.dataTransfer.files[0];
                if (f) {
                  e.preventDefault();
                  load(f);
                }
              }}
            />
            <p className="text-[11.5px] text-slate-500">Limit 2 MB. Drop a file onto the box, or paste.</p>
          </div>

          <div className="min-w-0 space-y-3 p-5">
            {!result ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-1 text-center text-[13px] text-slate-500">
                <p className="font-medium text-slate-700 dark:text-slate-200">Preview appears here</p>
                <p className="max-w-xs text-xs">Blocks, variables and anything that could not be carried over are listed before you add it.</p>
              </div>
            ) : !result.ok || !final ? (
              <div role="alert" className="rounded-lg border border-rose-300/70 bg-rose-50 p-3 text-[13px] text-rose-800 dark:border-rose-400/25 dark:bg-rose-400/10 dark:text-rose-200">
                <p className="font-medium">{result.ok ? "Could not read this" : result.error}</p>
                {!result.ok ? result.issues.slice(0, 5).map((i) => <p key={i} className="mt-1 text-xs">• {i}</p>) : null}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="brand">{result.format === "react" ? "React Email" : result.format.toUpperCase()}</Badge>
                  <Badge>{final.blocks.length} blocks</Badge>
                  <Badge>{final.variables.length} variables</Badge>
                  {result.warnings.length === 0 ? <Badge tone="emerald">No warnings</Badge> : <Badge tone="amber">{result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}</Badge>}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs"><span className="mb-1 block font-semibold uppercase tracking-wider text-slate-500">Name</span><TextInput value={name} placeholder={result.template.name} onChange={(e) => setName(e.target.value)} className="text-xs" /></label>
                  <label className="block text-xs"><span className="mb-1 block font-semibold uppercase tracking-wider text-slate-500">Id</span><TextInput value={final.id} readOnly className="font-mono text-xs" /></label>
                </div>
                {result.warnings.length > 0 ? (
                  <ul className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                    {result.warnings.map((w) => <li key={w} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</li>)}
                  </ul>
                ) : null}
                <iframe title="Imported template preview" sandbox="" srcDoc={html} className="h-72 w-full rounded-lg border border-slate-200 bg-white dark:border-white/10" />
              </>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!final} onClick={() => final && onImport(final)}>Add to workspace</Button>
        </footer>
      </div>
    </div>
  );
}
