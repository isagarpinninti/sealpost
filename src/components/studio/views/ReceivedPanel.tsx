"use client";

import { useCallback, useEffect, useState } from "react";
import { CornerUpLeft, Download, Inbox, Paperclip, Trash2 } from "lucide-react";
import { Badge, Card, CardHeader, type BadgeTone } from "@sealpost/react";
import { api, getToken } from "@/lib/serverApi";
import { EmptyState, Select, TextInput } from "../ui";

interface Attachment {
  index: number;
  filename: string;
  contentType: string;
  size: number;
}
interface Row {
  id: string;
  receivedAtIso: string;
  from?: { name?: string; address: string };
  envelope: { from: string; to: string[] };
  subject: string;
  snippet: string;
  kind: "message" | "bounce" | "complaint";
  autoReply: boolean;
  dkim: { result: "pass" | "fail" | "none" | "temperror"; detail?: string };
  attachments: Attachment[];
  threadEmailId?: string;
  reportVerified?: boolean;
  bounce?: { recipients: Array<{ email: string; status?: string; hard: boolean }>; unparsed: boolean };
  hasHtml: boolean;
}
interface Full extends Row {
  text?: string;
  html?: string;
  headers: Array<{ name: string; value: string }>;
}
interface Page {
  data: Row[];
  hasMore: boolean;
  nextCursor: string | null;
}

const KIND_TONE: Record<Row["kind"], BadgeTone> = { message: "slate", bounce: "rose", complaint: "rose" };
const DKIM_TONE: Record<Row["dkim"]["result"], BadgeTone> = { pass: "emerald", fail: "rose", none: "slate", temperror: "amber" };

/** Mail from other people is hostile input: no scripts, no remote loads, no same-origin access. */
const frameDoc = (html: string): string => `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><base target="_blank"><body style="font-family:system-ui;font-size:14px;margin:12px;color:#111;background:#fff">${html}</body>`;

async function download(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReceivedPanel() {
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [more, setMore] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [full, setFull] = useState<Full | null>(null);
  const [view, setView] = useState<"html" | "text" | "headers">("text");
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((before?: string): string => {
    const p = new URLSearchParams({ limit: "25" });
    if (kind) p.set("kind", kind);
    if (q.trim()) p.set("q", q.trim());
    if (before) p.set("before", before);
    return `/api/inbound?${p.toString()}`;
  }, [kind, q]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const page = await api<Page>(query());
      setRows(page.data);
      setMore(page.hasMore ? page.nextCursor : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load received mail");
    }
  }, [query]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const t = window.setInterval(() => void refresh(), 5000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [refresh]);

  const toggle = async (id: string): Promise<void> => {
    if (open === id) {
      setOpen(null);
      setFull(null);
      return;
    }
    setOpen(id);
    setFull(null);
    try {
      const f = await api<Full>(`/api/inbound/${id}`);
      setFull(f);
      setView(f.text !== undefined ? "text" : f.html !== undefined ? "html" : "headers");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the message");
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/inbound/${id}`, { method: "DELETE" });
      setOpen(null);
      setFull(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  };

  return (
    <Card>
      <CardHeader icon={<Inbox size={16} />} title="Received mail" subtitle="Replies, bounces and abuse reports sent to your domains · refreshes every few seconds" />
      <div className="space-y-3 p-4">
        {error ? <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-200">{error}</p> : null}
        <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
          <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Any kind</option>
            <option value="message">Messages</option>
            <option value="bounce">Bounces</option>
            <option value="complaint">Complaints</option>
          </Select>
          <TextInput aria-label="Search subject or text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject or text…" className="text-xs" />
        </div>
        {rows.length === 0 ? <EmptyState icon={<Inbox size={22} />} title="Nothing received yet">Enable <code className="font-mono">inbound.enabled</code> and publish your MX record, or post mail to <code className="font-mono">/hooks/inbound/raw</code>.</EmptyState> : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => void toggle(r.id)} aria-expanded={open === r.id} className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-white/5">
                  <Badge tone={KIND_TONE[r.kind]}>{r.kind}</Badge>
                  {r.autoReply ? <Badge tone="amber">auto-reply</Badge> : null}
                  <span className="min-w-0 flex-1 truncate"><span className="font-medium text-slate-900 dark:text-slate-100">{r.from?.name ?? r.from?.address ?? r.envelope.from}</span> <span className="text-slate-500">{r.subject || "(no subject)"}</span></span>
                  {r.threadEmailId ? <span title={`Replies to ${r.threadEmailId}`} className="inline-flex items-center gap-1 text-slate-500"><CornerUpLeft size={11} /> reply</span> : null}
                  {r.attachments.length > 0 ? <span className="inline-flex items-center gap-1 text-slate-500"><Paperclip size={11} /> {r.attachments.length}</span> : null}
                  <Badge tone={DKIM_TONE[r.dkim.result]}>DKIM {r.dkim.result}</Badge>
                  <span className="font-mono text-[10px] text-slate-400">{new Date(r.receivedAtIso).toLocaleString()}</span>
                </button>
                {open === r.id ? (
                  <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs dark:border-slate-800 dark:bg-white/[0.02]">
                    {!full ? <p className="text-slate-500">Loading…</p> : (
                      <>
                        <p className="font-mono text-[11px] text-slate-500">{full.id} · from {full.from?.address ?? full.envelope.from} → {full.envelope.to.join(", ")}{full.threadEmailId ? ` · replies to ${full.threadEmailId}` : ""}</p>
                        {full.bounce ? <p className="text-slate-600 dark:text-slate-300">{full.reportVerified ? "Matched to mail you sent: the recipient was suppressed." : "Not matched to mail this server sent: ignored."} {full.bounce.recipients.map((b) => `${b.email} ${b.status ?? ""}`).join(", ")}</p> : null}
                        {full.dkim.detail ? <p className="text-slate-500">DKIM: {full.dkim.detail}</p> : null}
                        <div className="flex flex-wrap gap-1">
                          {(["text", "html", "headers"] as const).map((v) => (
                            <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] ${view === v ? "border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{v}</button>
                          ))}
                        </div>
                        {view === "text" ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-3 font-sans text-[13px] dark:bg-black/40">{full.text ?? "(no plain-text part)"}</pre> : null}
                        {view === "html" ? (full.html !== undefined ? <iframe title="Message body" sandbox="" srcDoc={frameDoc(full.html)} className="h-72 w-full rounded border border-slate-200 bg-white dark:border-slate-700" /> : <p className="text-slate-500">(no HTML part)</p>) : null}
                        {view === "headers" ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-3 font-mono text-[11px] dark:bg-black/40">{full.headers.map((h) => `${h.name}: ${h.value}`).join("\n")}</pre> : null}
                        {full.attachments.length > 0 ? (
                          <ul className="flex flex-wrap gap-2">
                            {full.attachments.map((a) => (
                              <li key={a.index}>
                                <button type="button" onClick={() => void download(`/api/inbound/${full.id}/attachments/${a.index}`, a.filename).catch((e: unknown) => setError(e instanceof Error ? e.message : "Download failed"))} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 hover:bg-white dark:border-slate-700 dark:hover:bg-white/5"><Download size={12} /> {a.filename} <span className="text-slate-500">{a.size} B</span></button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <div className="flex gap-2">
                          <button type="button" onClick={() => void download(`/api/inbound/${full.id}/raw`, `${full.id}.eml`).catch((e: unknown) => setError(e instanceof Error ? e.message : "Download failed"))} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 hover:bg-white dark:border-slate-700 dark:hover:bg-white/5"><Download size={12} /> Raw .eml</button>
                          <button type="button" onClick={() => void remove(full.id)} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-rose-200 px-2.5 py-1 text-rose-700 hover:bg-rose-50 dark:border-rose-400/30 dark:text-rose-300 dark:hover:bg-rose-400/10"><Trash2 size={12} /> Delete</button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {more ? (
          <button type="button" onClick={() => void api<Page>(query(more)).then((p) => { setRows((cur) => [...cur, ...p.data]); setMore(p.hasMore ? p.nextCursor : null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load more"))} className="w-full cursor-pointer rounded-lg border border-slate-200 py-2 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-white/5">Load more</button>
        ) : null}
      </div>
    </Card>
  );
}
