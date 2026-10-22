"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Copy, MinusCircle, Rocket, XCircle } from "lucide-react";
import type { DnsRecord, DomainProfile, EmailTemplate, Mailbox } from "@sealpost/core";
import { Badge, Button, Card, CardHeader } from "@sealpost/react";
import { api } from "@/lib/serverApi";
import { PageHeader, Select, TextArea, TextInput } from "../ui";

interface Props {
  domain: DomainProfile;
  mailboxes: Mailbox[];
  transport: "sink" | "smtp";
  dns: DnsRecord[];
  passwordEnvSet: Record<string, boolean>;
  templates: EmailTemplate[];
  /** Re-read the workspace from the server after a change. */
  onChanged: () => Promise<unknown>;
  onDone: () => void;
}

interface Preset {
  id: string;
  label: string;
  host: string;
  port: number;
  security: Mailbox["security"];
  username: string;
  spfInclude?: string;
  hint: string;
}

const PRESETS: Preset[] = [
  { id: "ses", label: "Amazon SES", host: "email-smtp.us-east-1.amazonaws.com", port: 587, security: "starttls", username: "", spfInclude: "amazonses.com", hint: "Use the SMTP credentials from the SES console, and change us-east-1 to your region. Verify your domain in SES first." },
  { id: "postmark", label: "Postmark", host: "smtp.postmarkapp.com", port: 587, security: "starttls", username: "", spfInclude: "spf.mtasv.net", hint: "Username and password are both your Server API token." },
  { id: "sendgrid", label: "SendGrid", host: "smtp.sendgrid.net", port: 587, security: "starttls", username: "apikey", spfInclude: "sendgrid.net", hint: "Username is the word apikey; the password is your API key." },
  { id: "mailgun", label: "Mailgun", host: "smtp.mailgun.org", port: 587, security: "starttls", username: "", spfInclude: "mailgun.org", hint: "Username looks like postmaster@your-domain." },
  { id: "custom", label: "Other SMTP server", host: "", port: 587, security: "starttls", username: "", hint: "Port 25 is blocked by most hosts. Use 587 (STARTTLS) or 465 (TLS)." },
];

interface Check {
  purpose: string;
  fqdn: string;
  status: "ok" | "missing" | "mismatch" | "skipped";
  detail: string;
}
interface DoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  fix?: string;
}
interface AuthReport {
  ok: boolean;
  problems: string[];
  results: Array<{ method: string; verdict: string; receiver: string }>;
}

const STEPS = ["Domain", "Relay", "DNS", "Test send", "Done"] as const;

function Stepper({ step, done, onStep }: { step: number; done: boolean[]; onStep: (i: number) => void }) {
  return (
    <ol className="mb-5 flex flex-wrap gap-2" aria-label="Setup steps">
      {STEPS.map((label, i) => (
        <li key={label}>
          <button type="button" onClick={() => onStep(i)} aria-current={i === step ? "step" : undefined} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${i === step ? "border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-black" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-white/5"}`}>
            {done[i] ? <CheckCircle2 size={13} className={i === step ? "" : "text-emerald-500"} /> : <Circle size={13} />}
            {i + 1}. {label}
          </button>
        </li>
      ))}
    </ol>
  );
}

const field = (label: string, node: React.ReactNode, hint?: string) => (
  <label className="block text-xs">
    <span className="mb-1 block font-semibold uppercase tracking-wider text-slate-500">{label}</span>
    {node}
    {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
  </label>
);

/** First-run wizard: domain → relay → DNS → test send → verify what the inbox decided. Server mode only. */
export function SetupView({ domain, mailboxes, transport, dns, passwordEnvSet, templates, onChanged, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // step 1
  const [dom, setDom] = useState(domain.domain);
  const [fromName, setFromName] = useState(domain.fromName);
  const [fromEmail, setFromEmail] = useState(domain.fromEmail);
  // step 2
  const existing = mailboxes[0];
  const [preset, setPreset] = useState(existing ? "custom" : "ses");
  const [host, setHost] = useState(existing?.host ?? PRESETS[0].host);
  const [port, setPort] = useState(String(existing?.port ?? 587));
  const [security, setSecurity] = useState<Mailbox["security"]>(existing?.security ?? "starttls");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [passwordEnv, setPasswordEnv] = useState(existing?.passwordEnv ?? "SMTP_PASSWORD");
  const [probe, setProbe] = useState<DoctorCheck[] | null>(null);
  // step 3
  const [checks, setChecks] = useState<Check[] | null>(null);
  // step 4
  const [to, setTo] = useState("");
  const [sent, setSent] = useState<{ id?: string; status: string; error?: string } | null>(null);
  const [raw, setRaw] = useState("");
  const [report, setReport] = useState<AuthReport | null>(null);

  const smtpReady = transport === "smtp" && mailboxes.length > 0;
  const customDomain = domain.domain !== "mail.example.com";
  const dnsOk = checks !== null && checks.every((c) => c.status === "ok" || c.status === "skipped");
  const done = [customDomain, smtpReady, dnsOk, sent?.status === "delivered" || sent?.status === "queued", report?.ok === true];
  const current = PRESETS.find((p) => p.id === preset) ?? PRESETS[PRESETS.length - 1];

  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setBusy(true);
    try {
      const text = await fn();
      setMsg(text ? { tone: "ok", text } : null);
    } catch (e) {
      setMsg({ tone: "error", text: e instanceof Error ? e.message : "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  const checkDns = useCallback(async (): Promise<void> => {
    try {
      setChecks((await api<{ results: Check[] }>(`/api/domains/${encodeURIComponent(domain.domain)}/check`)).results);
    } catch {
      setChecks(null);
    }
  }, [domain.domain]);

  // Poll DNS while that step is open: records can take minutes to propagate.
  useEffect(() => {
    if (step !== 2) return;
    const first = window.setTimeout(() => void checkDns(), 0);
    const t = window.setInterval(() => void checkDns(), 8000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [step, checkDns]);

  const pickPreset = (id: string): void => {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[PRESETS.length - 1];
    setPreset(id);
    setHost(p.host);
    setPort(String(p.port));
    setSecurity(p.security);
    setUsername(p.username);
  };

  const copy = (text: string): void => void navigator.clipboard?.writeText(text).catch(() => undefined);
  const nav = (back: boolean, next: boolean) => (
    <div className="flex gap-2 pt-2">
      {back ? <Button onClick={() => setStep(step - 1)}>Back</Button> : null}
      {next ? <Button variant="primary" onClick={() => setStep(step + 1)}>Next</Button> : null}
    </div>
  );

  return (
    <div>
      <PageHeader title="Set up Sealpost" description="Five steps from a fresh install to a verified inbox. Nothing is sent until step 4." />
      <Stepper step={step} done={done} onStep={setStep} />
      {msg ? <p role={msg.tone === "error" ? "alert" : "status"} className={`mb-4 rounded-lg border p-3 text-xs ${msg.tone === "error" ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-200" : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-200"}`}>{msg.text}</p> : null}

      {step === 0 ? (
        <Card>
          <CardHeader icon={<Rocket size={16} />} title="1. Your sending domain" subtitle="Use a subdomain such as mail.yourdomain.com so reputation problems never touch your main domain" />
          <div className="space-y-3 p-4">
            {field("Domain", <TextInput value={dom} onChange={(e) => setDom(e.target.value.trim().toLowerCase())} placeholder="mail.yourdomain.com" className="font-mono text-xs" />)}
            {field("From name", <TextInput value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Acme" className="text-xs" />)}
            {field("From address", <TextInput value={fromEmail} onChange={(e) => setFromEmail(e.target.value.trim())} placeholder={`hello@${dom || "mail.yourdomain.com"}`} className="font-mono text-xs" />, "Must be on the domain above; the gate blocks anything else.")}
            <div className="flex gap-2 pt-2">
              <Button variant="primary" disabled={busy || dom === "" || fromEmail === ""} onClick={() => void run(async () => {
                await api("/api/setup", { method: "PUT", body: { domain: { ...domain, domain: dom, fromName, fromEmail } } });
                await onChanged();
                setStep(1);
                return `Saved ${dom}`;
              })}>Save and continue</Button>
            </div>
          </div>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader icon={<Rocket size={16} />} title="2. Your SMTP relay" subtitle="Sealpost signs and checks the message; a relay delivers it" right={smtpReady ? <Badge tone="emerald">configured</Badge> : <Badge tone="amber">sink only</Badge>} />
          <div className="space-y-3 p-4">
            {field("Provider", <Select aria-label="Provider" value={preset} onChange={(e) => pickPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>, current.hint)}
            <div className="grid gap-3 sm:grid-cols-[1fr_100px_140px]">
              {field("Host", <TextInput value={host} onChange={(e) => setHost(e.target.value.trim())} className="font-mono text-xs" />)}
              {field("Port", <TextInput value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="font-mono text-xs" />)}
              {field("Security", <Select aria-label="Security" value={security} onChange={(e) => setSecurity(e.target.value as Mailbox["security"])}><option value="starttls">STARTTLS</option><option value="tls">TLS</option><option value="none">None</option></Select>)}
            </div>
            {field("Username", <TextInput value={username} onChange={(e) => setUsername(e.target.value)} className="font-mono text-xs" />)}
            {field("Password variable", <TextInput value={passwordEnv} onChange={(e) => setPasswordEnv(e.target.value.toUpperCase())} className="font-mono text-xs" />, "The password is never stored. Sealpost reads it from this environment variable.")}
            <p className="rounded-lg bg-slate-100 p-3 font-mono text-[11px] text-slate-700 dark:bg-white/5 dark:text-slate-300">export {passwordEnv || "SMTP_PASSWORD"}=&apos;…&apos;   <span className="text-slate-500"># then restart `sealpost studio`</span>{existing?.passwordEnv ? <>  ·  {passwordEnvSet[existing.id] ? <span className="text-emerald-600 dark:text-emerald-400">variable is set</span> : <span className="text-rose-600 dark:text-rose-400">variable is not set</span>}</> : null}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" disabled={busy || host === "" || !/^[A-Z_][A-Z0-9_]*$/.test(passwordEnv)} onClick={() => void run(async () => {
                const box: Mailbox = { id: existing?.id ?? "main", label: current.label, host, port: Number(port) || 587, security, username: username || undefined, passwordEnv };
                await api("/api/setup", { method: "PUT", body: { transport: "smtp", mailboxes: [box], domain: { ...domain, spfInclude: current.spfInclude ?? domain.spfInclude } } });
                await onChanged();
                setProbe(null);
                return "Saved. Test the login below.";
              })}>Save relay</Button>
              <Button disabled={busy || !smtpReady} onClick={() => void run(async () => {
                const r = await api<{ checks: DoctorCheck[] }>("/api/doctor", { method: "POST", body: {} });
                setProbe(r.checks.filter((c) => c.id.startsWith("mailbox:")));
              })}>Test login (sends nothing)</Button>
            </div>
            {probe ? (
              <ul className="space-y-1 text-xs">
                {probe.length === 0 ? <li className="text-slate-500">No mailbox to test yet.</li> : probe.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">{c.status === "pass" ? <CheckCircle2 size={14} className="mt-px shrink-0 text-emerald-500" /> : <XCircle size={14} className="mt-px shrink-0 text-rose-500" />}<span><b>{c.title}</b> <span className="text-slate-500">{c.detail}</span>{c.fix ? <span className="block text-slate-500">→ {c.fix}</span> : null}</span></li>
                ))}
              </ul>
            ) : null}
            {nav(true, true)}
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardHeader icon={<Rocket size={16} />} title="3. Publish DNS records" subtitle="Add these at your DNS host; this page re-checks every few seconds" right={dnsOk ? <Badge tone="emerald">all set</Badge> : <Badge tone="amber">waiting</Badge>} />
          <div className="space-y-3 p-4">
            {dns.map((r) => {
              const c = checks?.find((x) => x.purpose === r.purpose);
              return (
                <div key={r.purpose} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    {c ? c.status === "ok" ? <CheckCircle2 size={14} className="text-emerald-500" /> : c.status === "skipped" ? <MinusCircle size={14} className="text-slate-400" /> : <XCircle size={14} className="text-rose-500" /> : <Circle size={14} className="text-slate-400" />}
                    <b>{r.purpose}</b><Badge tone="slate">{r.type}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">{r.fqdn}</span>
                    <button type="button" aria-label={`Copy ${r.purpose} value`} onClick={() => copy(r.value)} className="cursor-pointer rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><Copy size={13} /></button>
                  </div>
                  <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 font-mono text-[11px] dark:bg-white/5">{r.value}</pre>
                  <p className="mt-1 text-slate-500">{c && c.status !== "ok" && c.status !== "skipped" ? c.detail : r.note}</p>
                </div>
              );
            })}
            <div className="flex gap-2 pt-1"><Button onClick={() => void checkDns()}>Check now</Button></div>
            {nav(true, true)}
          </div>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <CardHeader icon={<Rocket size={16} />} title="4. Send a real test" subtitle="Goes through the full gate and your relay, to an inbox you own" />
          <div className="space-y-3 p-4">
            {!smtpReady ? <p className="text-xs text-amber-700 dark:text-amber-300">Transport is still the local sink, so this stays on this machine. Finish step 2 for a real send.</p> : null}
            {field("Send to", <TextInput type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" className="text-xs" />)}
            <Button variant="primary" disabled={busy || to.trim() === "" || templates.length === 0} onClick={() => void run(async () => {
              const t = templates.find((x) => x.id === "magic_link_otp_verification") ?? templates[0];
              try {
                const r = await api<{ id?: string; status: string }>("/api/send", { method: "POST", body: { templateId: t.id, to: to.trim(), autoFill: true, tags: [{ name: "source", value: "setup-wizard" }] } });
                setSent({ id: r.id, status: r.status });
                return r.status === "delivered" ? "Handed to the relay." : "Queued for retry.";
              } catch (e) {
                setSent({ status: "failed", error: e instanceof Error ? e.message : "Send failed" });
                throw e;
              }
            })}>Send test email</Button>
            {sent && sent.status !== "failed" ? (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-800">
                <p>Now open the message in that inbox and view its <b>original</b> (Gmail: ⋮ → Show original). Paste it here to see what the receiver decided about DKIM, SPF and DMARC.</p>
                <TextArea aria-label="Original message" rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Delivered-To: …&#10;Authentication-Results: mx.google.com; dkim=pass …" />
                <Button disabled={busy || raw.trim().length < 20} onClick={() => void run(async () => {
                  setReport((await api<{ report: AuthReport }>("/api/auth-check", { method: "POST", body: { raw } })).report);
                })}>Check authentication</Button>
                {report ? (
                  <div className="space-y-1">
                    <p className="font-semibold">{report.ok ? "Fully authenticated: DKIM, SPF and DMARC all pass." : "Not fully authenticated yet."}</p>
                    {report.results.map((r, i) => <p key={i} className="flex items-center gap-2">{r.verdict === "pass" ? <CheckCircle2 size={13} className="text-emerald-500" /> : <XCircle size={13} className="text-rose-500" />}<b>{r.method.toUpperCase()}</b> {r.verdict} <span className="text-slate-500">{r.receiver}</span></p>)}
                    {report.problems.map((p) => <p key={p} className="text-amber-700 dark:text-amber-300">▲ {p}</p>)}
                  </div>
                ) : null}
              </div>
            ) : null}
            {nav(true, true)}
          </div>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader icon={<Rocket size={16} />} title="5. You're set" subtitle="Send from your app" />
          <div className="space-y-3 p-4 text-xs">
            <ul className="space-y-1">{STEPS.slice(0, 4).map((s, i) => <li key={s} className="flex items-center gap-2">{done[i] ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Circle size={14} className="text-slate-400" />}{s}</li>)}</ul>
            <pre className="overflow-auto rounded-lg bg-slate-100 p-3 font-mono text-[11px] dark:bg-white/5">{`npm i @sealpost/sdk\n\nconst mail = new Sealpost({ apiKey: process.env.SEALPOST_KEY, baseUrl: "https://your-sealpost-host" });\nawait mail.emails.send({ template: "${templates[0]?.id ?? "magic_link_otp_verification"}", to: "user@example.org", variables: { … }, idempotencyKey: "order-1001" });`}</pre>
            <p className="text-slate-500">Create an API key with <code className="font-mono">sealpost auth add-key my-app</code>. Watch every email on the Logs tab.</p>
            <div className="flex gap-2"><Button onClick={() => setStep(3)}>Back</Button><Button variant="primary" onClick={onDone}>Go to Logs</Button></div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
