"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, CornerUpLeft, Mail, MousePointerClick } from "lucide-react";
import { Badge, Card, CardHeader, type BadgeTone } from "@sealpost/react";
import type { MailClient } from "@/lib/client";
import { api } from "@/lib/serverApi";
import { EmptyState, PageHeader, Select, TextInput } from "../ui";
import { ReceivedPanel } from "./ReceivedPanel";
import { ScheduledPanel } from "./ScheduledPanel";

type Status = "queued" | "delivered" | "failed" | "bounced" | "complained" | "deferred";
interface EmailEventRow {
  type: Status | "opened" | "clicked" | "replied";
  atIso: string;
  detail?: string;
  url?: string;
}
interface EmailRow {
  id: string;
  createdAtIso: string;
  from: string;
  to: string[];
  subject: string;
  templateId: string;
  domain: string;
  tags: Array<{ name: string; value: string }>;
  metadata: Record<string, string>;
  status: Status;
  opens: number;
  clicks: number;
  replies?: number;
  receiptId?: string;
  events: EmailEventRow[];
}
interface Page {
  data: EmailRow[];
  hasMore: boolean;
  nextCursor: string | null;
}
interface Stats {
  sent: number;
  queued: number;
  suppressed: number;
  uniqueOpens: number;
  uniqueClicks: number;
  bounces: number;
  complaints: number;
  openRate: number;
  bounceRate: number;
}

const TONE: Record<string, BadgeTone> = { replied: "cyan", delivered: "emerald", queued: "amber", deferred: "amber", failed: "rose", bounced: "rose", complained: "rose", opened: "cyan", clicked: "cyan" };
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Every accepted email, newest first, with its status timeline. Server mode only. */
export function LogsView({ client }: { client: MailClient | null }) {
  const server = client?.mode === "server";
  const [status, setStatus] = useState("");
  const [to, setTo] = useState("");
  const [tag, setTag] = useState("");
  const [rows, setRows] = useState<EmailRow[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"sent" | "received" | "scheduled">("sent");

  const query = useCallback((before?: string): string => {
    const q = new URLSearchParams({ limit: "25" });
    if (status) q.set("status", status);
    if (to.trim()) q.set("to", to.trim());
    if (tag.trim()) q.set("tag", tag.trim());
    if (before) q.set("before", before);
    return `/api/emails?${q.toString()}`;
  }, [status, to, tag]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!server) return;
    try {
      const [p, s] = await Promise.all([api<Page>(query()), api<Stats>("/api/stats")]);
      setRows(p.data);
      setMore(p.hasMore ? p.nextCursor : null);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the logs");
    }
  }, [server, query]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 4000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  const loadMore = async (): Promise<void> => {
    if (!more) return;
    try {
      const p = await api<Page>(query(more));
      setRows((cur) => [...cur, ...p.data]);
      setMore(p.hasMore ? p.nextCursor : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    }
  };

  if (!server) {
    return (
      <div>
        <PageHeader title="Email logs" description="Status and timeline for every email." />
        <EmptyState icon={<Activity size={26} />} title="Needs the Sealpost server">Logs are kept by the server. Start it with <code className="font-mono">sealpost studio</code>.</EmptyState>
      </div>
    );
  }

  const selected = rows.find((r) => r.id === open) ?? null;
  const stat = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</p>
      {sub ? <p className="text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );

  return (
    <div>
      <PageHeader title="Email logs" description="Everything the server sent or received, with delivery, bounces, complaints, opens, clicks and replies on one timeline." />
      <div className="mb-4 flex gap-1" role="tablist" aria-label="Sent or received">
        {(["sent", "received", "scheduled"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`cursor-pointer rounded-full border px-3 py-1 text-xs capitalize ${tab === t ? "border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/5"}`}>{t}</button>
        ))}
      </div>
      {tab === "received" ? <ReceivedPanel /> : null}
      {tab === "scheduled" ? <ScheduledPanel /> : null}
      {error ? <p role="alert" className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-200">{error}</p> : null}
      {tab === "sent" && stats ? (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {stat("Sent", String(stats.sent), `${stats.queued} queued`)}
          {stat("Opened", pct(stats.openRate), `${stats.uniqueOpens} unique`)}
          {stat("Clicked", String(stats.uniqueClicks), "unique")}
          {stat("Bounced", String(stats.bounces), pct(stats.bounceRate))}
          {stat("Complaints", String(stats.complaints))}
          {stat("Suppressed", String(stats.suppressed))}
        </div>
      ) : null}
      {tab === "sent" ? <Card>
        <CardHeader icon={<Mail size={16} />} title="Emails" subtitle="Newest first · refreshes every few seconds" />
        <div className="space-y-3 p-4">
          <div className="grid gap-2 sm:grid-cols-[160px_1fr_1fr]">
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {["delivered", "queued", "deferred", "failed", "bounced", "complained"].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <TextInput aria-label="Recipient contains" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient contains…" className="text-xs" />
            <TextInput aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag: name or name:value" className="text-xs" />
          </div>
          {rows.length === 0 ? <EmptyState icon={<Mail size={22} />} title="No emails match">Send one from Dispatch, the API or the CLI.</EmptyState> : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-white/5">
                    <Badge tone={TONE[r.status] ?? "slate"}>{r.status}</Badge>
                    <span className="min-w-0 flex-1 truncate"><span className="font-medium text-slate-900 dark:text-slate-100">{r.to.join(", ")}</span> <span className="text-slate-500">{r.subject}</span></span>
                    {r.opens > 0 ? <span className="inline-flex items-center gap-1 text-slate-500"><Mail size={11} /> {r.opens}</span> : null}
                    {(r.replies ?? 0) > 0 ? <span className="inline-flex items-center gap-1 text-slate-500"><CornerUpLeft size={11} /> {r.replies}</span> : null}
                    {r.clicks > 0 ? <span className="inline-flex items-center gap-1 text-slate-500"><MousePointerClick size={11} /> {r.clicks}</span> : null}
                    <span className="font-mono text-[10px] text-slate-400">{new Date(r.createdAtIso).toLocaleString()}</span>
                  </button>
                  {selected?.id === r.id ? (
                    <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs dark:border-slate-800 dark:bg-white/[0.02]">
                      <p className="font-mono text-[11px] text-slate-500">{r.id} · {r.from} · {r.templateId} · {r.domain}{r.receiptId ? ` · ${r.receiptId}` : ""}</p>
                      {r.tags.length > 0 ? <p className="flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={`${t.name}:${t.value}`} tone="slate">{t.name}:{t.value}</Badge>)}</p> : null}
                      {Object.keys(r.metadata).length > 0 ? <p className="font-mono text-[11px] text-slate-500">{JSON.stringify(r.metadata)}</p> : null}
                      <ol className="space-y-1.5 border-l border-slate-200 pl-3 dark:border-slate-700">
                        <li className="text-slate-500">{new Date(r.createdAtIso).toLocaleTimeString()}  accepted</li>
                        {r.events.map((e, i) => (
                          <li key={`${e.atIso}-${i}`} className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[11px] text-slate-500">{new Date(e.atIso).toLocaleTimeString()}</span>
                            <Badge tone={TONE[e.type] ?? "slate"}>{e.type}</Badge>
                            <span className="min-w-0 truncate text-slate-600 dark:text-slate-400">{e.detail ?? e.url ?? ""}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {more ? <button type="button" onClick={() => void loadMore()} className="w-full cursor-pointer rounded-lg border border-slate-200 py-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-white/5">Load more</button> : null}
        </div>
      </Card> : null}
    </div>
  );
}
