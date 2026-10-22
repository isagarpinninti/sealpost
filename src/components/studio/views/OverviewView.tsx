"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Circle, Inbox, Mail, PenLine, Rocket, Send } from "lucide-react";
import { Badge, Button, Card, CardHeader, type BadgeTone } from "@sealpost/react";
import type { MailClient } from "@/lib/client";
import { api } from "@/lib/serverApi";
import { BarChart, EmptyState, PageHeader, StatCard } from "../ui";
import type { ViewId } from "../nav";


interface Day {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  opens: number;
}
interface Stats {
  sent: number;
  openRate: number;
  bounceRate: number;
  complaints: number;
  suppressed: number;
  queued: number;
}
interface EmailRow {
  id: string;
  to: string[];
  subject: string;
  status: string;
  createdAtIso: string;
}
interface InboundRow {
  id: string;
  subject: string;
  kind: string;
  from?: { address: string };
  envelope: { from: string };
  receivedAtIso: string;
}

const TONE: Record<string, BadgeTone> = { delivered: "emerald", queued: "amber", deferred: "amber", failed: "rose", bounced: "rose", complained: "rose" };
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

interface Props {
  client: MailClient | null;
  templates: number;
  ledgerCount: number;
  /** Setup progress: domain customised, relay configured. */
  setup: { domain: boolean; relay: boolean };
  onView: (v: ViewId) => void;
}

export function OverviewView({ client, templates, ledgerCount, setup, onView }: Props) {
  const server = client?.mode === "server";
  const [days, setDays] = useState<Day[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [inbound, setInbound] = useState<InboundRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!server) return;
    try {
      const [t, s, e, i] = await Promise.all([api<{ days: Day[] }>("/api/stats/timeseries?days=14"), api<Stats>("/api/stats"), api<{ data: EmailRow[] }>("/api/emails?limit=6"), api<{ data: InboundRow[] }>("/api/inbound?limit=5")]);
      setDays(t.days);
      setStats(s);
      setEmails(e.data);
      setInbound(i.data);
    } catch {
      /* the other views surface connection problems */
    } finally {
      setLoaded(true);
    }
  }, [server]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 8000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  const sent14 = days.reduce((n, d) => n + d.sent, 0);
  const delivered14 = days.reduce((n, d) => n + d.delivered, 0);
  const bounced14 = days.reduce((n, d) => n + d.bounced, 0);
  const steps = [
    { label: "Set your sending domain", done: setup.domain, view: "setup" as ViewId },
    { label: "Connect an SMTP relay", done: setup.relay, view: "setup" as ViewId },
    { label: "Send your first email", done: (stats?.sent ?? 0) > 0, view: "dispatch" as ViewId },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  const actions = (
    <>
      <Button onClick={() => onView("studio")}><PenLine size={13} /> New template</Button>
      <Button variant="primary" onClick={() => onView("dispatch")}><Send size={13} /> Send an email</Button>
    </>
  );

  if (!server) {
    return (
      <div>
        <PageHeader title="Overview" description="You are using the in-browser demo. Templates, DKIM signing and receipts run here; real delivery needs the server." actions={actions} />
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Templates" value={String(templates)} />
          <StatCard label="Signed receipts" value={String(ledgerCount)} />
        </div>
        <EmptyState icon={<Rocket size={20} />} title="Run the server for the full experience" action={<code className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs dark:border-white/10 dark:bg-white/[0.04]">npx @sealpost/cli studio</code>}>
          Real SMTP delivery, the test inbox, retries, open and click tracking, receiving mail, audiences and webhooks all run in the server process.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Overview" description="Delivery, engagement and recent activity for the last 14 days." actions={actions} />

      {doneCount < steps.length ? (
        <Card className="mb-6">
          <CardHeader icon={<Rocket size={14} />} title="Finish setting up" subtitle={`${doneCount} of ${steps.length} done`} right={<Button size="sm" variant="primary" onClick={() => onView("setup")}>Continue setup <ArrowRight size={12} /></Button>} />
          <ul className="grid gap-px bg-slate-200/70 sm:grid-cols-3 dark:bg-white/[0.06]">
            {steps.map((s) => (
              <li key={s.label} className="bg-white dark:bg-slate-900">
                <button type="button" onClick={() => onView(s.view)} className="flex w-full cursor-pointer items-center gap-2.5 px-5 py-3.5 text-left text-[13px] hover:bg-slate-50 dark:hover:bg-white/[0.03]">
                  {s.done ? <CheckCircle2 size={16} className="shrink-0 text-emerald-500" /> : <Circle size={16} className="shrink-0 text-slate-300 dark:text-slate-600" />}
                  <span className={s.done ? "text-slate-400 line-through dark:text-slate-500" : "font-medium text-slate-800 dark:text-slate-100"}>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Sent · 14 days" value={String(sent14)} hint={stats ? `${stats.queued} queued` : undefined} />
        <StatCard label="Delivered" value={sent14 ? pct(delivered14 / sent14) : "—"} hint={`${delivered14} of ${sent14}`} tone={sent14 && delivered14 / sent14 >= 0.95 ? "good" : "neutral"} />
        <StatCard label="Open rate" value={stats ? pct(stats.openRate) : "—"} hint="unique opens" />
        <StatCard label="Bounced · 14 days" value={String(bounced14)} hint={stats ? `${stats.complaints} complaints · ${stats.suppressed} suppressed` : undefined} tone={bounced14 > 0 ? "bad" : "good"} />
      </div>

      <Card className="mb-6">
        <CardHeader
          icon={<Mail size={14} />}
          title="Emails"
          subtitle="Accepted per day (UTC)"
          right={
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              {[["Delivered", "#10b981"], ["Bounced", "#f43f5e"], ["Failed", "#f59e0b"]].map(([n, c]) => (
                <span key={n} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: c }} />{n}</span>
              ))}
            </div>
          }
        />
        <div className="p-5">
          {!loaded ? <div className="h-[140px] animate-pulse rounded-lg bg-slate-100 dark:bg-white/[0.04]" /> : sent14 === 0 ? (
            <EmptyState icon={<Send size={18} />} title="No emails yet">Send one from the Send page, the API or the CLI and it will show up here.</EmptyState>
          ) : (
            <BarChart
              height={140}
              series={[{ name: "Delivered", color: "#10b981" }, { name: "Bounced", color: "#f43f5e" }, { name: "Failed", color: "#f59e0b" }]}
              data={days.map((d) => ({ label: d.date.slice(5), values: [d.delivered, d.bounced, d.failed] }))}
            />
          )}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<Mail size={14} />} title="Recent emails" right={<Button size="sm" variant="ghost" onClick={() => onView("logs")}>View all <ArrowRight size={12} /></Button>} />
          {emails.length === 0 ? <p className="px-5 py-8 text-center text-[13px] text-slate-500">Nothing sent yet.</p> : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {emails.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <Badge tone={TONE[e.status] ?? "slate"}>{e.status}</Badge>
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium text-slate-800 dark:text-slate-100">{e.to.join(", ")}</span> <span className="text-slate-500">{e.subject}</span></span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">{ago(e.createdAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader icon={<Inbox size={14} />} title="Recent replies and reports" right={<Button size="sm" variant="ghost" onClick={() => onView("logs")}>View all <ArrowRight size={12} /></Button>} />
          {inbound.length === 0 ? <p className="px-5 py-8 text-center text-[13px] text-slate-500">Nothing received. Enable <code className="font-mono">inbound</code> to receive replies and bounces.</p> : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {inbound.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <Badge tone={m.kind === "message" ? "slate" : "rose"}>{m.kind}</Badge>
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium text-slate-800 dark:text-slate-100">{m.from?.address ?? m.envelope.from}</span> <span className="text-slate-500">{m.subject || "(no subject)"}</span></span>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">{ago(m.receivedAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
