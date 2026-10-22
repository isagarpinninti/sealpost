interface SealpostLogoProps {
  className?: string;
  iconOnly?: boolean;
  size?: "sm" | "md" | "lg";
  showBadge?: boolean;
}

const SIZES = {
  sm: { box: 22, text: "text-base", badge: "text-[10px] px-1.5 py-0.5" },
  md: { box: 28, text: "text-lg", badge: "text-[11px] px-2 py-0.5" },
  lg: { box: 38, text: "text-2xl", badge: "text-xs px-2.5 py-0.5" },
} as const;

/** A geometric diplomat's envelope folded into a high-velocity paper-plane dispatch vector with an amber seal dot. */
export function SealpostLogo({ className = "", iconOnly = false, size = "md", showBadge = true }: SealpostLogoProps) {
  const d = SIZES[size];
  return (
    <div className={`inline-flex select-none items-center gap-2.5 text-slate-900 dark:text-white ${className}`}>
      <svg width={d.box} height={d.box} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0" role="img" aria-label="Sealpost logo mark">
        <path d="M4 7.5C4 6.39543 4.89543 5.5 6 5.5H26C27.1046 5.5 28 6.39543 28 7.5V24.5C28 25.6046 27.1046 26.5 26 26.5H6C4.89543 26.5 4 25.6046 4 24.5V7.5Z" stroke="currentColor" strokeWidth="2.4" />
        <path d="M4.5 8L16 17.2L27.5 8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M16 17.2L22 22.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="16" cy="17.2" r="2.5" fill="#F59E0B" />
      </svg>
      {!iconOnly && (
        <div className="flex items-center gap-2">
          <span className={`font-semibold tracking-tight ${d.text}`}>Sealpost</span>
          {showBadge && <span className={`rounded-md border border-slate-300 font-mono font-medium uppercase tracking-wider text-slate-500 dark:border-white/15 dark:text-slate-400 ${d.badge}`}>MAIL OS</span>}
        </div>
      )}
    </div>
  );
}
