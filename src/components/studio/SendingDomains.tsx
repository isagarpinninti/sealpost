"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Globe2, MinusCircle, XCircle } from "lucide-react";
import type { DnsRecord } from "@sealpost/core";
import { Badge, Button, Card, CardHeader } from "@sealpost/react";
import { api } from "@/lib/serverApi";

interface DomainRow {
  domain: string;
  fromEmail: string;
  dkimSelector: string;
  dmarcPolicy: string;
  primary: boolean;
  records: DnsRecord[];
}
interface CheckRow {
  purpose: string;
  fqdn: string;
  status: "ok" | "missing" | "mismatch" | "skipped";
  detail: string;
}

/** Every sending domain in this install, with a live SPF / DKIM / DMARC lookup. Server mode only. */
export function SendingDomains() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckRow[] | "loading" | string>>({});

  useEffect(() => {
    let alive = true;
    void api<{ domains: DomainRow[] }>("/api/domains")
      .then((r) => alive && setDomains(r.domains))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const check = async (d: string): Promise<void> => {
    setChecks((c) => ({ ...c, [d]: "loading" }));
    try {
      const r = await api<{ results: CheckRow[] }>(`/api/domains/${encodeURIComponent(d)}/check`);
      setChecks((c) => ({ ...c, [d]: r.results }));
    } catch (e) {
      setChecks((c) => ({ ...c, [d]: e instanceof Error ? e.message : "Lookup failed" }));
    }
  };

  return (
    <Card className="mt-5">
      <CardHeader icon={<Globe2 size={16} />} title="Sending domains" subtitle="Add more with `sealpost domain add`; each gets its own DKIM key" right={<Badge tone="slate">{domains.length}</Badge>} />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {domains.map((d) => {
          const result = checks[d.domain];
          return (
            <li key={d.domain} className="space-y-2 p-4 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium text-slate-900 dark:text-slate-100">{d.domain}</span>
                {d.primary ? <Badge tone="brand">default</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-slate-500">{d.fromEmail} · selector {d.dkimSelector} · DMARC {d.dmarcPolicy}</span>
                <Button onClick={() => void check(d.domain)} disabled={result === "loading"}>{result === "loading" ? "Checking…" : "Check DNS"}</Button>
              </div>
              {typeof result === "string" && result !== "loading" ? <p role="alert" className="text-rose-600 dark:text-rose-300">{result}</p> : null}
              {Array.isArray(result) ? (
                <ul className="space-y-1">
                  {result.map((r) => (
                    <li key={r.purpose} className="flex items-start gap-2">
                      {r.status === "ok" ? <CheckCircle2 size={14} className="mt-px shrink-0 text-emerald-500" /> : r.status === "skipped" ? <MinusCircle size={14} className="mt-px shrink-0 text-slate-400" /> : <XCircle size={14} className="mt-px shrink-0 text-rose-500" />}
                      <span><b>{r.purpose}</b> <span className="font-mono text-[11px] text-slate-500">{r.fqdn}</span> — {r.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
