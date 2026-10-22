"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Inbox, Mail, Menu, Moon, Plus } from "lucide-react";
import { validateTemplate, type DeliveryLedgerRecord, type DnsRecord, type DomainProfile, type EmailTemplate, type Mailbox, type SuppressionEntry } from "@sealpost/core";
import { CommandPalette, type PaletteItem } from "@sealpost/react";
import { localClient, serverClient, type MailClient } from "@/lib/client";
import { usePersisted } from "@/lib/persisted";
import { ApiError, api, getToken, probeServer, setToken, type ServerInfo } from "@/lib/serverApi";
import { DEFAULT_DOMAIN, DEFAULT_TEMPLATES, DEFAULT_WORKSPACE, themeStore, workspaceStore, type WorkspaceExport } from "@/lib/studioStore";
import { DEFAULT_THEME, applyTheme, buildVars, type ThemeMode, type ThemePrefs } from "@/lib/theme";
import type { LogFn, TerminalEvent } from "./log";
import { VIEW_ORDER, VIEW_TITLES, type ViewId } from "./nav";
import { StudioWorkbench, type StudioCommand } from "./StudioWorkbench";
import { TokenGate } from "./TokenGate";
import { Sidebar, VIEW_ICONS } from "./Sidebar";
import { BroadcastView } from "./views/BroadcastView";
import { OverviewView } from "./views/OverviewView";
import { LogsView } from "./views/LogsView";
import { SetupView } from "./views/SetupView";
import { DispatchView } from "./views/DispatchView";
import { DomainView } from "./views/DomainView";
import { LedgerView } from "./views/LedgerView";
import { SdkView } from "./views/SdkView";
import { SettingsView } from "./views/SettingsView";

type MailboxView = Mailbox & { passwordEnvSet?: boolean };

const stripEnvFlag = (m: MailboxView): Mailbox => {
  const { passwordEnvSet, ...rest } = m;
  void passwordEnvSet;
  return rest;
};

interface WorkspaceDto {
  templates: EmailTemplate[];
  domain: DomainProfile;
  transport: "sink" | "smtp";
  mailboxes: MailboxView[];
  dns: DnsRecord[];
  dkimPublicKeyJwk: JsonWebKey;
}

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};
const hhmmss = (): string => new Date().toTimeString().slice(0, 8);

export function StudioShell() {
  const [workspace, setWorkspace] = usePersisted(workspaceStore);
  const [theme, setTheme] = usePersisted(themeStore);
  const [view, setView] = useState<ViewId>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [server, setServer] = useState<ServerInfo | null | false>(null);
  const [serverWs, setServerWs] = useState<WorkspaceDto | null>(null);
  const [localMail, setLocalMail] = useState<MailClient | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [records, setRecords] = useState<DeliveryLedgerRecord[]>([]);
  const [suppressions, setSuppressions] = useState<SuppressionEntry[]>([]);
  const [localDns, setLocalDns] = useState<DnsRecord[]>([]);
  const [version, setVersion] = useState(0);
  const [studioIssues, setStudioIssues] = useState(0);
  const [studioCommand, setStudioCommand] = useState<StudioCommand>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const nextEventId = useRef(1);
  const commandId = useRef(1);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const serverMode = server !== null && server !== false;
  const log = useCallback<LogFn>((kind, text) => {
    setEvents((cur) => [...cur.slice(-199), { id: nextEventId.current++, at: hhmmss(), kind, text }]);
  }, []);

  /* ───── connect: a running `sealpost studio` server, else the browser-only demo ───── */
  const loadFromServer = useCallback(async (): Promise<WorkspaceDto | null> => {
    try {
      const ws = await api<WorkspaceDto>("/api/workspace");
      setServerWs(ws);
      setNeedsToken(false);
      setSyncError(null);
      return ws;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsToken(true);
        setTokenError(getToken() ? "That key was not accepted." : null);
      } else setSyncError(e instanceof Error ? e.message : "Could not load the workspace");
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const info = await probeServer();
      if (!live) return;
      if (info) {
        setServer(info);
        const ws = await loadFromServer();
        // First visit with an unconfigured relay: open the setup wizard once.
        if (live && ws && (ws.transport === "sink" || ws.mailboxes.length === 0 || ws.domain.domain === "mail.example.com")) {
          try {
            if (window.localStorage.getItem("sealpost-setup-seen") !== "1") {
              window.localStorage.setItem("sealpost-setup-seen", "1");
              setView("setup");
            }
          } catch {
            /* storage unavailable: stay on the default view */
          }
        }
      } else {
        const c = await localClient();
        if (!live) return;
        setServer(false);
        setLocalMail(c);
      }
    })();
    return () => {
      live = false;
    };
  }, [loadFromServer]);

  // The server client is derived, not stored: it needs the server's DKIM public key, which arrives with the workspace.
  const dkimN = serverWs?.dkimPublicKeyJwk.n ?? "";
  const client = useMemo<MailClient | null>(() => (server ? serverClient(server, serverWs?.dkimPublicKeyJwk ?? {}) : localMail), [server, localMail, serverWs?.dkimPublicKeyJwk, dkimN]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───── workspace (server files, or this browser) ───── */
  const templates = useMemo<EmailTemplate[]>(() => (serverMode ? (serverWs?.templates ?? []) : (workspace.templates ?? DEFAULT_TEMPLATES)), [serverMode, serverWs, workspace.templates]);
  const domain: DomainProfile = serverMode ? (serverWs?.domain ?? DEFAULT_DOMAIN) : (workspace.domain ?? DEFAULT_DOMAIN);
  const mailboxes: Mailbox[] = useMemo(() => (serverMode ? (serverWs?.mailboxes ?? []).map(stripEnvFlag) : (workspace.mailboxes ?? [])), [serverMode, serverWs, workspace.mailboxes]);
  const transport: "sink" | "smtp" = serverMode ? (serverWs?.transport ?? "sink") : "sink";
  const template = templates.find((t) => t.id === selected) ?? templates[0] ?? null;
  const passwordEnvSet = useMemo(() => Object.fromEntries((serverWs?.mailboxes ?? []).map((m) => [m.id, Boolean(m.passwordEnvSet)])), [serverWs]);

  const commit = useCallback(
    (next: { templates?: EmailTemplate[]; domain?: DomainProfile; transport?: "sink" | "smtp"; mailboxes?: Mailbox[] }): void => {
      if (serverMode) {
        const merged = { templates, domain, transport, mailboxes: mailboxes, ...next };
        setServerWs((cur) => (cur ? { ...cur, ...next, mailboxes: next.mailboxes ?? cur.mailboxes } : cur));
        if (pushTimer.current) clearTimeout(pushTimer.current);
        pushTimer.current = setTimeout(() => {
          api<WorkspaceDto & { ok: boolean }>("/api/workspace", { method: "PUT", body: { templates: merged.templates, domain: merged.domain, transport: merged.transport, mailboxes: merged.mailboxes } })
            .then((ws) => {
              setServerWs(ws);
              setSyncError(null);
            })
            .catch((e: unknown) => setSyncError(e instanceof Error ? e.message : "Could not save the workspace"));
        }, 600);
      } else setWorkspace({ ...workspace, templates: next.templates ?? workspace.templates, domain: next.domain ?? workspace.domain, mailboxes: next.mailboxes ?? workspace.mailboxes });
    },
    [serverMode, templates, domain, transport, mailboxes, workspace, setWorkspace],
  );

  const saveTemplate = (t: EmailTemplate): void => commit({ templates: templates.some((x) => x.id === t.id) ? templates.map((x) => (x.id === t.id ? t : x)) : [...templates, t] });
  const deleteTemplate = (id: string): void => {
    const next = templates.filter((t) => t.id !== id);
    if (next.length === 0) return;
    commit({ templates: next });
    if (selected === id) setSelected(next[0].id);
    log("warn", `Deleted template ${id}`);
  };

  /* ───── ledger, suppressions, DNS ───── */
  useEffect(() => {
    if (!client) return;
    let live = true;
    void client.ledger().then((r) => live && setRecords(r)).catch(() => undefined);
    void client.suppressions().then((s) => live && setSuppressions(s)).catch(() => undefined);
    if (client.mode === "local") void client.dns(domain).then((d) => live && setLocalDns(d)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, version, domain]);
  const dns = serverMode ? (serverWs?.dns ?? []) : localDns;

  /* ───── theme ───── */
  useEffect(() => {
    applyTheme(theme);
    if (theme.mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  const updateTheme = (patch: Partial<Pick<ThemePrefs, "mode" | "accent" | "radius" | "textSize">>): void => {
    const next = { ...theme, ...patch };
    setTheme({ ...next, vars: buildVars(next.accent, next.radius, next.textSize) });
  };
  const cycleTheme = (): void => {
    const order: ThemeMode[] = ["light", "dark", "system"];
    updateTheme({ mode: order[(order.indexOf(theme.mode) + 1) % order.length] });
  };

  /* ───── export / import ───── */
  const exportWorkspace = (): void => {
    const payload: WorkspaceExport = { format: "sealpost.workspace/1", exportedAt: new Date().toISOString(), templates, domain, mailboxes: mailboxes };
    download("sealpost-workspace.json", `${JSON.stringify(payload, null, 2)}\n`, "application/json");
    log("info", `Exported ${templates.length} template${templates.length === 1 ? "" : "s"}`);
  };
  const importWorkspace = (file: File): void => {
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Partial<WorkspaceExport>;
        if (parsed.format !== "sealpost.workspace/1" || !Array.isArray(parsed.templates)) throw new Error("Not an Sealpost workspace export (expected format sealpost.workspace/1).");
        const errors: string[] = [];
        const valid: EmailTemplate[] = [];
        for (const raw of parsed.templates) {
          const v = validateTemplate(raw);
          if (v.ok && v.template) valid.push(v.template);
          else errors.push(...v.errors.slice(0, 3));
        }
        if (errors.length) throw new Error(errors.join("\n"));
        if (valid.length === 0) throw new Error("The file needs at least one template.");
        commit({ templates: valid, ...(parsed.domain ? { domain: parsed.domain } : {}), ...(parsed.mailboxes ? { mailboxes: parsed.mailboxes } : {}) });
        setSelected(valid[0].id);
        setImportError(null);
        log("ok", `Imported ${valid.length} template(s)`);
      } catch (e) {
        setImportError(e instanceof Error ? e.message : "Could not import the file");
      }
    });
  };

  /* ───── navigation & shortcuts ───── */
  const studioCmd = (name: "new-template" | "focus-filter"): void => {
    setView("studio");
    setStudioCommand({ id: commandId.current++, name });
  };
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyRef.current = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        exportWorkspace();
      } else if ((mod || e.altKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        setView(VIEW_ORDER[Number(e.key) - 1]);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setView("settings");
      } else if (!mod && !e.altKey && !isTyping(e.target) && view === "studio") {
        if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          studioCmd("new-template");
        } else if (e.key === "/") {
          e.preventDefault();
          studioCmd("focus-filter");
        }
      }
    };
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const openTemplate = (id: string, v: ViewId): void => {
    setSelected(id);
    setView(v);
  };

  const paletteItems: PaletteItem[] = [
    ...VIEW_ORDER.map((id, i): PaletteItem => {
      const Icon = VIEW_ICONS[id];
      return { id: `view-${id}`, group: "Go to", label: VIEW_TITLES[id], hint: id === "settings" ? "⌘," : i < 9 ? `⌘${i + 1}` : undefined, icon: <Icon size={14} />, run: () => setView(id) };
    }),
    ...templates.map((t): PaletteItem => ({ id: `tpl-${t.id}`, group: "Edit a template", label: t.name, hint: t.category, icon: <Mail size={14} />, keywords: `${t.id} ${t.description}`, run: () => openTemplate(t.id, "studio") })),
    ...templates.map((t): PaletteItem => ({ id: `send-${t.id}`, group: "Dispatch a template", label: t.name, icon: <Inbox size={14} />, keywords: t.id, run: () => openTemplate(t.id, "dispatch") })),
    { id: "act-theme", group: "Actions", label: "Cycle theme (light / dark / system)", icon: <Moon size={14} />, run: cycleTheme },
    { id: "act-new", group: "Actions", label: "Create a new template", hint: "N", icon: <Plus size={14} />, run: () => studioCmd("new-template") },
    { id: "act-export", group: "Actions", label: "Export Studio configuration as JSON", hint: "⌘S", icon: <Download size={14} />, run: exportWorkspace },
  ];

  const pane = (id: ViewId, children: React.ReactNode, padded = true) => (
    <div hidden={view !== id} className={padded ? "studio-fade h-full overflow-y-auto" : "studio-fade h-full min-h-0"}>
      {padded ? <div className="mx-auto w-full max-w-[1180px] px-5 py-8 lg:px-10 lg:py-10">{children}</div> : children}
    </div>
  );
  const mode = server === null ? "connecting" : serverMode ? "server" : "local";
  const setupIncomplete = serverMode && (transport === "sink" || mailboxes.length === 0 || domain.domain === "mail.example.com");
  const projectName = server ? server.project : "Sealpost";
  const sidebar = (onClose?: () => void) => (
    <Sidebar view={view} onView={setView} project={projectName} domain={domain.domain} mode={mode} fingerprint={client?.receiptFingerprint ?? null} themeMode={theme.mode} onCycleTheme={cycleTheme} onPalette={() => setPaletteOpen(true)} onExport={exportWorkspace} badges={{ ledger: records.length || undefined }} setupIncomplete={setupIncomplete} onClose={onClose} />
  );
  const issueCount = studioIssues || (syncError ? 1 : 0);
  const Crumb = VIEW_ICONS[view];

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div className="hidden lg:flex">{sidebar()}</div>
      {menuOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="studio-fade h-full shadow-2xl">{sidebar(() => setMenuOpen(false))}</div>
          <button type="button" aria-label="Close menu" className="flex-1 cursor-default bg-black/50 backdrop-blur-[2px]" onClick={() => setMenuOpen(false)} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-30 flex h-12 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-white/70 px-4 backdrop-blur-xl lg:px-6 dark:border-white/[0.07] dark:bg-slate-950/70">
          <button type="button" aria-label="Open menu" onClick={() => setMenuOpen(true)} className="-ml-1 cursor-pointer rounded-md p-1.5 text-slate-600 hover:bg-slate-900/[0.05] lg:hidden dark:text-slate-300 dark:hover:bg-white/[0.07]"><Menu size={17} /></button>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="hidden truncate text-slate-500 sm:inline">{projectName}</span>
            <span aria-hidden className="hidden text-slate-300 sm:inline dark:text-slate-700">/</span>
            <span className="flex items-center gap-1.5 truncate font-medium text-slate-900 dark:text-slate-100"><Crumb size={14} strokeWidth={1.8} className="shrink-0 text-slate-500" />{VIEW_TITLES[view]}</span>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium sm:inline-flex ${issueCount === 0 ? "border-slate-200 text-slate-600 dark:border-white/10 dark:text-slate-300" : "border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"}`} title={issueCount === 0 ? "All template changes are applied" : "Fix the issues to apply changes"}>
              <span className={`h-1.5 w-1.5 rounded-full ${issueCount === 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
              {issueCount === 0 ? "Synced" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`}
            </span>
          </div>
        </header>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        onFreeText={(t) => {
          const hit = templates.find((x) => `${x.name} ${x.id} ${x.category}`.toLowerCase().includes(t.toLowerCase()));
          if (hit) openTemplate(hit.id, "studio");
        }}
      />
      {needsToken ? <TokenGate project={server ? server.project : "Sealpost"} error={tokenError} onSubmit={(t) => { setToken(t); void loadFromServer(); }} /> : null}
      {server === false ? (
        <div role="note" className="shrink-0 border-b border-amber-300/60 bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
          <b>Local demo</b> — templates, DKIM signing and receipts run in this browser, but a browser cannot open SMTP sockets, so delivery is captured locally. Run <code className="font-mono">npx @sealpost/cli studio</code> for real SMTP, a test inbox, retries and tracking.
        </div>
      ) : null}
      <main className="min-h-0 flex-1 overflow-hidden">
        {syncError ? <p role="alert" className="m-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-200">{syncError}</p> : null}
        {pane("overview", <OverviewView client={client} templates={templates.length} ledgerCount={records.length} setup={{ domain: domain.domain !== "mail.example.com", relay: transport === "smtp" && mailboxes.length > 0 }} onView={setView} />)}
        {pane("studio", <StudioWorkbench templates={templates} domain={domain} selectedId={template?.id ?? null} onSelect={setSelected} onSave={saveTemplate} onDelete={deleteTemplate} onIssues={setStudioIssues} events={events} onClearEvents={() => setEvents([])} log={log} client={client} command={studioCommand} onSent={() => setVersion((v) => v + 1)} />, false)}
        {pane("dispatch", <DispatchView client={client} templates={templates} template={template} domain={domain} onTemplate={setSelected} log={log} inboxVersion={version} onSent={() => setVersion((v) => v + 1)} />)}
        {pane("domain", <DomainView client={client} domain={domain} onDomain={(d) => commit({ domain: d })} dns={dns} mailboxes={mailboxes} onMailboxes={(m) => commit({ mailboxes: m })} transport={transport} onTransport={serverMode ? (t) => commit({ transport: t }) : undefined} passwordEnvSet={passwordEnvSet} suppressions={suppressions} onSuppressions={setSuppressions} />)}
        {pane("ledger", <LedgerView client={client} records={records} onClear={client?.clearLedger ? () => { client.clearLedger?.(); setVersion((v) => v + 1); } : undefined} />)}
        {pane("setup", <SetupView domain={domain} mailboxes={mailboxes} transport={transport} dns={dns} passwordEnvSet={passwordEnvSet} templates={templates} onChanged={loadFromServer} onDone={() => setView("logs")} />)}
        {pane("logs", <LogsView client={client} />)}
        {pane("broadcast", <BroadcastView client={client} templates={templates} />)}
        {pane("sdk", <SdkView templates={templates} template={template} onTemplate={setSelected} />)}
        {pane(
          "settings",
          <SettingsView
            prefs={theme}
            onPrefs={updateTheme}
            onResetTheme={() => setTheme(DEFAULT_THEME)}
            onExport={exportWorkspace}
            onImport={importWorkspace}
            onResetWorkspace={() => {
              if (serverMode) commit({ templates: DEFAULT_TEMPLATES });
              else setWorkspace(DEFAULT_WORKSPACE);
              setImportError(null);
              setSelected(null);
              log("warn", "Workspace reset to the built-in templates");
            }}
            importError={importError}
            counts={{ templates: templates.length, variables: templates.reduce((n, t) => n + t.variables.length, 0), ledger: records.length }}
            mode={mode}
            fingerprint={client?.receiptFingerprint ?? null}
          />,
        )}
      </main>
      </div>
    </div>
  );
}
