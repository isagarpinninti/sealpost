"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FlaskConical, MailCheck, RotateCcw, XCircle } from "lucide-react";
import { tamperDeliveryReceipt, verifyDeliveryReceipt, verifyDkimSignature, type DkimVerification, type ReceiptVerification, type SmtpTranscriptLine } from "@sealpost/core";
import { Badge, Button, Card, CardHeader } from "../ui";
import { cn } from "../utils";

export interface SmtpTranscriptInspectorProps {
  /** The RFC 5321 session. `null` before anything is sent. */
  transcript: readonly SmtpTranscriptLine[] | null;
  /** The exact bytes that were handed to the server (DKIM header included). */
  rawMime?: string | null;
  /** The `evw_` delivery receipt. */
  receiptToken?: string | null;
  /** Public key for the domain's DKIM selector. */
  dkimPublicKeyJwk?: JsonWebKey | null;
  /** The transcript did not come from a network exchange (browser-only demo). */
  simulated?: boolean;
}

const DIR = { S: "text-emerald-700 dark:text-emerald-300", C: "text-sky-700 dark:text-sky-300", I: "text-slate-400 dark:text-slate-500" } as const;

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  if (ok === null) return null;
  return (
    <li className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-xs", ok ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-400/25 dark:bg-emerald-400/[0.04]" : "border-rose-200 bg-rose-50/60 dark:border-rose-400/25 dark:bg-rose-400/[0.05]")}>
      {ok ? <CheckCircle2 size={15} className="mt-px text-emerald-600 dark:text-emerald-400" /> : <XCircle size={15} className="mt-px text-rose-600 dark:text-rose-400" />}
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-slate-800 dark:text-slate-100">{label}</span>
        {detail ? <span className="block text-slate-600 dark:text-slate-300">{detail}</span> : null}
      </span>
      <span className={cn("font-mono text-[10px] uppercase", ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300")}>{ok ? "verified" : "failed"}</span>
    </li>
  );
}

/** Flips the case of the first letter of the plain-text part: a one-character change after signing. */
function tamperBody(raw: string): string {
  return raw.replace(/(Content-Transfer-Encoding: quoted-printable\r\n\r\n)([A-Za-z])/, (_m, head: string, ch: string) => `${head}${ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()}`);
}

/** The live SMTP wire transcript, with the DKIM signature and the evw_ receipt verified offline and tamper simulation. */
export function SmtpTranscriptInspector({ transcript, rawMime = null, receiptToken = null, dkimPublicKeyJwk = null, simulated = false }: SmtpTranscriptInspectorProps) {
  const [tamper, setTamper] = useState<{ body: boolean; receipt: boolean }>({ body: false, receipt: false });
  const [dkim, setDkim] = useState<{ key: string; v: DkimVerification | null } | null>(null);
  const [rcpt, setRcpt] = useState<{ key: string; v: ReceiptVerification } | null>(null);

  const mime = rawMime !== null && tamper.body ? tamperBody(rawMime) : rawMime;
  const token = receiptToken !== null && tamper.receipt ? tamperDeliveryReceipt(receiptToken, "alter-recipient") : receiptToken;
  const dkimKey = mime && dkimPublicKeyJwk ? `${mime.length}:${mime.slice(0, 200)}:${mime.slice(-200)}:${dkimPublicKeyJwk.n?.slice(0, 16)}` : "";
  const rcptKey = token ? `${token}:${mime?.length ?? 0}:${mime?.slice(-120) ?? ""}` : "";

  useEffect(() => {
    if (!mime || !dkimPublicKeyJwk) return;
    let live = true;
    void verifyDkimSignature(mime, dkimPublicKeyJwk).then((v) => {
      if (live) setDkim({ key: dkimKey, v });
    });
    return () => {
      live = false;
    };
  }, [mime, dkimPublicKeyJwk, dkimKey]);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void verifyDeliveryReceipt(token, { rawMime: mime ?? undefined }).then((v) => {
      if (live) setRcpt({ key: rcptKey, v });
    });
    return () => {
      live = false;
    };
  }, [token, mime, rcptKey]);

  const d = dkim && dkim.key === dkimKey ? dkim.v : null;
  const r = rcpt && rcpt.key === rcptKey ? rcpt.v : null;
  const altered = tamper.body || tamper.receipt;
  const allOk = Boolean((d ? d.ok : true) && (r ? r.ok : true));

  return (
    <Card>
      <CardHeader
        icon={<MailCheck size={16} />}
        title="SMTP Transcript Inspector"
        subtitle="What really happened on the wire, and proof you can verify offline"
        right={transcript === null ? <Badge tone="slate">Nothing sent yet</Badge> : simulated ? <Badge tone="amber">Local demo</Badge> : <Badge tone={allOk ? "emerald" : "rose"}>{allOk ? "Verified" : "Tampered"}</Badge>}
      />
      <div className="space-y-4 p-4 sm:p-5">
        {transcript === null ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">Dispatch an email to see the RFC 5321 conversation here.</p>
        ) : (
          <>
            {simulated ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/5 dark:text-amber-200">Browsers cannot open SMTP sockets. This message was DKIM-signed and captured locally. Run <code className="font-mono">npx @sealpost/cli studio</code> for a real handshake.</p> : null}
            <div role="log" aria-label="SMTP wire transcript" className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-5 dark:bg-slate-950">
              {transcript.length === 0 ? <p className="text-slate-500">(no wire exchange)</p> : null}
              {transcript.map((l, i) => (
                <p key={i} className="whitespace-pre-wrap break-all">
                  <span className="mr-2 text-slate-600">{String(l.atMs).padStart(4, " ")}ms</span>
                  <span className={cn("mr-1.5 font-semibold", l.dir === "S" ? "text-emerald-400" : l.dir === "C" ? "text-sky-400" : "text-slate-500")}>{l.dir}:</span>
                  <span className={cn(l.dir === "I" ? "text-slate-400" : "text-slate-100", DIR[l.dir] && "")}>{l.text}</span>
                </p>
              ))}
            </div>
            <ul className="space-y-2" aria-label="Verification">
              <Row ok={d ? d.ok : null} label="RFC 6376 DKIM-Signature (rsa-sha256, relaxed/relaxed)" detail={d ? (d.ok ? `d=${d.domain} s=${d.selector}; body hash and signature match` : d.reason) : undefined} />
              <Row ok={r ? r.signature && r.canonicalRoundTrip : null} label="evw_ delivery receipt signature (ECDSA P-256)" detail={r && !r.signature ? "The receipt was altered after signing." : undefined} />
              <Row ok={r && r.mimeMatches !== null ? r.mimeMatches : null} label="Receipt matches the exact message bytes" detail={r && r.mimeMatches === false ? "The message does not hash to the receipt's mimeSha256." : undefined} />
            </ul>
            <div className="flex flex-wrap gap-2">
              {altered ? (
                <Button variant="secondary" onClick={() => setTamper({ body: false, receipt: false })}>
                  <RotateCcw size={14} /> Restore originals
                </Button>
              ) : (
                <>
                  <Button variant="danger" disabled={!rawMime} onClick={() => setTamper((t) => ({ ...t, body: true }))}>
                    <FlaskConical size={14} /> Tamper: alter one body character
                  </Button>
                  <Button variant="danger" disabled={!receiptToken} onClick={() => setTamper((t) => ({ ...t, receipt: true }))}>
                    <FlaskConical size={14} /> Tamper: alter receipt recipient
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
