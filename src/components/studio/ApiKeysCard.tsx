"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, ScrollText, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader } from "@sealpost/react";
import { api, ApiError } from "@/lib/serverApi";
import { TextInput } from "./ui";

interface KeyRow {
  id: string;
  label: string;
  scopes: string[];
  createdAtIso: string;
  expiresAtIso?: string;
}
interface AuditRow {
  atIso: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  ip: string;
}

const SCOPES = [
  { id: "send", hint: "send and preview mail" },
  { id: "read", hint: "read logs, stats, received mail" },
  { id: "write", hint: "audiences, broadcasts, suppressions" },
] as const;

/** API keys with scopes and expiry, and the audit trail. Needs the admin key, so it explains itself when it gets a 403. */
export function ApiKeysCard() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["send", "read"]);
  const [days, setDays] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [k, a] = await Promise.all([api<{ keys: KeyRow[] }>("/api/keys"), api<{ entries: AuditRow[] }>("/api/audit?limit=8")]);
      setKeys(k.keys);
      setAudit(a.entries);
      setNote(null);
    } catch (e) {
      setNote(e instanceof ApiError && e.status === 403 ? "Managing keys needs the admin key (SEALPOST_API_KEY). Sign in with it to see this." : e instanceof Error ? e.message : "Could not load keys");
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(t);
  }, [refresh]);

  const create = async (): Promise<void> => {
    try {
      const r = await api<{ key: string }>("/api/keys", { method: "POST", body: { label: label.trim(), scopes, ...(days ? { expiresInDays: Number(days) } : {}) } });
      setFresh(r.key);
      setLabel("");
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not create the key");
    }
  };

  return (
    <Card className="xl:col-span-2">
      <CardHeader icon={<KeyRound size={14} />} title="API keys" subtitle="Scoped, expiring, revocable. Only the SHA-256 is stored." right={<Badge tone="slate">{keys.length}</Badge>} />
      <div className="space-y-4 p-5">
        {note ? <p role="alert" className="rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200">{note}</p> : null}
        {fresh ? (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-200">
            <span>Copy it now, it is shown once:</span>
            <code className="min-w-0 flex-1 truncate font-mono">{fresh}</code>
            <Button size="sm" onClick={() => void navigator.clipboard?.writeText(fresh)}><Copy size={12} /> Copy</Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-[160px] flex-1 text-xs"><span className="mb-1 block font-semibold uppercase tracking-wider text-slate-500">Label</span><TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="my-app" className="text-xs" /></label>
          <fieldset className="text-xs"><legend className="mb-1 font-semibold uppercase tracking-wider text-slate-500">Scopes</legend>
            <div className="flex gap-3">{SCOPES.map((s) => <label key={s.id} title={s.hint} className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={scopes.includes(s.id)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />{s.id}</label>)}</div>
          </fieldset>
          <label className="block w-28 text-xs"><span className="mb-1 block font-semibold uppercase tracking-wider text-slate-500">Expires (days)</span><TextInput value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="never" className="text-xs" /></label>
          <Button variant="primary" disabled={label.trim() === "" || scopes.length === 0} onClick={() => void create()}>Create key</Button>
        </div>
        {keys.length > 0 ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-white/[0.06] dark:border-white/[0.08]">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1"><span className="font-medium text-slate-900 dark:text-slate-100">{k.label}</span> <span className="font-mono text-[10px] text-slate-400">{k.id}</span></span>
                {k.scopes.map((s) => <Badge key={s}>{s}</Badge>)}
                <span className="text-slate-500">{k.expiresAtIso ? `expires ${k.expiresAtIso.slice(0, 10)}` : "no expiry"}</span>
                <button type="button" aria-label={`Revoke ${k.label}`} onClick={() => void api(`/api/keys/${k.id}`, { method: "DELETE" }).then(refresh).catch((e: unknown) => setNote(e instanceof Error ? e.message : "Could not revoke"))} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-900/[0.05] dark:hover:bg-white/[0.07]"><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        {audit.length > 0 ? (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500"><ScrollText size={12} /> Recent changes and failed sign-ins</p>
            <ul className="space-y-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-400">
              {audit.map((a, i) => <li key={`${a.atIso}-${i}`} className="truncate">{new Date(a.atIso).toLocaleTimeString()}  {a.status}  {a.method.padEnd(6)} {a.path}  <span className="text-slate-400">{a.actor} · {a.ip}</span></li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
