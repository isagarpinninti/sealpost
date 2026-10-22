"use client";

import { Fragment, useState } from "react";
import { CheckCircle2, Download, FileSignature, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { DeliveryLedgerRecord, LedgerVerification, ReceiptVerification } from "@sealpost/core";
import { Badge, Button, Card, CardHeader, SmtpTranscriptInspector, cn } from "@sealpost/react";
import type { MailClient } from "@/lib/client";
import { EmptyState, PageHeader, TextArea } from "../ui";

interface Props {
  client: MailClient | null;
  records: DeliveryLedgerRecord[];
  onClear?: () => void;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function LedgerView({ client, records, onClear }: Props) {
  const [verification, setVerification] = useState<LedgerVerification | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [pasted, setPasted] = useState("");
  const [pastedResult, setPastedResult] = useState<ReceiptVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const avg = records.length ? Math.round(records.reduce((n, r) => n + r.deliverabilityScore, 0) / records.length) : 0;

  const verify = async (): Promise<void> => {
    if (!client) return;
    setBusy(true);
    try {
      setVerification(await client.verifyLedger());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Delivery Ledger"
        description="Every accepted message is sealed as an ECDSA evw_ receipt and hash-chained to the one before it. Alter a recipient, a status code or a message hash and the chain breaks."
        actions={
          <>
            <Button variant="primary" disabled={!client || busy} onClick={() => void verify()}><ShieldCheck size={14} /> {busy ? "Verifying…" : "Verify chain"}</Button>
            <Button variant="secondary" disabled={records.length === 0} onClick={() => download("sealpost-ledger.jsonl", [...records].reverse().map((r) => JSON.stringify(r)).join("\n") + "\n")}><Download size={14} /> Export JSONL</Button>
            {onClear ? <Button variant="danger" disabled={records.length === 0} onClick={onClear}><Trash2 size={14} /> Clear</Button> : null}
          </>
        }
      />
      <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[["Delivered", String(records.length)], ["Average score", records.length ? String(avg) : "—"], ["Last status", records[0] ? String(records[0].smtpStatusCode) : "—"], ["Last template", records[0]?.templateId ?? "—"]].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{k}</dt>
            <dd className="mt-1 truncate font-mono text-xl font-semibold tabular-nums text-slate-900 dark:text-white">{v}</dd>
          </div>
        ))}
      </dl>
      {verification ? (
        <p role="status" className={cn("mb-5 flex items-center gap-2 rounded-lg border p-3 text-sm", verification.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200" : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200")}>
          {verification.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {verification.ok ? `${verification.reason} Every receipt signature verified.` : `Ledger failed verification: ${verification.reason}`}
        </p>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader icon={<FileSignature size={16} />} title="Receipts" subtitle="Newest first. Select a row to inspect and tamper with it." />
          {records.length === 0 ? (
            <div className="p-5"><EmptyState icon={<FileSignature size={26} />} title="No deliveries yet">Dispatch an email from the Visual Studio or the Dispatch view.</EmptyState></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400 dark:border-slate-800">{["#", "Time", "Receipt", "Template", "To", "SMTP", "Score", "Chain"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <Fragment key={r.seq}>
                      <tr onClick={() => setOpen(open === r.seq ? null : r.seq)} className={cn("cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-white/5", open === r.seq && "bg-slate-50 dark:bg-white/5")}>
                        <td className="px-3 py-2 font-mono text-slate-500">{r.seq}</td>
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-slate-500">{r.timestampIso.slice(5, 19).replace("T", " ")}</td>
                        <td className="px-3 py-2 font-mono text-slate-900 dark:text-slate-100">{r.receiptId}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.templateId}</td>
                        <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.to}</td>
                        <td className="px-3 py-2"><Badge tone="emerald">{r.smtpStatusCode}</Badge></td>
                        <td className="px-3 py-2 font-mono tabular-nums">{r.deliverabilityScore}</td>
                        <td className="px-3 py-2 font-mono text-slate-400">{r.chainHash.slice(0, 10)}…</td>
                      </tr>
                      {open === r.seq ? <tr><td colSpan={8} className="bg-slate-50/60 p-4 dark:bg-slate-950/40"><div className="max-w-2xl"><SmtpTranscriptInspector transcript={[]} receiptToken={r.token} /></div></td></tr> : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader icon={<ShieldCheck size={16} />} title="Verify a receipt" subtitle="Paste any evw_ token, even from another system" />
          <div className="space-y-3 p-4">
            <TextArea rows={7} spellCheck={false} aria-label="Receipt to verify" placeholder="evw_…" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <Button variant="primary" disabled={!client || pasted.trim() === ""} onClick={() => { if (client) void client.verifyReceipt(pasted.trim()).then(setPastedResult); }}>Verify receipt</Button>
            {pastedResult ? (
              <div role="status" className={cn("rounded-lg border p-3 text-xs", pastedResult.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200" : "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-200")}>
                <p className="font-semibold">{pastedResult.ok ? `${pastedResult.receiptId} is authentic` : "Verification failed"}</p>
                {pastedResult.reasons.map((x) => <p key={x}>• {x}</p>)}
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
