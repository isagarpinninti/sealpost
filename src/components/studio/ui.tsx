"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes, type Ref, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@sealpost/react";

const field =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-900 shadow-[0_1px_1px_rgba(0,0,0,0.03)] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-slate-400 hover:border-slate-300 " +
  "focus:border-slate-400 focus:ring-[3px] focus:ring-slate-900/[0.07] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 " +
  "dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-100 dark:shadow-none dark:placeholder:text-slate-500 dark:hover:border-white/20 dark:focus:border-white/30 dark:focus:ring-white/[0.08] dark:disabled:bg-white/[0.02]";

export function Label({ children, hint, className }: { children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{children}</span>
      {hint ? <span className="mb-1 block text-[11px] normal-case tracking-normal text-slate-400 dark:text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...rest} className={cn(field, className)} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cn(field, "font-mono text-xs leading-relaxed", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select {...rest} className={cn(field, "appearance-none pr-8", className)}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function NumberInput({ value, onChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & { value: number; onChange: (n: number) => void }) {
  return (
    <TextInput
      {...rest}
      type="number"
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => {
        const n = e.target.value === "" ? 0 : Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/** Comma-separated list editor that keeps raw text while typing. */
export function TagsInput({ value, onChange, placeholder, mono }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean }) {
  const joined = value.join(", ");
  const [text, setText] = useState(joined);
  const [lastExternal, setLastExternal] = useState(joined);
  if (joined !== lastExternal) {
    setLastExternal(joined);
    setText(joined);
  }
  return (
    <TextInput
      value={text}
      placeholder={placeholder}
      className={mono ? "font-mono text-xs" : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const next = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
        setLastExternal(next.join(", "));
        onChange(next);
      }}
    />
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (t: T) => void; tabs: ReadonlyArray<{ id: T; label: string; badge?: string | number }> }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-white/[0.08]">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "relative -mb-px flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
            value === t.id
              ? "border-slate-900 text-slate-900 dark:border-white dark:text-white"
              : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
          )}
        >
          {t.label}
          {t.badge !== undefined ? (
            <span className="rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{t.badge}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.022em] text-slate-900 dark:text-slate-50">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-slate-500 dark:text-slate-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div> : null}
    </div>
  );
}

export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {description ? <p className="text-xs text-slate-500 dark:text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-slate-200/90 bg-white p-4 dark:border-white/[0.08] dark:bg-slate-900/70", className)}>{children}</div>;
}

export function IconButton({ label, onClick, disabled, children, danger }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/25 disabled:cursor-not-allowed disabled:opacity-30",
        danger ? "hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-400/10 dark:hover:text-rose-300" : "hover:bg-slate-900/[0.05] hover:text-slate-900 dark:hover:bg-white/[0.07] dark:hover:text-slate-100",
      )}
    >
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300/80 px-6 py-10 text-center dark:border-white/[0.12]">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 text-slate-500 shadow-[0_1px_2px_rgba(0,0,0,0.05)] dark:border-white/10 dark:from-white/[0.06] dark:to-white/[0.02] dark:text-slate-400 dark:shadow-none">{icon}</span>
      <div>
        <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-slate-800 dark:text-slate-100">{title}</div>
        {children ? <div className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-slate-500 dark:text-slate-400">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** A figure with a label: the building block of dashboards. */
export function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" | "neutral" }) {
  return (
    <div className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors hover:border-slate-300 dark:border-white/[0.08] dark:bg-slate-900/70 dark:shadow-none dark:hover:border-white/15">
      <p className="text-[11.5px] font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.03em] text-slate-900 tabular-nums dark:text-slate-50">{value}</p>
      {hint ? <p className={cn("mt-2 text-[11.5px]", tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "bad" ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400")}>{hint}</p> : null}
    </div>
  );
}

/** Small stacked bar chart (no chart library): one bar per period, segments from bottom to top. */
export function BarChart({ data, series, height = 120 }: { data: Array<{ label: string; values: number[] }>; series: Array<{ name: string; color: string }>; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.values.reduce((a, b) => a + b, 0)));
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }} role="img" aria-label={`Bar chart: ${series.map((s) => s.name).join(", ")} per day`}>
        {data.map((d) => {
          const total = d.values.reduce((a, b) => a + b, 0);
          return (
            <div key={d.label} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.label}: ${series.map((s, i) => `${s.name} ${d.values[i]}`).join(", ")}`}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px] transition-opacity group-hover:opacity-80" style={{ height: `${Math.max(total > 0 ? 3 : 1, (total / max) * 100)}%` }}>
                {d.values.map((v, i) => (v > 0 ? <div key={series[i].name} style={{ height: `${(v / total) * 100}%`, background: series[i].color }} /> : null))}
                {total === 0 ? <div className="h-full w-full bg-slate-200/70 dark:bg-white/[0.06]" /> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-400">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** Click-outside popover used by the persona menu. */
export function Popover({ trigger, children, align = "right" }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open ? (
        <div
          className={cn(
            "studio-fade absolute top-full z-40 mt-2 min-w-[300px] rounded-xl border border-slate-200 bg-white p-1.5 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.25)] dark:border-slate-700 dark:bg-slate-900",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
