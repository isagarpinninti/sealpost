"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, XCircle } from "lucide-react";
import { Badge, Card, CardHeader, type BadgeTone } from "@sealpost/react";
import { api } from "@/lib/serverApi";
import { EmptyState } from "../ui";

interface Row {
  id: string;
  status: "scheduled" | "sending" | "sent" | "cancelled" | "failed";
  scheduledAtIso: string;
  request: { templateId?: string; to?: string | string[] };
  result?: { status: string; emailId?: string; error?: string };
}
const TONE: Record<Row["status"], BadgeTone> = { scheduled: "amber", sending: "cyan", sent: "emerald", cancelled: "slate", failed: "rose" };

/** Sends waiting for their time. They are sent by the server's worker. */
export function ScheduledPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setRows((await api<{ scheduled: Row[] }>("/api/scheduled")).scheduled);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load scheduled sends");
    }
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 5000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  return (
    <Card>
      <CardHeader icon={<CalendarClock size={14} />} title="Scheduled sends" subtitle="The gate runs when you schedule and again when it is sent" right={<Badge>{rows.filter((r) => r.status === "scheduled").length} waiting</Badge>} />
      <div className="p-4">
        {error ? <p role="alert" className="mb-3 text-xs text-rose-600">{error}</p> : null}
        {rows.length === 0 ? <EmptyState icon={<CalendarClock size={20} />} title="Nothing scheduled">Send with <code className="font-mono">scheduledAt</code> through the API or <code className="font-mono">sealpost send --at</code>.</EmptyState> : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-white/[0.06] dark:border-white/[0.08]">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <Badge tone={TONE[r.status]}>{r.status}</Badge>
                <span className="min-w-0 flex-1 truncate"><span className="font-medium text-slate-900 dark:text-slate-100">{Array.isArray(r.request.to) ? r.request.to.join(", ") : r.request.to}</span> <span className="text-slate-500">{r.request.templateId}</span>{r.result?.error ? <span className="text-rose-600"> · {r.result.error}</span> : null}</span>
                <span className="font-mono text-[10px] text-slate-400">{new Date(r.scheduledAtIso).toLocaleString()}</span>
                {r.status === "scheduled" ? <button type="button" aria-label={`Cancel ${r.id}`} onClick={() => void api(`/api/scheduled/${r.id}`, { method: "DELETE" }).then(refresh).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not cancel"))} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07]"><XCircle size={14} /></button> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
