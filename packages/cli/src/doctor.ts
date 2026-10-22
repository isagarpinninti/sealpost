import { checkDnsRecords, type DnsCheckResult, type MxResolver, type TxtResolver } from "@sealpost/core";
import { allDomains, dkimKeyPathFor } from "./project";
import { dnsCheckOptions, dnsRecordsFor, type Runtime } from "./runtime";
import { sendRawSmtp, type SmtpEndpoint } from "./smtp/client";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
  /** What to do about it. */
  fix?: string;
}

export interface DoctorDeps {
  resolveTxt: TxtResolver;
  /** Connects, upgrades to TLS and logs in, without sending mail. */
  probe: (endpoint: SmtpEndpoint, helo: string, allowPrivateNetworks: boolean) => Promise<{ ok: boolean; detail: string }>;
  env: NodeJS.ProcessEnv;
  /** Override the MX lookup (tests). */
  resolveMx?: MxResolver;
}

export const defaultProbe: DoctorDeps["probe"] = async (endpoint, helo, allowPrivateNetworks) => {
  const r = await sendRawSmtp({ endpoint, from: `doctor@${helo}`, recipients: [], data: "", helo, allowPrivateNetworks, timeoutMs: 15_000, probe: true });
  return { ok: r.ok, detail: r.ok ? `${r.banner.slice(0, 60)} · ${r.finalResponse}` : (r.error ?? r.finalResponse) };
};

const isLocalUrl = (u: string): boolean => /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(u);

/**
 * Everything that has to be true before real mail leaves your server: relay credentials, DNS, tracking and
 * unsubscribe settings. It sends nothing. Each failing check says how to fix it.
 */
export async function runDoctor(rt: Runtime, deps: DoctorDeps): Promise<DoctorCheck[]> {
  const cfg = rt.project.config;
  const out: DoctorCheck[] = [];
  const add = (c: DoctorCheck): void => void out.push(c);

  add({ id: "project", status: "pass", title: "Project is valid", detail: `${rt.project.templates.length} templates, ${allDomains(cfg).length} sending domain${allDomains(cfg).length === 1 ? "" : "s"}` });

  for (const d of allDomains(cfg)) {
    const path = d.domain === cfg.domain.domain ? rt.project.paths.dkimKey : dkimKeyPathFor(rt.project, d.domain);
    try {
      const mode = await rt.project.storage.mode(path);
      if (mode === null && !(await rt.project.storage.exists(path))) throw new Error("missing");
      add(mode !== null && mode & 0o077 ? { id: `key:${d.domain}`, status: "warn", title: `DKIM key for ${d.domain} is readable by others`, detail: `mode ${mode?.toString(8) ?? ""}`, fix: `chmod 600 ${path}` } : { id: `key:${d.domain}`, status: "pass", title: `DKIM key for ${d.domain}`, detail: mode === null ? "stored in the database" : `mode ${mode.toString(8)}` });
    } catch {
      add({ id: `key:${d.domain}`, status: "fail", title: `DKIM key for ${d.domain} is missing`, detail: path, fix: "Run `sealpost dns` to generate it, then publish the record." });
    }
  }

  if (cfg.transport === "sink") {
    add({ id: "transport", status: "warn", title: "Transport is 'sink'", detail: "Mail is captured in the local test inbox and never leaves this machine.", fix: 'Set "transport": "smtp" and add a mailbox in sealpost.config.json.' });
  } else {
    for (const m of cfg.mailboxes) {
      if (m.passwordEnv && deps.env[m.passwordEnv] === undefined) {
        add({ id: `mailbox:${m.id}`, status: "fail", title: `Mailbox '${m.id}': ${m.passwordEnv} is not set`, detail: `${m.host}:${m.port}`, fix: `export ${m.passwordEnv}='…' before running sealpost.` });
        continue;
      }
      const endpoint: SmtpEndpoint = { id: m.id, host: m.host, port: m.port, security: m.security, username: m.username, password: m.passwordEnv ? deps.env[m.passwordEnv] : undefined };
      const r = await deps.probe(endpoint, cfg.domain.domain, cfg.allowPrivateNetworks).catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : "probe failed" }));
      add(r.ok ? { id: `mailbox:${m.id}`, status: "pass", title: `Mailbox '${m.id}' accepts the login`, detail: `${m.host}:${m.port} · ${r.detail}` } : { id: `mailbox:${m.id}`, status: "fail", title: `Mailbox '${m.id}' cannot be used`, detail: `${m.host}:${m.port} · ${r.detail}`, fix: m.port === 25 ? "Most hosts block outbound port 25. Use 587 (starttls) or 465 (tls) on your relay." : "Check host, port, security mode, username and password." });
    }
    if (cfg.mailboxes.length === 1) add({ id: "failover", status: "warn", title: "Only one mailbox configured", detail: "There is no failover if the relay is down.", fix: "Add a second relay as a backup mailbox." });
  }

  for (const d of allDomains(cfg)) {
    let results: DnsCheckResult[];
    try {
      results = await checkDnsRecords(await dnsRecordsFor(rt, d), deps.resolveTxt, { ...dnsCheckOptions(rt, d), ...(deps.resolveMx ? { resolveMx: deps.resolveMx } : {}) });
    } catch (e) {
      add({ id: `dns:${d.domain}`, status: "fail", title: `DNS lookup for ${d.domain} failed`, detail: e instanceof Error ? e.message : "lookup failed" });
      continue;
    }
    for (const r of results) {
      if (r.status === "skipped") continue;
      add({ id: `dns:${d.domain}:${r.purpose}`, status: r.status === "ok" ? "pass" : "fail", title: `${r.purpose} for ${d.domain}`, detail: `${r.fqdn} · ${r.detail}`, fix: r.status === "ok" ? undefined : `Publish the record shown by \`sealpost dns --domain ${d.domain}\`, then re-run doctor (DNS can take minutes to propagate).` });
    }
    if (cfg.transport === "smtp" && !d.spfInclude) add({ id: `spf-include:${d.domain}`, status: "warn", title: `${d.domain} has no spfInclude`, detail: "SPF will not authorise your relay's servers.", fix: "Set domain.spfInclude to your relay's SPF host, for example amazonses.com or _spf.yourprovider.com." });
    if (d.dmarcPolicy === "none") add({ id: `dmarc-policy:${d.domain}`, status: "warn", title: `DMARC policy for ${d.domain} is p=none`, detail: "Receivers will not act on failures.", fix: "Start with none, review the rua reports, then move to quarantine and reject." });
    if (!d.unsubscribeUrl) add({ id: `unsub:${d.domain}`, status: "warn", title: `${d.domain} has no unsubscribeUrl`, detail: "No List-Unsubscribe header is added. Gmail and Yahoo require one-click unsubscribe for bulk senders.", fix: "Set domain.unsubscribeUrl (not needed for purely transactional mail)." });
    if (d.trackingBaseUrl && isLocalUrl(d.trackingBaseUrl) && cfg.transport === "smtp") add({ id: `tracking:${d.domain}`, status: "warn", title: `Tracking URL for ${d.domain} is a local address`, detail: d.trackingBaseUrl, fix: "Set trackingBaseUrl to a public HTTPS URL that reaches `sealpost studio`, or remove it to disable open and click tracking." });
  }

  if (cfg.inbound.enabled) {
    const i = cfg.inbound;
    if (!i.mxHost) add({ id: "inbound:mxhost", status: "warn", title: "inbound.mxHost is not set", detail: "The MX record falls back to mx.<your domain>, which probably does not exist.", fix: "Set inbound.mxHost to this server's public hostname, then publish the MX record from `sealpost dns`." });
    if (i.port !== 25) add({ id: "inbound:port", status: "warn", title: `The listener is on port ${i.port}, not 25`, detail: "Mail servers always connect to port 25; an MX record cannot name a port.", fix: `Redirect 25 to ${i.port} (for example: iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port ${i.port}), or run Sealpost with permission to bind 25. Many cloud hosts block inbound 25: use \`POST /hooks/inbound/raw\` from your relay instead.` });
    if (!i.tls) add({ id: "inbound:tls", status: "warn", title: "Inbound STARTTLS is not configured", detail: "Mail to you crosses the internet in clear text unless the sender can upgrade.", fix: "Set inbound.tls { keyFile, certFile } to a certificate for inbound.mxHost (Let's Encrypt works)." });
    else add({ id: "inbound:tls", status: "pass", title: "Inbound STARTTLS is configured", detail: i.tls.certFile });
    if (i.host === "127.0.0.1") add({ id: "inbound:host", status: "warn", title: "The listener is bound to 127.0.0.1", detail: "Only this machine can deliver to it.", fix: 'Set inbound.host to "0.0.0.0" to accept mail from the internet.' });
    if (i.retentionDays === 0) add({ id: "inbound:retention", status: "warn", title: "Received mail is kept forever", detail: "Disk use grows with every message.", fix: "Set inbound.retentionDays to delete old mail automatically." });
  }

  for (const w of cfg.webhooks) {
    if (deps.env[w.secretEnv] === undefined) add({ id: `webhook:${w.id}`, status: "fail", title: `Webhook '${w.id}': ${w.secretEnv} is not set`, detail: w.url, fix: `export ${w.secretEnv}='…' (deliveries cannot be signed without it).` });
  }
  return out;
}
