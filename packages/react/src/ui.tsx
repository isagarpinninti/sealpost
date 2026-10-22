import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./utils";

/* ───────────── Root scope (resets + theme hook for host apps) ───────────── */

export function SurfaceRoot({
  theme,
  className,
  children,
}: {
  /** Force a theme. Omit to inherit a `.dark` class from an ancestor. */
  theme?: "light" | "dark";
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("ew-root", theme === "dark" && "dark", className)}>{children}</div>;
}

/* ───────────── Surfaces ───────────── */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        "ew-animate-in @container overflow-hidden rounded-xl border border-slate-200/90 bg-white",
        "shadow-[0_1px_0_rgba(0,0,0,0.02),0_1px_2px_rgba(0,0,0,0.04)]",
        "dark:border-white/[0.08] dark:bg-slate-900/70 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  icon,
  title,
  subtitle,
  right,
  accent = "brand",
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  accent?: "brand" | "amber";
}) {
  void accent;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/90 px-4 py-3 sm:px-5 dark:border-white/[0.08]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300">{icon}</span>
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-50">{title}</h2>
          {subtitle ? <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
        </div>
      </div>
      {right}
    </header>
  );
}

/* ───────────── Badges ───────────── */

export type BadgeTone = "brand" | "cyan" | "emerald" | "amber" | "rose" | "slate";

const TONES: Record<BadgeTone, string> = {
  brand: "bg-slate-900/[0.05] text-slate-800 ring-slate-900/10 dark:bg-white/[0.08] dark:text-slate-100 dark:ring-white/15",
  cyan: "bg-cyan-500/10 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-400/10 dark:text-cyan-300 dark:ring-cyan-400/25",
  emerald: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  amber: "bg-amber-500/10 text-amber-700 ring-amber-600/25 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/25",
  rose: "bg-rose-500/10 text-rose-700 ring-rose-600/20 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-400/25",
  slate: "bg-slate-500/[0.07] text-slate-600 ring-slate-500/15 dark:bg-white/[0.05] dark:text-slate-300 dark:ring-white/10",
};

export function Badge({ tone = "slate", className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: BadgeTone }) {
  const color: Record<BadgeTone, string> = {
    brand: "bg-brand-500",
    cyan: "bg-cyan-500",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
    slate: "bg-slate-400",
  };
  return <span className={cn("inline-block h-1.5 w-1.5 rounded-full", color[tone])} />;
}

/* ───────────── Buttons ───────────── */

type ButtonVariant = "primary" | "secondary" | "amber" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-slate-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:shadow-none dark:hover:bg-slate-200 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none dark:disabled:bg-white/10 dark:disabled:text-slate-500",
  secondary:
    "border border-slate-200 bg-white text-slate-700 shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:bg-slate-50 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:shadow-none dark:hover:bg-white/[0.08] dark:hover:border-white/20 disabled:text-slate-400 dark:disabled:text-slate-600",
  amber:
    "bg-slate-900 text-white hover:bg-slate-800 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200",
  danger:
    "border border-rose-300/70 bg-white text-rose-700 hover:bg-rose-50 dark:border-rose-400/30 dark:bg-transparent dark:text-rose-300 dark:hover:bg-rose-400/10",
  ghost: "text-slate-600 hover:bg-slate-900/[0.05] dark:text-slate-300 dark:hover:bg-white/[0.07]",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-7 rounded-md px-2.5 text-xs",
  md: "h-8 rounded-lg px-3 text-[13px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium tracking-[-0.005em] transition-[background,border-color,color,box-shadow] duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/25 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-white/30 dark:focus-visible:ring-offset-slate-950",
        "disabled:cursor-not-allowed disabled:opacity-70",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A keyboard key cap, for shortcut hints. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] font-medium text-slate-500 dark:border-white/10 dark:bg-white/[0.05] dark:text-slate-400", className)}>
      {children}
    </kbd>
  );
}

/* ───────────── Form controls ───────────── */

export function FieldLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{children}</span>
      {right}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const move = (dir: 1 | -1): void => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
      className="inline-flex w-full flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5 ring-1 ring-inset ring-slate-200/70 dark:bg-white/[0.05] dark:ring-white/[0.07]"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-50",
            value === o.value
              ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)] ring-1 ring-slate-200 dark:bg-white/[0.1] dark:text-white dark:shadow-none dark:ring-white/10"
              : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  locked,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  locked?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      disabled={locked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:cursor-not-allowed",
        checked ? "bg-slate-900 dark:bg-white" : "bg-slate-300 dark:bg-white/15",
        locked && "opacity-80",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform dark:bg-slate-950 dark:data-[on=false]:bg-white",
          checked ? "translate-x-4.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/* ───────────── Data viz ───────────── */

const METER_COLOR: Record<BadgeTone, string> = {
  brand: "from-brand-500 to-brand-400",
  cyan: "from-cyan-500 to-cyan-400",
  emerald: "from-emerald-500 to-emerald-400",
  amber: "from-amber-500 to-amber-400",
  rose: "from-rose-500 to-rose-400",
  slate: "from-slate-400 to-slate-300",
};

export function Meter({ value, max, tone, label }: { value: number; max: number; tone: BadgeTone; label?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(3, (value / max) * 100));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
    >
      <div className={cn("h-full rounded-full bg-gradient-to-r transition-all duration-500 ease-out", METER_COLOR[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 0–100 risk gauge rendered as a 180° arc. */
export function RiskGauge({ score, size = 72 }: { score: number; size?: number }) {
  const clamped = Math.min(100, Math.max(0, score));
  const r = 40;
  const c = Math.PI * r;
  const tone = clamped >= 60 ? "stroke-rose-500" : clamped >= 35 ? "stroke-amber-500" : "stroke-emerald-500";
  return (
    <svg width={size} height={size / 1.6} viewBox="0 0 100 62" role="img" aria-label={`Risk score ${clamped} of 100`}>
      <path d="M10 52 A40 40 0 0 1 90 52" fill="none" strokeWidth="9" strokeLinecap="round" className="stroke-slate-200 dark:stroke-slate-800" />
      <path
        d="M10 52 A40 40 0 0 1 90 52"
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * c} ${c}`}
        className={cn("transition-all duration-500 ease-out", tone)}
      />
      <text x="50" y="50" textAnchor="middle" className="fill-slate-900 text-[22px] font-semibold dark:fill-slate-100" style={{ fontVariantNumeric: "tabular-nums" }}>
        {clamped}
      </text>
    </svg>
  );
}
