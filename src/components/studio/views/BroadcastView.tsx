"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus, Send, Trash2, Users, Webhook, XCircle } from "lucide-react";
import type { EmailTemplate } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, Meter, type BadgeTone } from "@sealpost/react";
import type { MailClient } from "@/lib/client";
import { api } from "@/lib/serverApi";
import { EmptyState, PageHeader, Select, TextArea, TextInput } from "../ui";

interface AudienceRow {
  id: string;
  name: string;
  contacts: number;
}
interface ContactRow {
  email: string;
  name?: string;
}
interface BroadcastRow {
  id: string;
  name: string;
  audienceId: string;
  templateId: string;
  scheduledAtIso: string;
  ratePerMinute: number;
  status: "scheduled" | "sending" | "completed" | "cancelled";
  cursor: number;
  counts: { total: number; delivered: number; queued: number; suppressed: number; duplicate: number; blocked: number; failed: number };
}
interface HookRow {
  id: string;
  url: string;
  events: string[];
  secretEnvSet: boolean;
  pending: number;
  delivered: number;
  failed: number;
}
interface DeliveryRow {
  id: string;
  endpointId: string;
  type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastNote?: string;
  createdAtIso: string;
}

const STATUS_TONE: Record<BroadcastRow["status"], BadgeTone> = { scheduled: "amber", sending: "cyan", completed: "emerald", cancelled: "slate" };

/** "ada@example.org, Ada" per line → contacts. Anything after the first comma is the name. */
function parseContacts(text: string): Array<{ email: string; name?: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(",");
      return i < 0 ? { email: l } : { email: l.slice(0, i).trim(), name: l.slice(i + 1).trim() || undefined };
    });
}

function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function BroadcastView({ client, templates }: { client: MailClient | null; templates: EmailTemplate[] }) {
  const server = client?.mode === "server";
  const [audiences, setAudiences] = useState<AudienceRow[]>([]);
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([]);
  const [hooks, setHooks] = useState<HookRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [audName, setAudName] = useState("");
  const [paste, setPaste] = useState("");
  const [bName, setBName] = useState("");
  const [bAudience, setBAudience] = useState("");
  const [bTemplate, setBTemplate] = useState("");
  const [bAt, setBAt] = useState("");
  const [bRate, setBRate] = useState("600");
  const [bVars, setBVars] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    if (!server) return;
    try {
      const [a, b, h, d] = await Promise.all([api<{ audiences: AudienceRow[] }>("/api/audiences"), api<{ broadcasts: BroadcastRow[] }>("/api/broadcasts"), api<{ endpoints: HookRow[] }>("/api/webhooks"), api<{ deliveries: DeliveryRow[] }>("/api/webhooks/deliveries")]);
      setAudiences(a.audiences);
      setBroadcasts(b.broadcasts);
      setHooks(h.endpoints);
      setDeliveries(d.deliveries.slice(0, 12));
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Could not load" });
    }
  }, [server]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  const loadContacts = async (id: string): Promise<void> => {
    setOpen(id);
    try {
      setContacts((await api<{ contacts: ContactRow[] }>(`/api/audiences/${id}?limit=100`)).contacts);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Could not load contacts" });
    }
  };

  const run = async (label: string, fn: () => Promise<string>): Promise<void> => {
    try {
      setMessage({ tone: "ok", text: await fn() });
      await refresh();
    } catch (e) {
      setMessage({ tone: "error", text: `${label}: ${e instanceof Error ? e.message : "failed"}` });
    }
  };

  if (!server) {
    return (
      <div>
        <PageHeader title="Audiences & Broadcasts" description="Contact lists, scheduled broadcasts and signed webhooks." />
        <EmptyState icon={<Megaphone size={26} />} title="Needs the Sealpost server">
          Audiences, scheduling and webhooks run in the server process. Start it with <code className="font-mono">sealpost studio</code> and reopen this page.
        </EmptyState>
      </div>
    );
  }

  const canCreate = bName.trim() !== "" && bAudience !== "" && bTemplate !== "";
  return (
    <div>
      <PageHeader title="Audiences & Broadcasts" description="Build a list, schedule a template to it, and watch it send. Suppressed and unsubscribed contacts are skipped automatically by EW-107." />
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`mb-4 rounded-lg border p-3 text-xs ${message.tone === "error" ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-200" : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-200"}`}>{message.text}</p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader icon={<Users size={16} />} title="Audiences" subtitle="Contacts are lower-cased and de-duplicated" right={<Badge tone="slate">{audiences.length}</Badge>} />
          <div className="space-y-4 p-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (audName.trim() === "") return;
                void run("Create audience", async () => {
                  await api("/api/audiences", { method: "POST", body: { name: audName.trim() } });
                  setAudName("");
                  return `Created audience “${audName.trim()}”`;
                });
              }}
            >
              <TextInput aria-label="New audience name" value={audName} onChange={(e) => setAudName(e.target.value)} placeholder="Customers" className="text-xs" />
              <Button type="submit" variant="primary" disabled={audName.trim() === ""}><Plus size={13} /> Create</Button>
            </form>
            {audiences.length === 0 ? <EmptyState icon={<Users size={22} />} title="No audiences yet" /> : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {audiences.map((a) => (
                  <li key={a.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => void loadContacts(a.id)} className="min-w-0 flex-1 cursor-pointer text-left">
                        <span className="block truncate font-medium text-slate-900 dark:text-slate-100">{a.name}</span>
                        <span className="block font-mono text-[10px] text-slate-500">{a.id}</span>
                      </button>
                      <Badge tone="slate">{a.contacts} contacts</Badge>
                      <button type="button" aria-label={`Delete ${a.name}`} onClick={() => void run("Delete audience", async () => { await api(`/api/audiences/${a.id}`, { method: "DELETE" }); if (open === a.id) setOpen(null); return `Deleted “${a.name}”`; })} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Trash2 size={13} /></button>
                    </div>
                    {open === a.id ? (
                      <div className="mt-3 space-y-2">
                        <TextArea aria-label="Contacts to add" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"ada@example.org, Ada\nbo@example.org, Bo"} />
                        <Button
                          variant="primary"
                          disabled={paste.trim() === ""}
                          onClick={() => void run("Add contacts", async () => {
                            const r = await api<{ added: number; updated: number; rejected: Array<{ email: string }> }>(`/api/audiences/${a.id}/contacts`, { method: "POST", body: { contacts: parseContacts(paste) } });
                            setPaste("");
                            await loadContacts(a.id);
                            return `Added ${r.added}, updated ${r.updated}${r.rejected.length ? `, rejected ${r.rejected.length} invalid` : ""}`;
                          })}
                        >
                          <Plus size={13} /> Add contacts
                        </Button>
                        <p className="text-[11px] text-slate-500">{contacts.length === 0 ? "No contacts yet." : `Showing ${contacts.length}: ${contacts.slice(0, 5).map((c) => c.email).join(", ")}${contacts.length > 5 ? "…" : ""}`}</p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader icon={<Send size={16} />} title="New broadcast" subtitle="Leave the time empty to start now" />
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canCreate) return;
              void run("Create broadcast", async () => {
                await api("/api/broadcasts", { method: "POST", body: { name: bName.trim(), audienceId: bAudience, templateId: bTemplate, variables: parseVars(bVars), scheduledAtIso: bAt ? new Date(bAt).toISOString() : undefined, ratePerMinute: Number(bRate) || 600 } });
                setBName("");
                return bAt ? `Scheduled for ${new Date(bAt).toLocaleString()}` : "Started";
              });
            }}
          >
            <TextInput aria-label="Broadcast name" value={bName} onChange={(e) => setBName(e.target.value)} placeholder="Launch announcement" className="text-xs" />
            <div className="grid gap-2 sm:grid-cols-2">
              <Select aria-label="Audience" value={bAudience} onChange={(e) => setBAudience(e.target.value)}>
                <option value="">Choose audience…</option>
                {audiences.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.contacts})</option>)}
              </Select>
              <Select aria-label="Template" value={bTemplate} onChange={(e) => setBTemplate(e.target.value)}>
                <option value="">Choose template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
              <TextInput aria-label="Send at" type="datetime-local" value={bAt} onChange={(e) => setBAt(e.target.value)} className="text-xs" />
              <TextInput aria-label="Emails per minute" type="number" min={1} max={6000} value={bRate} onChange={(e) => setBRate(e.target.value)} className="text-xs" />
            </div>
            <TextArea aria-label="Shared variables" rows={3} value={bVars} onChange={(e) => setBVars(e.target.value)} placeholder={"signInUrl=https://app.example.com/in\notpCode=123456"} />
            <p className="text-[11px] text-slate-500">One <code className="font-mono">key=value</code> per line. A contact&apos;s own variables and name override these.</p>
            <Button type="submit" variant="primary" disabled={!canCreate}><Megaphone size={13} /> Schedule broadcast</Button>
          </form>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader icon={<Megaphone size={16} />} title="Broadcasts" subtitle="Updates every few seconds" right={<Badge tone="slate">{broadcasts.length}</Badge>} />
        <div className="p-4">
          {broadcasts.length === 0 ? <EmptyState icon={<Megaphone size={22} />} title="Nothing scheduled" /> : (
            <ul className="space-y-3">
              {broadcasts.map((b) => {
                const sent = b.counts.delivered + b.counts.queued;
                return (
                  <li key={b.id} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-slate-100">{b.name}</span>
                      <Badge tone={STATUS_TONE[b.status]}>{b.status}</Badge>
                      <span className="font-mono text-[10px] text-slate-500">{b.id}</span>
                      {b.status === "scheduled" || b.status === "sending" ? (
                        <button type="button" aria-label={`Cancel ${b.name}`} onClick={() => void run("Cancel", async () => { await api(`/api/broadcasts/${b.id}/cancel`, { method: "POST", body: {} }); return `Cancelled ${b.name}`; })} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><XCircle size={14} /></button>
                      ) : null}
                    </div>
                    <p className="mt-1 text-slate-500">{b.templateId} · {new Date(b.scheduledAtIso).toLocaleString()} · {b.ratePerMinute}/min</p>
                    <div className="mt-2"><Meter value={b.cursor} max={Math.max(1, b.counts.total)} tone={b.status === "completed" ? "emerald" : "cyan"} label={`${b.cursor} of ${b.counts.total} processed`} /></div>
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-slate-600 dark:text-slate-400">
                      <span>sent {sent}</span><span>suppressed {b.counts.suppressed}</span><span>duplicate {b.counts.duplicate}</span><span>blocked {b.counts.blocked}</span><span>failed {b.counts.failed}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <Card className="mt-5">
        <CardHeader icon={<Webhook size={16} />} title="Webhooks to your app" subtitle="Signed with Sealpost-Signature · retried 10 s → 1 min → 5 min → 30 min → 2 h" right={<Badge tone="slate">{hooks.length}</Badge>} />
        <div className="space-y-4 p-4">
          {hooks.length === 0 ? <EmptyState icon={<Webhook size={22} />} title="No endpoints">Add one with <code className="font-mono">sealpost webhook add app --url https://… --secret-env SEALPOST_WHSEC</code>.</EmptyState> : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
              {hooks.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-900 dark:text-slate-100">{h.id}</span><span className="block truncate font-mono text-[10px] text-slate-500">{h.url}</span></span>
                  {h.secretEnvSet ? null : <Badge tone="rose">secret env not set</Badge>}
                  <Badge tone="emerald">{h.delivered} ok</Badge><Badge tone={h.pending ? "amber" : "slate"}>{h.pending} pending</Badge><Badge tone={h.failed ? "rose" : "slate"}>{h.failed} failed</Badge>
                  <Button onClick={() => void run("Test webhook", async () => { await api(`/api/webhooks/${h.id}/test`, { method: "POST", body: {} }); return `Sent a ping to ${h.id}`; })}>Send test</Button>
                </li>
              ))}
            </ul>
          )}
          {deliveries.length > 0 ? (
            <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
              {deliveries.map((d) => <li key={d.id} className="truncate">{new Date(d.createdAtIso).toLocaleTimeString()}  {d.status.padEnd(9)} {d.type}  → {d.endpointId}  ·  attempts {d.attempts}{d.lastNote ? `  ·  ${d.lastNote}` : ""}</li>)}
            </ul>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
