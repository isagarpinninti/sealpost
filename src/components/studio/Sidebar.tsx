"use client";

import { Activity, BookOpen, Command, Download, FileSignature, Globe, LayoutDashboard, Mail, Megaphone, Monitor, Moon, Rocket, Search, Send, Settings, Sun, X } from "lucide-react";
import { Kbd, cn } from "@sealpost/react";
import { SealpostLogo } from "@/components/brand/SealpostLogo";
import type { ThemeMode } from "@/lib/theme";
import { NAV_GROUPS, VIEW_ORDER, VIEW_TITLES, type ViewId } from "./nav";

export const VIEW_ICONS: Record<ViewId, typeof Mail> = {
  overview: LayoutDashboard,
  studio: Mail,
  dispatch: Send,
  broadcast: Megaphone,
  logs: Activity,
  ledger: FileSignature,
  domain: Globe,
  setup: Rocket,
  sdk: BookOpen,
  settings: Settings,
};

interface Props {
  view: ViewId;
  onView: (v: ViewId) => void;
  project: string;
  domain: string;
  mode: "connecting" | "server" | "local";
  fingerprint: string | null;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
  onPalette: () => void;
  onExport: () => void;
  /** Counts shown beside an item. */
  badges?: Partial<Record<ViewId, number>>;
  /** Setup is unfinished: shows a dot beside it. */
  setupIncomplete?: boolean;
  /** Rendered inside the mobile drawer. */
  onClose?: () => void;
}

/** Left navigation: grouped sections, a search/command entry, and a status footer. */
export function Sidebar({ view, onView, project, domain, mode, fingerprint, themeMode, onCycleTheme, onPalette, onExport, badges = {}, setupIncomplete = false, onClose }: Props) {
  const item = (id: ViewId) => {
    const Icon = VIEW_ICONS[id];
    const active = view === id;
    const index = VIEW_ORDER.indexOf(id) + 1;
    return (
      <button
        key={id}
        type="button"
        onClick={() => {
          onView(id);
          onClose?.();
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium tracking-[-0.005em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/25",
          active ? "bg-slate-900/[0.06] text-slate-900 dark:bg-white/[0.08] dark:text-white" : "text-slate-600 hover:bg-slate-900/[0.04] hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/[0.05] dark:hover:text-slate-100",
        )}
      >
        {active ? <span aria-hidden className="absolute -left-2 top-2 bottom-2 w-[2px] rounded-full bg-slate-900 dark:bg-white" /> : null}
        <Icon size={15} strokeWidth={1.8} className={cn("shrink-0 transition-opacity", active ? "opacity-100" : "opacity-60 group-hover:opacity-90")} />
        <span className="min-w-0 flex-1 truncate">{VIEW_TITLES[id]}</span>
        {id === "setup" && setupIncomplete ? <span title="Setup is not finished" className="h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
        {badges[id] ? <span className="rounded-full bg-slate-900/[0.07] px-1.5 text-[10px] font-semibold tabular-nums text-slate-600 dark:bg-white/10 dark:text-slate-300">{badges[id]}</span> : null}
        {index <= 9 && !badges[id] ? <Kbd className="hidden border-transparent bg-transparent opacity-0 transition-opacity group-hover:opacity-100 lg:inline-flex">⌘{index}</Kbd> : null}
      </button>
    );
  };

  const ThemeIcon = themeMode === "dark" ? Moon : themeMode === "system" ? Monitor : Sun;
  return (
    <aside className="flex h-full w-[236px] shrink-0 flex-col border-r border-slate-200/80 bg-white/80 backdrop-blur dark:border-white/[0.07] dark:bg-slate-950">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <button type="button" onClick={() => { onView("overview"); onClose?.(); }} aria-label="Sealpost overview" className="cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/25">
          <SealpostLogo size="sm" showBadge={false} />
        </button>
        {onClose ? <button type="button" aria-label="Close menu" onClick={onClose} className="cursor-pointer rounded-md p-1 text-slate-500 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07]"><X size={16} /></button> : null}
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={() => { onPalette(); onClose?.(); }}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] text-slate-500 shadow-[0_1px_1px_rgba(0,0,0,0.03)] transition-colors hover:border-slate-300 hover:text-slate-700 dark:border-white/10 dark:bg-white/[0.03] dark:shadow-none dark:hover:border-white/20 dark:hover:text-slate-200"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search</span>
          <Kbd><Command size={9} />K</Kbd>
        </button>
      </div>

      <nav aria-label="Primary" className="mt-4 flex-1 space-y-5 overflow-y-auto px-3 pb-3">
        {NAV_GROUPS.map((g, i) => (
          <div key={g.label ?? i} className="space-y-0.5">
            {g.label ? <p className="px-2.5 pb-1 text-[11px] font-medium text-slate-400 dark:text-slate-500">{g.label}</p> : null}
            {g.items.map((id) => (id === "setup" && !setupIncomplete && view !== "setup" ? null : item(id)))}
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-slate-200/80 p-3 dark:border-white/[0.07]">
        {item("settings")}
        <div className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-2.5 dark:border-white/[0.08] dark:bg-white/[0.025]">
          <div className="flex items-center gap-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
            <span className={cn("h-1.5 w-1.5 rounded-full", mode === "server" ? "bg-emerald-500" : mode === "local" ? "bg-amber-500" : "bg-slate-400")} />
            {mode === "server" ? "Connected" : mode === "local" ? "Local demo" : "Connecting…"}
            <span className="ml-auto truncate font-mono text-[10.5px] font-normal text-slate-500">{mode === "server" ? "server" : mode === "local" ? "browser" : ""}</span>
          </div>
          <p className="mt-1 truncate font-mono text-[10.5px] text-slate-500" title={domain}>{project} · {domain}</p>
          <p className="truncate font-mono text-[10.5px] text-slate-400" title="Receipt-signing key fingerprint">{fingerprint ? `ecdsa_${fingerprint.slice(0, 6)}…${fingerprint.slice(-3)}` : "generating key…"}</p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onCycleTheme} aria-label={`Theme: ${themeMode}. Click to change`} title={`Theme: ${themeMode}`} className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] text-slate-500 hover:bg-slate-900/[0.05] hover:text-slate-800 dark:hover:bg-white/[0.06] dark:hover:text-slate-100"><ThemeIcon size={14} /> <span className="capitalize">{themeMode}</span></button>
          <button type="button" onClick={onExport} aria-label="Export workspace as JSON" title="Export workspace as JSON (⌘S)" className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] text-slate-500 hover:bg-slate-900/[0.05] hover:text-slate-800 dark:hover:bg-white/[0.06] dark:hover:text-slate-100"><Download size={14} /> Export</button>
        </div>
      </div>
    </aside>
  );
}
