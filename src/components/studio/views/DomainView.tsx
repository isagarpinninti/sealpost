"use client";

import { useState } from "react";
import { Ban, ShieldOff, Trash2 } from "lucide-react";
import type { DnsRecord, DomainProfile, Mailbox, SuppressionEntry } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, DomainMailboxVault } from "@sealpost/react";
import type { MailClient } from "@/lib/client";
import { SendingDomains } from "../SendingDomains";
import { EmptyState, PageHeader, Select, TextInput } from "../ui";

interface Props {
  client: MailClient | null;
  domain: DomainProfile;
  onDomain: (d: DomainProfile) => void;
  dns: DnsRecord[];
  mailboxes: Mailbox[];
  onMailboxes: (m: Mailbox[]) => void;
  transport: "sink" | "smtp";
  onTransport?: (t: "sink" | "smtp") => void;
  passwordEnvSet: Record<string, boolean>;
  suppressions: SuppressionEntry[];
  onSuppressions: (s: SuppressionEntry[]) => void;
}

export function DomainView({ client, domain, onDomain, dns, mailboxes, onMailboxes, transport, onTransport, passwordEnvSet, suppressions, onSuppressions }: Props) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionEntry["reason"]>("unsubscribed");
  return (
    <div>
      <PageHeader title="Domain & Mailbox Vault" description="Bring your own domain and mailbox. Sealpost signs every message with your DKIM key and tells you exactly which DNS records to publish." />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <DomainMailboxVault domain={domain} onDomainChange={onDomain} dns={dns} mailboxes={mailboxes} onMailboxesChange={onTransport ? onMailboxes : undefined} transport={transport} onTransportChange={onTransport} passwordEnvSet={passwordEnvSet} />
        <Card>
          <CardHeader icon={<ShieldOff size={16} />} title="Suppression & bounce shield" subtitle="EW-107 blocks these before any socket opens" right={<Badge tone={suppressions.length ? "rose" : "slate"}>{suppressions.length}</Badge>} />
          <div className="space-y-4 p-4">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!client || email.trim() === "") return;
                void client.suppress(email.trim(), reason).then((s) => {
                  onSuppressions(s);
                  setEmail("");
                });
              }}
            >
              <div className="min-w-[180px] flex-1"><TextInput aria-label="Email to suppress" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.org" className="text-xs" /></div>
              <div className="w-40"><Select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value as SuppressionEntry["reason"])}><option value="unsubscribed">unsubscribed</option><option value="hard_bounce">hard_bounce</option><option value="complaint">complaint</option></Select></div>
              <Button type="submit" variant="primary" disabled={!client || email.trim() === ""}><Ban size={13} /> Suppress</Button>
            </form>
            {suppressions.length === 0 ? <EmptyState icon={<ShieldOff size={24} />} title="No suppressed addresses">Hard bounces (550/551/553/554) are added automatically.</EmptyState> : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {suppressions.map((s) => (
                  <li key={s.email} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="min-w-0 flex-1"><span className="block truncate font-mono text-slate-900 dark:text-slate-100">{s.email}</span><span className="block truncate text-slate-500 dark:text-slate-400">{new Date(s.atIso).toLocaleString()}{s.detail ? ` · ${s.detail}` : ""}</span></span>
                    <Badge tone={s.reason === "hard_bounce" ? "rose" : "amber"}>{s.reason}</Badge>
                    <button type="button" aria-label={`Remove ${s.email}`} onClick={() => void client?.unsuppress(s.email).then(onSuppressions)} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Trash2 size={13} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
      {client?.mode === "server" ? <SendingDomains /> : null}
    </div>
  );
}
