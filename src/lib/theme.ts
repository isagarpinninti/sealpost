export type ThemeMode = "light" | "dark" | "system";
export type AccentId = "mono" | "indigo" | "violet" | "blue" | "teal" | "rose" | "amber" | "graphite";
export type RadiusId = "sharp" | "default" | "soft";
export type TextSizeId = "compact" | "default" | "large";

export interface ThemePrefs {
  mode: ThemeMode;
  accent: AccentId;
  radius: RadiusId;
  textSize: TextSizeId;
  /** Resolved CSS custom properties, applied before first paint by an inline script. */
  vars: Record<string, string>;
}

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700] as const;

export const ACCENTS: Record<AccentId, { label: string; swatch: string; scale: readonly string[] }> = {
  mono: { label: "Monochrome", swatch: "#111111", scale: ["#f4f4f4", "#eaeaea", "#d6d6d6", "#e8e8e8", "#ffffff", "#9a9a9a", "#111111", "#000000"] },
  indigo: { label: "Indigo", swatch: "#4f46e5", scale: ["#eef2ff", "#e0e7ff", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#4338ca"] },
  violet: { label: "Violet", swatch: "#7c3aed", scale: ["#f5f3ff", "#ede9fe", "#ddd6fe", "#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#6d28d9"] },
  blue: { label: "Azure", swatch: "#2563eb", scale: ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8"] },
  teal: { label: "Teal", swatch: "#0d9488", scale: ["#f0fdfa", "#ccfbf1", "#99f6e4", "#5eead4", "#2dd4bf", "#14b8a6", "#0d9488", "#0f766e"] },
  rose: { label: "Rose", swatch: "#e11d48", scale: ["#fff1f2", "#ffe4e6", "#fecdd3", "#fda4af", "#fb7185", "#f43f5e", "#e11d48", "#be123c"] },
  amber: { label: "Amber Gold", swatch: "#d97706", scale: ["#fffbeb", "#fef3c7", "#fde68a", "#fcd34d", "#fbbf24", "#f59e0b", "#d97706", "#b45309"] },
  graphite: { label: "Graphite", swatch: "#27272a", scale: ["#f8fafc", "#f1f5f9", "#e2e8f0", "#cbd5e1", "#e2e8f0", "#64748b", "#1e293b", "#0f172a"] },
};

export const RADII: Record<RadiusId, { label: string; vars: Record<string, string> }> = {
  sharp: { label: "Sharp", vars: { "--r-md": "0.125rem", "--r-lg": "0.25rem", "--r-xl": "0.375rem", "--r-2xl": "0.5rem" } },
  default: { label: "Refined", vars: { "--r-md": "0.375rem", "--r-lg": "0.5rem", "--r-xl": "0.75rem", "--r-2xl": "1rem" } },
  soft: { label: "Soft", vars: { "--r-md": "0.5rem", "--r-lg": "0.75rem", "--r-xl": "1rem", "--r-2xl": "1.25rem" } },
};

export const TEXT_SIZES: Record<TextSizeId, { label: string; px: string }> = {
  compact: { label: "Compact", px: "14px" },
  default: { label: "Comfortable", px: "16px" },
  large: { label: "Large", px: "17.5px" },
};

export function buildVars(accent: AccentId, radius: RadiusId, textSize: TextSizeId): Record<string, string> {
  const vars: Record<string, string> = { ...RADII[radius].vars, "--ew-font-size": TEXT_SIZES[textSize].px };
  STEPS.forEach((step, i) => {
    vars[`--accent-${step}`] = ACCENTS[accent].scale[i];
  });
  return vars;
}

export const THEME_KEY = "sealpost-theme-v2";

export const DEFAULT_THEME: ThemePrefs = {
  mode: "dark",
  accent: "mono",
  radius: "default",
  textSize: "default",
  vars: buildVars("mono", "default", "default"),
};

export function resolveDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Applies prefs to <html> immediately (the store persists them for the next load). */
export function applyTheme(prefs: ThemePrefs): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveDark(prefs.mode));
  for (const [k, val] of Object.entries(prefs.vars)) root.style.setProperty(k, val);
}

/** Inline script (runs before paint) mirroring `applyTheme`. */
export const THEME_BOOT_SCRIPT =
  "try{var d=document.documentElement;var p=JSON.parse(localStorage.getItem('sealpost-theme-v2')||'null');if(!p){d.classList.add('dark')}else{" +
  "var k=p.mode==='dark'||(p.mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);d.classList.toggle('dark',k);" +
  "for(var n in p.vars)d.style.setProperty(n,p.vars[n]);}}catch(e){}";
