"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Globe, Plus, Server, Trash2 } from "lucide-react";
import type { DnsRecord, DomainProfile, Mailbox } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, FieldLabel, Segmented } from "../ui";
import { cn } from "../utils";

export interface DomainMailboxVaultProps {
  domain: DomainProfile;
  onDomainChange?: (next: DomainProfile) => void;
  /** Real SPF / DKIM / DMARC / MX records from `synthesizeDnsRecords`. */
  dns: readonly DnsRecord[];
  mailboxes: readonly Mailbox[];
  onMailboxesChange?: (next: Mailbox[]) => void;
  transport: "sink" | "smtp";
  onTransportChange?: (next: "sink" | "smtp") => void;
  /** Mailbox id → whether its `passwordEnv` variable is set on the server. */
  passwordEnvSet?: Readonly<Record<string, boolean>>;
}

const input = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 shadow-sm outline-none placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-900 focus:ring-2 focus:ring-slate-900/10 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-white dark:focus:ring-white/10";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? "Copied" : "Copy"}
    </button>
  );
}

const PURPOSE_TONE = { SPF: "cyan", DKIM: "emerald", DMARC: "amber", MX: "slate" } as const;

export function DomainMailboxVault({ domain, onDomainChange, dns, mailboxes, onMailboxesChange, transport, onTransportChange, passwordEnvSet }: DomainMailboxVaultProps) {
  const setD = (patch: Partial<DomainProfile>): void => onDomainChange?.({ ...domain, ...patch });
  const setM = (i: number, patch: Partial<Mailbox>): void => onMailboxesChange?.(mailboxes.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  const move = (i: number, dir: -1 | 1): void => {
    const next = [...mailboxes];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onMailboxesChange?.(next);
  };
  const ro = !onDomainChange;
  const opt = (v: string): string | undefined => (v.trim() === "" ? undefined : v);

  return (
    <Card>
      <CardHeader icon={<Globe size={16} />} title="Domain & Mailbox Vault" subtitle="Your domain, your mailbox, your DNS: no SaaS in between" right={<Badge tone={transport === "smtp" ? "emerald" : "cyan"}>{transport === "smtp" ? "Live SMTP" : "Local test sink"}</Badge>} />
      <div className="space-y-6 p-4 sm:p-5">
        <div>
          <FieldLabel>Transport</FieldLabel>
          <Segmented<"sink" | "smtp"> ariaLabel="Transport" value={transport} onChange={(v) => onTransportChange?.(v)} disabled={!onTransportChange} options={[{ value: "smtp", label: "Custom Domain SMTP Server" }, { value: "sink", label: "Built-In Loopback Test Sink" }]} />
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">{transport === "sink" ? "Mail is captured in the local Test Inbox over a real SMTP handshake. Nothing leaves this machine." : "Mail is sent over raw TCP/TLS SMTP through the mailboxes below, in failover order."}</p>
        </div>

        <div>
          <FieldLabel>Sender identity</FieldLabel>
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
            {(
              [
                ["Domain", "domain", "mail.yourdomain.com"],
                ["From name", "fromName", "Acme Platform"],
                ["From email", "fromEmail", "hello@mail.yourdomain.com"],
                ["Reply-To", "replyTo", "support@mail.yourdomain.com"],
              ] as const
            ).map(([label, key, ph]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
                <input className={input} disabled={ro} placeholder={ph} value={domain[key] ?? ""} onChange={(e) => setD({ [key]: key === "replyTo" ? opt(e.target.value) : e.target.value } as Partial<DomainProfile>)} />
              </label>
            ))}
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">DKIM selector</span>
              <input className={input} disabled={ro} value={domain.dkimSelector} onChange={(e) => setD({ dkimSelector: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">DMARC policy</span>
              <select className={input} disabled={ro} value={domain.dmarcPolicy} onChange={(e) => setD({ dmarcPolicy: e.target.value as DomainProfile["dmarcPolicy"] })}>
                <option value="none">none (monitor)</option>
                <option value="quarantine">quarantine</option>
                <option value="reject">reject</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">SPF include (your mailbox provider)</span>
              <input className={input} disabled={ro} placeholder="_spf.yourprovider.com" value={domain.spfInclude ?? ""} onChange={(e) => setD({ spfInclude: opt(e.target.value) })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">Unsubscribe URL</span>
              <input className={input} disabled={ro} placeholder="https://app.yourdomain.com/unsubscribe" value={domain.unsubscribeUrl ?? ""} onChange={(e) => setD({ unsubscribeUrl: opt(e.target.value) })} />
            </label>
          </div>
        </div>

        <div>
          <FieldLabel
            right={
              onMailboxesChange ? (
                <Button variant="secondary" disabled={mailboxes.length >= 8} onClick={() => onMailboxesChange([...mailboxes, { id: `mailbox_${mailboxes.length + 1}`, label: mailboxes.length === 0 ? "Primary" : "Backup", host: "smtp.yourdomain.com", port: 587, security: "starttls" }])}>
                  <Plus size={12} /> Add mailbox
                </Button>
              ) : null
            }
          >
            SMTP mailboxes (failover order)
          </FieldLabel>
          {mailboxes.length === 0 ? <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">No mailbox configured. Add your provider&apos;s SMTP host to send from your own domain.</p> : null}
          <ul className="space-y-3">
            {mailboxes.map((m, i) => (
              <li key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="mb-2 flex items-center gap-2">
                  <Server size={13} className="text-slate-400" />
                  <Badge tone={i === 0 ? "emerald" : "slate"}>{i === 0 ? "Primary" : `Backup ${i}`}</Badge>
                  {passwordEnvSet && m.passwordEnv ? <Badge tone={passwordEnvSet[m.id] ? "emerald" : "rose"}>{passwordEnvSet[m.id] ? `${m.passwordEnv} set` : `${m.passwordEnv} missing`}</Badge> : null}
                  <span className="ml-auto flex gap-1">
                    <button type="button" aria-label="Move up" disabled={i === 0 || !onMailboxesChange} onClick={() => move(i, -1)} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ArrowUp size={13} /></button>
                    <button type="button" aria-label="Move down" disabled={i === mailboxes.length - 1 || !onMailboxesChange} onClick={() => move(i, 1)} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ArrowDown size={13} /></button>
                    <button type="button" aria-label={`Remove ${m.label}`} disabled={!onMailboxesChange} onClick={() => onMailboxesChange?.(mailboxes.filter((_, k) => k !== i))} className="cursor-pointer rounded p-1 text-rose-500 hover:bg-rose-50 disabled:opacity-30 dark:hover:bg-rose-400/10"><Trash2 size={13} /></button>
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
                  <input aria-label="Mailbox id" className={cn(input, "font-mono")} disabled={!onMailboxesChange} value={m.id} onChange={(e) => setM(i, { id: e.target.value })} />
                  <input aria-label="Label" className={input} disabled={!onMailboxesChange} value={m.label} onChange={(e) => setM(i, { label: e.target.value })} />
                  <input aria-label="SMTP host" className={cn(input, "font-mono")} disabled={!onMailboxesChange} value={m.host} onChange={(e) => setM(i, { host: e.target.value })} />
                  <input aria-label="Port" type="number" className={cn(input, "font-mono")} disabled={!onMailboxesChange} value={m.port} onChange={(e) => setM(i, { port: Number(e.target.value) || 587 })} />
                  <select aria-label="Security" className={input} disabled={!onMailboxesChange} value={m.security} onChange={(e) => setM(i, { security: e.target.value as Mailbox["security"] })}>
                    <option value="starttls">STARTTLS (587)</option>
                    <option value="tls">Implicit TLS (465)</option>
                    <option value="none">None (local only)</option>
                  </select>
                  <input aria-label="Username" className={input} placeholder="username" disabled={!onMailboxesChange} value={m.username ?? ""} onChange={(e) => setM(i, { username: opt(e.target.value) })} />
                  <input aria-label="Password environment variable" className={cn(input, "col-span-2 font-mono")} placeholder="PASSWORD_ENV_VAR (never the password itself)" disabled={!onMailboxesChange} value={m.passwordEnv ?? ""} onChange={(e) => setM(i, { passwordEnv: opt(e.target.value) })} />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">Passwords are read from environment variables on the server and are never stored in the config or sent to the browser.</p>
        </div>

        <div>
          <FieldLabel>DNS records to publish</FieldLabel>
          <ul className="space-y-2">
            {dns.map((r) => (
              <li key={`${r.purpose}-${r.name}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={PURPOSE_TONE[r.purpose]}>{r.purpose}</Badge>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{r.type} · {r.fqdn}</span>
                  <span className="ml-auto flex gap-1.5">
                    <CopyButton text={r.name} label={`Copy ${r.purpose} host`} />
                    <CopyButton text={r.value} label={`Copy ${r.purpose} value`} />
                  </span>
                </div>
                <p className="break-all rounded-md bg-slate-50 px-2.5 py-1.5 font-mono text-[10.5px] leading-relaxed text-slate-700 dark:bg-slate-950 dark:text-slate-300">{r.value}</p>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{r.note}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
