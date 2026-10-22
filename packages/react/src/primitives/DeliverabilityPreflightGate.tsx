"use client";

import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck, Send, Wand2, XCircle } from "lucide-react";
import type { PreflightCheck, PreflightGate, PreflightResult } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, FieldLabel, type BadgeTone } from "../ui";
import { cn } from "../utils";

export interface DeliverabilityPreflightGateProps {
  preflight: PreflightResult | null;
  to: string;
  onToChange: (to: string) => void;
  /** Fills every missing variable from its default or sample value. */
  onAutoFill: () => void;
  onDispatch: () => void;
  dispatching?: boolean;
  dispatchLabel?: string;
}

const GATE: Record<PreflightGate, { tone: BadgeTone; label: string; blurb: string; icon: typeof ShieldCheck; ring: string }> = {
  CLEAR: { tone: "emerald", label: "Clear to send", blurb: "All eight checks passed.", icon: ShieldCheck, ring: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-400/25 dark:bg-emerald-400/[0.05]" },
  WARN: { tone: "amber", label: "Send with warnings", blurb: "Deliverable, but fix the warnings to protect your reputation.", icon: AlertTriangle, ring: "border-amber-200 bg-amber-50/70 dark:border-amber-400/25 dark:bg-amber-400/[0.05]" },
  BLOCKED: { tone: "rose", label: "Blocked", blurb: "A blocking check failed. No socket will be opened.", icon: ShieldAlert, ring: "border-rose-200 bg-rose-50/70 dark:border-rose-400/25 dark:bg-rose-400/[0.05]" },
};

const SEVERITY = { ok: <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />, warn: <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400" />, block: <XCircle size={15} className="text-rose-600 dark:text-rose-400" /> } as const;

const TITLES: Record<PreflightCheck["code"], string> = {
  "EW-101": "Variables & token parity",
  "EW-102": "Header injection guard",
  "EW-103": "Domain & sender alignment",
  "EW-104": "Link & CTA protocols",
  "EW-105": "Subject & preheader",
  "EW-106": "Spam heuristics",
  "EW-107": "Suppression & bounce shield",
  "EW-108": "Idempotency",
};

function Gauge({ score, tone }: { score: number; tone: BadgeTone }) {
  const v = Math.min(100, Math.max(0, score));
  const c = Math.PI * 40;
  const stroke = tone === "emerald" ? "stroke-emerald-500" : tone === "amber" ? "stroke-amber-500" : "stroke-rose-500";
  return (
    <svg width="120" height="76" viewBox="0 0 100 62" role="img" aria-label={`Deliverability score ${v} of 100`}>
      <path d="M10 52 A40 40 0 0 1 90 52" fill="none" strokeWidth="9" strokeLinecap="round" className="stroke-slate-200 dark:stroke-slate-800" />
      <path d="M10 52 A40 40 0 0 1 90 52" fill="none" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} className={cn("transition-all duration-500 ease-out", stroke)} />
      <text x="50" y="50" textAnchor="middle" className="fill-slate-900 text-[22px] font-semibold dark:fill-slate-100" style={{ fontVariantNumeric: "tabular-nums" }}>{v}</text>
    </svg>
  );
}

export function DeliverabilityPreflightGate({ preflight, to, onToChange, onAutoFill, onDispatch, dispatching = false, dispatchLabel = "Dispatch email & seal receipt (evw_)" }: DeliverabilityPreflightGateProps) {
  const g = preflight ? GATE[preflight.gate] : null;
  const blocked = preflight?.gate === "BLOCKED";
  const missing = preflight?.checks.find((c) => c.code === "EW-101" && c.severity === "block");
  return (
    <Card>
      <CardHeader icon={<ShieldCheck size={16} />} title="Deliverability Pre-flight Gate" subtitle="Eight checks, EW-101 to EW-108, before any socket opens" right={g ? <Badge tone={g.tone}>{g.label}</Badge> : <Badge tone="slate">Evaluating…</Badge>} />
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <FieldLabel>Recipient (To)</FieldLabel>
          <input type="email" aria-label="Recipient" value={to} onChange={(e) => onToChange(e.target.value)} placeholder="user@example.org" className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs text-slate-900 shadow-sm outline-none placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-white dark:focus:ring-white/10" />
        </div>
        {preflight && g ? (
          <>
            <div role="status" className={cn("flex items-center gap-4 rounded-lg border p-3.5", g.ring)}>
              <Gauge score={preflight.score} tone={g.tone} />
              <div className="min-w-0">
                <p className="font-mono text-sm font-semibold tracking-tight text-slate-900 dark:text-white">{preflight.gate}</p>
                <p className="text-xs text-slate-600 dark:text-slate-300">{g.blurb}</p>
                {preflight.defaultsUsed.length ? <p className="mt-1 text-[11px] text-slate-500">Defaults used: {preflight.defaultsUsed.join(", ")}</p> : null}
              </div>
            </div>
            <ul className="space-y-2" aria-label="Pre-flight checks">
              {preflight.checks.map((c) => (
                <li key={c.code} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs", c.severity === "ok" ? "border-slate-200 dark:border-slate-800" : c.severity === "warn" ? "border-amber-200 bg-amber-50/50 dark:border-amber-400/25 dark:bg-amber-400/[0.04]" : "border-rose-200 bg-rose-50/50 dark:border-rose-400/25 dark:bg-rose-400/[0.04]")}>
                  <span className="mt-px">{SEVERITY[c.severity]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-800 dark:text-slate-100">{TITLES[c.code]}</span>
                    <span className="block text-slate-600 dark:text-slate-300">{c.message}</span>
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">{c.code}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onAutoFill} className="flex-1" disabled={!missing && !preflight?.checks.some((c) => c.code === "EW-101" && c.severity !== "ok")}>
            <Wand2 size={14} /> Auto-fill sample variables
          </Button>
          <Button variant="amber" disabled={!preflight || blocked || dispatching} onClick={onDispatch} className="flex-1">
            <Send size={14} /> {dispatching ? "Dispatching…" : dispatchLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}
