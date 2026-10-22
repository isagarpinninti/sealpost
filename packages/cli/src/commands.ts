import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  SAMPLE_DOMAIN,
  TEMPLATE_PACKS,
  addSuppression,
  analyzeAuthenticationResults,
  ImportError,
  importTemplate,
  type ImportFormat,
  parseMimeMessage,
  checkDnsRecords,
  autoFillSampleVariables,
  decodeDeliveryReceipt,
  evaluateDispatchPreflight,
  referencedVariables,
  removeSuppression,
  verifyDeliveryReceipt,
  type EmailTemplate,
  type SuppressionReason,
  type VariableValues,
} from "@sealpost/core";
import { addContacts, cancelBroadcast, createAudience, createBroadcast, deleteAudience, processBroadcasts, removeContact } from "./broadcast";
import { previewEmail, processQueue, sendEmail } from "./dispatch";
import { runMcp } from "./mcp";
import { diskStorage } from "./storage";
import { cancelScheduled, processScheduled, scheduleEmail } from "./scheduled";
import { emitEvent, processOutbox } from "./outbound";
import { defaultProbe, runDoctor } from "./doctor";
import { queryEmails, readEmails, type EmailStatus } from "./emaillog";
import { ingestInbound } from "./inbound/ingest";
import { deleteInbound, listInboundAll, queryInbound, readInbound, readInboundRaw } from "./inbound/store";
import { dnsCheckOptions, dnsRecordsFor, domainFor, openRuntime, type Runtime } from "./runtime";
import { resolveTxt } from "node:dns/promises";
import { loadOrCreateDkimKey, loadOrCreateReceiptKey } from "./key";
import { readLedger, verifyLedgerFile } from "./ledger";
import { CONFIG_FILE, ConfigSchema, KEY_SCOPES, keyRecord, type ApiKeyRecord, type KeyScope, ProjectError, WEBHOOK_EVENTS, allDomains, loadProject, projectPaths, saveConfig, writeFileAtomic, type Project, type ProjectConfig } from "./project";
import { startServer } from "./server";
import { startSmtpSink } from "./smtp/sink";
import { readScheduled, readAudit, publicBroadcast, publicDelivery, readAudiences, readBroadcasts, readOutbox, readQueue, readSuppressions, saveInboxMessage, writeSuppressions } from "./store";
import { styles, type Io } from "./ui";
import { VERSION } from "./version";

type OptionDef = { type: "string" | "boolean"; short?: string; multiple?: boolean };

/** Exit codes: 0 ok · 1 error · 2 blocked by the pre-flight gate, delivery failed or tampering detected. */
export type ExitCode = 0 | 1 | 2;

const HELP = `sealpost ${VERSION} — self-hosted visual email: native MIME, RFC 6376 DKIM and raw SMTP, no nodemailer

Usage: sealpost <command> [options]

Commands
  init [dir]                         Scaffold sealpost.config.json, 5 templates and the DKIM + receipt keys
  validate [dir]                     Validate config and templates (every {{var}} must be declared)
  dns [dir]                          Print the SPF, DKIM, DMARC and MX records to paste into your DNS
  compile <templateId>               Compile + run the EW-101…108 pre-flight gate        (exit 2 when blocked)
        --var key=value                 template variable (repeatable)     --to <email>  recipient
        --auto-fill                     fill missing variables from samples    --mime  print the DKIM-signed message
  send <templateId> --to <email>     Compile, DKIM-sign, send over raw SMTP, seal an evw_ receipt
        --var key=value  --cc <email>  --bcc <email>  --auto-fill  --domain <sending domain>  --at <ISO time>
  storage status|migrate             Where state lives (disk or Postgres); migrate copies .sealpost/ into the database named by storage.urlEnv
  mcp [--allow-send]                 Model Context Protocol server on stdio, so an AI assistant can read mail and (opt in) send
  scheduled list|cancel <id>|run     Sends scheduled for later (up to 90 days)
  template import|list                Import an MJML, React Email (.tsx) or HTML file as a template  (--format --id --name --force --dry-run)
  inbound list|show|import|raw|attachment|delete   Received mail: list, read, import a .eml, save attachments  (--from --to --q --kind)
  logs [show <em_id>]                What happened to each email: status, timeline, tags  --status --to --tag name:value --template --limit
  doctor [--send you@gmail.com]      Check relay login, DNS, tracking and unsubscribe before real mail   (exit 2 on failures)
  auth-check <file.eml>              Did DKIM, SPF and DMARC pass? Reads the headers a receiving inbox added  (exit 2 if not)
  domain list|add|remove|check       Several sending domains in one install        (check = live DNS, exit 2 if wrong)
  audience create|list|show|add|import|remove|delete   Contact lists (CSV import)
  broadcast create|list|show|cancel|run   Scheduled sends to an audience           --audience --template --at <ISO> --rate <per min>
  webhook list|add|remove|test|log|run    Signed, retried event webhooks to your own app
  studio [dir]                       Visual Studio + REST API + test inbox on http://127.0.0.1:4320
  ledger verify|list [dir]           Verify the hash-chained delivery ledger             (exit 2 on tampering)
  receipt verify <file|evw_…>        Verify a receipt offline  [--eml message.eml]       (exit 2 on failure)
  queue list|run [dir]               Show or process the retry queue (10 s → 1 min → 5 min)
  suppress list|add|remove [email]   Manage the suppression list  [--reason hard_bounce|unsubscribed|complaint]
  sink [--port 2525]                 Run a standalone loopback SMTP sink and print what arrives
  key show [dir]                     Receipt-signing key fingerprint and DKIM public key
  auth add-key|list|revoke           API keys with scopes (send, read, write) and expiry: auth add-key app --scope send --expires 90
  audit [--actor key:app]            Who changed what: every write and every failed login, with the key and IP

Common options
  --dir <path>     Project directory (default: .)
  --json           Machine-readable output
  -h, --help       Show help      -v, --version   Show version

Examples
  sealpost init my-mail && cd my-mail
  sealpost send magic_link_otp_verification --to you@example.org --auto-fill
  sealpost studio --open
`;

const COMMON = { dir: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;

function parse<const O extends Record<string, OptionDef>>(argv: string[], own: O) {
  return parseArgs({ args: argv, options: { ...COMMON, ...own }, allowPositionals: true, strict: true });
}

function printIssues(io: Io, issues: string[]): void {
  const c = styles(io);
  for (const i of issues) io.err(`  ${c.red("✖")} ${i}`);
}

function fail(io: Io, e: unknown): ExitCode {
  const c = styles(io);
  io.err(`${c.red("✖")} ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof ProjectError) printIssues(io, e.issues);
  return 1;
}

function parseVars(template: EmailTemplate, sets: string[] | undefined): VariableValues {
  const out: VariableValues = {};
  for (const kv of sets ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`--var expects key=value, got '${kv}'`);
    const key = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    const decl = template.variables.find((v) => v.key === key);
    if (!decl) throw new Error(`'${key}' is not a variable of ${template.id}. Variables: ${template.variables.map((v) => v.key).join(", ")}`);
    if (decl.type === "number" || decl.type === "currency") {
      const n = Number(raw.replace(/[$,]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`'${raw}' is not a number`);
      out[key] = n;
    } else if (decl.type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Error(`'${raw}' is not true or false`);
      out[key] = raw === "true";
    } else out[key] = raw;
  }
  return out;
}

async function runtimeFor(dir: string): Promise<Runtime> {
  return openRuntime(await loadProject(dir));
}

/* ───────────────────────── init / validate / dns ───────────────────────── */

async function init(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { name: { type: "string" }, domain: { type: "string" }, from: { type: "string" }, force: { type: "boolean" } });
  const dir = resolve(positionals[0] ?? values.dir ?? ".");
  const paths = projectPaths(dir);
  const c = styles(io);
  try {
    await stat(paths.config);
    if (!values.force) {
      io.err(`${c.red("✖")} ${CONFIG_FILE} already exists in ${dir}. Use --force to overwrite.`);
      return 1;
    }
  } catch {
    /* fresh project */
  }
  const domain = values.domain ?? SAMPLE_DOMAIN.domain;
  const config: ProjectConfig = {
    name: String(values.name ?? dir.split(/[\\/]/).pop() ?? "sealpost-project"),
    domain: { ...SAMPLE_DOMAIN, domain, fromEmail: values.from ?? `hello@${domain}`, replyTo: `support@${domain}`, trackingBaseUrl: "http://127.0.0.1:4320" },
    transport: "sink",
    mailboxes: [],
    auth: { keys: {} },
    domains: [],
    unsubscribe: { hosted: false },
    limits: { sendsPerMinute: 0 },
    storage: { type: "disk", urlEnv: "DATABASE_URL", schema: "sealpost", namespace: "default" },
    submission: { enabled: false, host: "127.0.0.1", port: 2587, implicitTls: false, maxMessageMb: 25 },
    inbound: { enabled: false, host: "0.0.0.0", port: 2525, domains: [], maxMessageMb: 25, retentionDays: 0 },
    webhooks: [],
    webhookUrl: "",
    allowPrivateNetworks: false,
    dedupeWindowMinutes: 1440,
  };
  await mkdir(paths.templates, { recursive: true });
  await writeFileAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  for (const t of TEMPLATE_PACKS) await writeFileAtomic(join(paths.templates, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
  await loadOrCreateDkimKey(paths.dkimKey);
  await loadOrCreateReceiptKey(paths.receiptKey);
  await writeFile(join(dir, ".gitignore"), ".sealpost/\n", { flag: "a" });
  io.out(`${c.green("✔")} Created ${c.bold(config.name)} in ${dir}`);
  io.out(`  ${CONFIG_FILE}   domain, transport (sink), mailboxes`);
  io.out(`  templates/         ${TEMPLATE_PACKS.length} visual email templates`);
  io.out(`  .sealpost/        DKIM (RSA-2048) and receipt (ECDSA P-256) keys, mode 0600`);
  io.out("");
  io.out("Next:");
  io.out(`  ${c.cyan("sealpost send magic_link_otp_verification --to you@example.org --auto-fill")}   delivers to the local test inbox`);
  io.out(`  ${c.cyan("sealpost dns")}      the DNS records for your own domain`);
  io.out(`  ${c.cyan("sealpost studio")}   open the visual studio`);
  return 0;
}

async function validate(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {});
  const c = styles(io);
  try {
    const p = await loadProject(positionals[0] ?? values.dir ?? ".");
    const rt = await openRuntime(p);
    const problems: string[] = [];
    for (const t of p.templates) {
      const r = await evaluateDispatchPreflight({ to: "validate@example.org", variables: autoFillSampleVariables(t, {}) }, { template: t, domain: p.config.domain });
      if (r.gate === "BLOCKED") problems.push(...r.checks.filter((k) => k.severity === "block" && k.code !== "EW-103").map((k) => `templates/${t.id}.json: ${k.code} ${k.message}`));
      for (const k of referencedVariables(t)) if (!t.variables.some((v) => v.key === k)) problems.push(`templates/${t.id}.json: {{${k}}} is not declared`);
    }
    void rt;
    if (problems.length) {
      if (values.json) io.out(JSON.stringify({ ok: false, issues: problems }, null, 2));
      else {
        io.err(`${c.red("✖")} ${p.config.name} has ${problems.length} issue(s)`);
        printIssues(io, problems);
      }
      return 1;
    }
    if (values.json) io.out(JSON.stringify({ ok: true, project: p.config.name, templates: p.templates.map((t) => t.id), transport: p.config.transport }, null, 2));
    else {
      io.out(`${c.green("✔")} ${c.bold(p.config.name)} is valid`);
      io.out(`  ${p.templates.length} templates · domain ${p.config.domain.domain} · transport ${p.config.transport}${p.config.transport === "smtp" ? ` (${p.config.mailboxes.length} mailbox${p.config.mailboxes.length === 1 ? "" : "es"})` : ""}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ProjectError && values.json) {
      io.out(JSON.stringify({ ok: false, error: e.message, issues: e.issues }, null, 2));
      return 1;
    }
    return fail(io, e);
  }
}

async function dnsCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { domain: { type: "string" } });
  const c = styles(io);
  try {
    const rt = await runtimeFor(positionals[0] ?? values.dir ?? ".");
    const profile = domainFor(rt, values.domain);
    const records = await dnsRecordsFor(rt, profile);
    if (values.json) {
      io.out(JSON.stringify(records, null, 2));
      return 0;
    }
    io.out(`${c.bold(`DNS records for ${profile.domain}`)}  ${c.dim("add these at your DNS host (Cloudflare, Namecheap, Route 53…)")}\n`);
    for (const r of records) {
      io.out(`${c.cyan(r.purpose.padEnd(5))} ${r.type.padEnd(3)}  ${r.fqdn}`);
      io.out(`      ${r.type === "TXT" ? r.zoneValue : r.value}`);
      io.out(`      ${c.dim(r.note)}\n`);
    }
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── compile / send ───────────────────────── */

function showChecks(io: Io, gate: string, score: number, checks: Array<{ code: string; severity: string; message: string }>): void {
  const c = styles(io);
  const tone = gate === "CLEAR" ? c.green : gate === "WARN" ? c.yellow : c.red;
  io.out(`${tone(gate)}  ${c.dim(`deliverability score ${score}/100`)}`);
  for (const k of checks) io.out(`  ${k.severity === "ok" ? c.green("✔") : k.severity === "warn" ? c.yellow("▲") : c.red("✖")} ${c.dim(k.code)} ${k.message}`);
}

async function compileCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { var: { type: "string", multiple: true }, to: { type: "string" }, "auto-fill": { type: "boolean" }, mime: { type: "boolean" } });
  const c = styles(io);
  const id = positionals[0];
  if (!id) {
    io.err(`${c.red("✖")} Usage: sealpost compile <templateId> [--var k=v] [--to email] [--auto-fill] [--mime] [--json]`);
    return 1;
  }
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const template = rt.project.templates.find((t) => t.id === id);
    if (!template) throw new Error(`Unknown template '${id}'. Available: ${rt.project.templates.map((t) => t.id).join(", ")}`);
    const p = await previewEmail(rt, { templateId: id, to: values.to ?? "preview@example.org", variables: parseVars(template, values.var), autoFill: Boolean(values["auto-fill"]) }, { mime: Boolean(values.mime) });
    const blocked = p.preflight.gate === "BLOCKED";
    if (values.json) {
      io.out(JSON.stringify({ gate: p.preflight.gate, score: p.preflight.score, checks: p.preflight.checks, subject: p.preflight.compiled.subject, idempotencyKey: p.preflight.idempotencyKey, rawMime: p.rawMime, dkim: p.dkim }, null, 2));
      return blocked ? 2 : 0;
    }
    io.out(`${c.bold(template.name)}  ${c.dim(`subject: ${p.preflight.compiled.subject}`)}`);
    showChecks(io, p.preflight.gate, p.preflight.score, p.preflight.checks);
    if (values.mime) {
      if (p.rawMime) io.out(`\n${p.rawMime}`);
      else io.err(c.dim("(the message was not built: header-injection guard EW-102 blocked it)"));
    }
    return blocked ? 2 : 0;
  } catch (e) {
    return fail(io, e);
  }
}

async function sendCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { var: { type: "string", multiple: true }, to: { type: "string", multiple: true }, cc: { type: "string", multiple: true }, bcc: { type: "string", multiple: true }, "auto-fill": { type: "boolean" }, domain: { type: "string" }, at: { type: "string" } });
  const c = styles(io);
  const id = positionals[0];
  if (!id || !values.to?.length) {
    io.err(`${c.red("✖")} Usage: sealpost send <templateId> --to <email> [--var k=v] [--cc email] [--bcc email] [--auto-fill]`);
    return 1;
  }
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const template = rt.project.templates.find((t) => t.id === id);
    if (!template) throw new Error(`Unknown template '${id}'. Available: ${rt.project.templates.map((t) => t.id).join(", ")}`);
    if (values.at !== undefined && Date.parse(values.at) > Date.now() + 1000) {
      const item = await scheduleEmail(rt, { templateId: id, domain: values.domain, to: values.to, cc: values.cc, bcc: values.bcc, variables: parseVars(template, values.var), autoFill: Boolean(values["auto-fill"]) }, values.at);
      io.out(values.json ? JSON.stringify({ status: "scheduled", id: item.id, scheduledAt: item.scheduledAtIso }) : `${c.green("✔")} Scheduled ${c.bold(item.id)} for ${item.scheduledAtIso}. It is sent by \`sealpost studio\` (or \`sealpost scheduled run\`); the gate runs again at that time.`);
      return 0;
    }
    const out = await sendEmail(rt, { templateId: id, domain: values.domain, to: values.to, cc: values.cc, bcc: values.bcc, variables: parseVars(template, values.var), autoFill: Boolean(values["auto-fill"]) });
    if (values.json) {
      io.out(JSON.stringify({ status: out.status, messageId: out.messageId, receiptId: out.receipt?.receiptId, receipt: out.receipt?.token, ledgerSeq: out.record?.seq, smtp: out.smtp && { ...out.smtp, transcript: undefined }, queueId: out.queueId, suppressed: out.suppressed, checks: out.preflight.checks, error: out.error }, null, 2));
      return out.status === "blocked" || out.status === "failed" ? 2 : 0;
    }
    if (out.status === "blocked") {
      showChecks(io, out.preflight.gate, out.preflight.score, out.preflight.checks);
      io.err(`${c.red("✖")} BLOCKED by the pre-flight gate: no socket was opened.`);
      return 2;
    }
    if (out.status === "delivered" && out.receipt) {
      io.out(`${c.green("✔")} Delivered via ${out.smtp?.host}:${out.smtp?.port}  ${c.dim(out.smtp?.finalResponse ?? "")}`);
      io.out(`  receipt   ${c.bold(out.receipt.receiptId)}  ledger #${out.record?.seq}`);
      io.out(`  message   ${out.messageId}`);
      if (out.preflight.gate === "WARN") for (const k of out.preflight.checks.filter((x) => x.severity === "warn")) io.out(`  ${c.yellow("▲")} ${k.code} ${k.message}`);
      for (const s of out.suppressed ?? []) io.out(`  ${c.yellow("▲")} ${s} hard-bounced and was added to the suppression list`);
      return 0;
    }
    if (out.status === "queued") {
      io.out(`${c.yellow("▲")} Not delivered yet: ${out.error ?? "transient failure"}. Queued as ${out.queueId}; retries at 10 s, 1 min and 5 min (run \`sealpost queue run\` or keep \`sealpost studio\` running).`);
      return 0;
    }
    io.err(`${c.red("✖")} Delivery failed: ${out.error}`);
    for (const s of out.suppressed ?? []) io.err(`  ${c.yellow("▲")} ${s} hard-bounced and was added to the suppression list`);
    return 2;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── ledger / receipt / queue / suppress / sink ───────────────────────── */

async function ledgerCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { limit: { type: "string" } });
  const c = styles(io);
  const paths = projectPaths(positionals[1] ?? values.dir ?? ".");
  try {
    const storage = (await loadProject(positionals[1] ?? values.dir ?? ".")).storage;
    if (positionals[0] === "verify") {
      const r = await verifyLedgerFile(paths.ledger, storage);
      if (values.json) io.out(JSON.stringify(r, null, 2));
      else if (r.ok) io.out(`${c.green("✔")} ${r.reason} Chain and every delivery receipt verified.`);
      else io.err(`${c.red("✖")} LEDGER FAILED VERIFICATION — ${r.reason}`);
      return r.ok ? 0 : 2;
    }
    if (positionals[0] === "list") {
      const rows = (await readLedger(paths.ledger, storage)).slice(0, Number(values.limit ?? 20));
      if (values.json) io.out(JSON.stringify(rows.map((r) => ({ ...r, token: undefined })), null, 2));
      else if (rows.length === 0) io.out("Ledger is empty.");
      else for (const r of rows) io.out(`${r.timestampIso}  ${r.receiptId}  ${String(r.smtpStatusCode)}  ${r.templateId.padEnd(30)} ${c.dim(r.to)}`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost ledger verify|list [dir]`);
    return 1;
  } catch (e) {
    io.err(`${c.red("✖")} ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function receiptCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { eml: { type: "string" } });
  const c = styles(io);
  if (positionals[0] !== "verify" || !positionals[1]) {
    io.err(`${c.red("✖")} Usage: sealpost receipt verify <file.evw.json|evw_token> [--eml message.eml]`);
    return 1;
  }
  try {
    const spec = positionals[1].trim();
    let token = spec;
    if (!spec.startsWith("evw_")) {
      const raw = (await readFile(spec, "utf8")).trim();
      token = raw.startsWith("{") ? ((JSON.parse(raw) as { token?: string }).token ?? "") : raw;
    }
    const eml = values.eml ? (await readFile(values.eml, "utf8")).replace(/\r?\n/g, "\r\n") : undefined;
    const v = await verifyDeliveryReceipt(token, { rawMime: eml });
    if (values.json) io.out(JSON.stringify(v, null, 2));
    else if (v.ok) {
      const p = decodeDeliveryReceipt(token).payload;
      io.out(`${c.green("✔")} ${v.receiptId} is authentic: signature and canonical form verified${v.mimeMatches ? ", message bytes match" : ""}`);
      io.out(`  ${p.templateId} → ${p.to}  via ${p.smtpHost}  ${c.dim(p.smtpQueuedResponse)}`);
    } else {
      io.err(`${c.red("✖")} VERIFICATION FAILED`);
      for (const r of v.reasons) io.err(`  ${c.red("•")} ${r}`);
    }
    return v.ok ? 0 : 2;
  } catch (e) {
    return fail(io, e);
  }
}

async function queueCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {});
  const c = styles(io);
  try {
    const p = await loadProject(positionals[1] ?? values.dir ?? ".");
    if (positionals[0] === "list") {
      const items = (await readQueue(p)).map((q) => ({ ...q, raw: undefined }));
      if (values.json) io.out(JSON.stringify(items, null, 2));
      else if (items.length === 0) io.out("The retry queue is empty.");
      else for (const q of items) io.out(`${q.id}  ${q.status.padEnd(6)} attempt ${q.attempts}  next ${q.nextAttemptAtIso}  ${q.meta.templateId} → ${q.meta.to}  ${c.dim(q.lastError)}`);
      return 0;
    }
    if (positionals[0] === "run") {
      const r = await processQueue(await openRuntime(p), Date.now());
      if (values.json) io.out(JSON.stringify(r, null, 2));
      else io.out(`${c.green("✔")} delivered ${r.delivered} · requeued ${r.requeued} · failed ${r.failed} · waiting ${r.waiting}`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost queue list|run [dir]`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

async function suppressCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { reason: { type: "string" } });
  const c = styles(io);
  try {
    const p = await loadProject(values.dir ?? ".");
    let list = await readSuppressions(p);
    const [sub, email] = positionals;
    if (sub === "add" && email) {
      const reason = (values.reason ?? "unsubscribed") as SuppressionReason;
      if (!["hard_bounce", "unsubscribed", "complaint"].includes(reason)) throw new Error("--reason must be hard_bounce, unsubscribed or complaint");
      list = addSuppression(list, { email, reason, atIso: new Date().toISOString() });
      await writeSuppressions(p, list);
      io.out(`${c.green("✔")} ${email} is suppressed (${reason}). EW-107 will block every send to it.`);
      return 0;
    }
    if (sub === "remove" && email) {
      await writeSuppressions(p, removeSuppression(list, email));
      io.out(`${c.green("✔")} ${email} removed from the suppression list`);
      return 0;
    }
    if (sub === "list") {
      if (values.json) io.out(JSON.stringify(list, null, 2));
      else if (list.length === 0) io.out("No suppressed addresses.");
      else for (const s of list) io.out(`${s.atIso}  ${s.reason.padEnd(12)} ${s.email}  ${c.dim(s.detail ?? "")}`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost suppress list | add <email> [--reason r] | remove <email>`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

async function sinkCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values } = parse(argv, { port: { type: "string", short: "p" }, auth: { type: "string" } });
  const c = styles(io);
  try {
    let project: Project | null = null;
    try {
      project = await loadProject(values.dir ?? ".");
    } catch {
      project = null;
    }
    const dkim = project ? await loadOrCreateDkimKey(project.paths.dkimKey, project.storage) : null;
    const auth = values.auth ? { username: values.auth.split(":")[0], password: values.auth.slice(values.auth.indexOf(":") + 1) } : undefined;
    const sink = await startSmtpSink({
      port: values.port ? Number(values.port) : 2525,
      auth,
      resolveDkimKey: (d, s) => (project && dkim && d === project.config.domain.domain && s === project.config.domain.dkimSelector ? dkim.publicKeyJwk : undefined),
      onMessage: async (m) => {
        io.out(`${c.green("✔")} ${m.receivedAtIso}  ${m.mailFrom} → ${m.rcptTo.join(", ")}  ${c.bold(m.subject)}  ${m.dkim ? (m.dkim.ok ? c.green("DKIM pass") : c.red(`DKIM fail: ${m.dkim.reason}`)) : c.dim("no DKIM / unknown key")}`);
        if (project) await saveInboxMessage(project, m);
      },
    });
    io.out(`${c.green("✔")} Sealpost SMTP sink listening on ${c.bold(`${sink.host}:${sink.port}`)}${auth ? ` (auth ${auth.username})` : ""}  ${c.dim(project ? "captured mail also lands in the Studio inbox" : "")}`);
    io.out(c.dim("  Point any app at this host and port with no TLS. Ctrl+C to stop"));
    const stop = (): void => {
      void sink.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise<void>(() => undefined);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

async function keyCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {});
  if (positionals[0] !== "show") {
    io.err("Usage: sealpost key show [dir]");
    return 1;
  }
  const paths = projectPaths(positionals[1] ?? values.dir ?? ".");
  const storage = (await loadProject(positionals[1] ?? values.dir ?? ".")).storage;
  const receipt = await loadOrCreateReceiptKey(paths.receiptKey, storage);
  const dkim = await loadOrCreateDkimKey(paths.dkimKey, storage);
  if (values.json) io.out(JSON.stringify({ receiptKeyFingerprint: receipt.fingerprint, receiptPublicKeyJwk: receipt.publicKeyJwk, dkimPublicKeyJwk: dkim.publicKeyJwk, dkimPublicKeySpkiBase64: dkim.publicKeySpkiBase64 }, null, 2));
  else {
    io.out(`receipt key (ECDSA P-256)  ${receipt.fingerprint}`);
    io.out(`dkim key (RSA-2048)        p=${dkim.publicKeySpkiBase64}`);
  }
  return 0;
}

async function authCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { scope: { type: "string" }, expires: { type: "string" } });
  const c = styles(io);
  const [sub, arg] = positionals;
  try {
    const p = await loadProject(values.dir ?? ".");
    const keys = p.config.auth.keys;
    if (sub === "add-key" && arg) {
      const scopes = (values.scope ?? KEY_SCOPES.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
      for (const sc of scopes) if (!(KEY_SCOPES as readonly string[]).includes(sc)) throw new Error(`Unknown scope '${sc}'. Scopes: ${KEY_SCOPES.join(", ")}`);
      const days = values.expires === undefined ? undefined : Number(values.expires);
      if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error("--expires is a number of days from 1 to 3650");
      const token = `evk_${randomBytes(24).toString("base64url")}`;
      const rec: ApiKeyRecord = { label: arg, scopes: scopes as KeyScope[], createdAtIso: new Date().toISOString(), ...(days ? { expiresAtIso: new Date(Date.now() + days * 86_400_000).toISOString() } : {}) };
      await saveConfig(p, { ...p.config, auth: { keys: { ...keys, [createHash("sha256").update(token).digest("hex")]: rec } } });
      io.out(`${c.green("✔")} API key '${arg}' [${scopes.join(", ")}]${rec.expiresAtIso ? ` expires ${rec.expiresAtIso.slice(0, 10)}` : ""} (shown once, store it securely):`);
      io.out(`\n  ${c.bold(token)}\n`);
      io.out(c.dim("Send as `Authorization: Bearer …`. Only the sha256 is stored. Restart `sealpost studio` to load a key created here; keys made through the API apply immediately."));
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const rows = Object.entries(keys).map(([h, v]) => ({ id: h.slice(0, 12), ...keyRecord(v) }));
      if (values.json) io.out(JSON.stringify(rows, null, 2));
      else if (rows.length === 0) io.out("No API keys. Create one: sealpost auth add-key my-app --scope send,read");
      else for (const r of rows) io.out(`${r.id}  ${r.label.padEnd(20)} ${r.scopes.join(",").padEnd(18)} ${c.dim(r.expiresAtIso ? `expires ${r.expiresAtIso.slice(0, 10)}` : "no expiry")}`);
      return 0;
    }
    if (sub === "revoke" && arg) {
      const hash = Object.entries(keys).find(([h, v]) => h.startsWith(arg) || keyRecord(v).label === arg)?.[0];
      if (!hash) throw new Error(`No key with id or label '${arg}'`);
      const { [hash]: _gone, ...rest } = keys;
      void _gone;
      await saveConfig(p, { ...p.config, auth: { keys: rest } });
      io.out(`${c.green("✔")} Revoked ${hash.slice(0, 12)}. Restart \`sealpost studio\` for it to take effect, or revoke through the API for immediate effect.`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost auth add-key <label> [--scope send,read,write] [--expires <days>] | list | revoke <id|label>`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

async function auditCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values } = parse(argv, { limit: { type: "string" }, actor: { type: "string" } });
  const c = styles(io);
  try {
    const p = await loadProject(values.dir ?? ".");
    const rows = await readAudit(p, values.limit ? Number(values.limit) : 50, values.actor);
    if (values.json) io.out(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) io.out("No audit entries yet.");
    else for (const r of rows) io.out(`${r.atIso}  ${String(r.status).padEnd(3)} ${r.method.padEnd(6)} ${r.path.padEnd(28)} ${c.dim(`${r.actor} · ${r.ip}`)}`);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}

async function studio(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { port: { type: "string", short: "p" }, host: { type: "string" }, open: { type: "boolean" } });
  const c = styles(io);
  try {
    const running = await startServer({ dir: positionals[0] ?? values.dir ?? ".", port: values.port ? Number(values.port) : 4320, host: values.host });
    io.out(`${c.green("✔")} Sealpost Studio  ${c.bold(running.url)}`);
    io.out(`  receipt key ${running.fingerprint}   test sink 127.0.0.1:${running.sinkPort}`);
    io.out(c.dim("  Ctrl+C to stop"));
    if (values.open) {
      const { spawn } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(cmd, [running.url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
    const stop = (): void => {
      io.out("\nShutting down…");
      void running.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise<void>(() => undefined);
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}




async function logsCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { status: { type: "string" }, to: { type: "string" }, tag: { type: "string" }, template: { type: "string" }, domain: { type: "string" }, limit: { type: "string" }, before: { type: "string" } });
  const c = styles(io);
  try {
    const project = await loadProject(values.dir ?? ".");
    const all = await readEmails(project);
    if (positionals[0] === "show") {
      const rec = all.find((r) => r.id === positionals[1]);
      if (!rec) throw new Error(`No email '${positionals[1] ?? ""}'`);
      if (values.json) io.out(JSON.stringify(rec, null, 2));
      else {
        io.out(`${c.bold(rec.id)}  ${rec.status}  ${c.dim(rec.createdAtIso)}`);
        io.out(`  ${rec.from} → ${rec.to.join(", ")}  ${c.dim(`· ${rec.templateId} · ${rec.domain}`)}`);
        io.out(`  ${rec.subject}`);
        if (rec.tags.length) io.out(`  tags ${rec.tags.map((t) => `${t.name}:${t.value}`).join(" ")}`);
        for (const e of rec.events) io.out(`  ${c.dim(e.atIso)}  ${e.type.padEnd(10)} ${c.dim(e.detail ?? e.url ?? "")}`);
      }
      return 0;
    }
    const status = values.status as EmailStatus | undefined;
    if (status && !["queued", "delivered", "failed", "bounced", "complained", "deferred"].includes(status)) throw new Error("--status must be queued, delivered, failed, bounced, complained or deferred");
    const page = queryEmails(all, { status, to: values.to, tag: values.tag, templateId: values.template, domain: values.domain, limit: values.limit ? Number(values.limit) : 20, before: values.before });
    if (values.json) {
      io.out(JSON.stringify(page, null, 2));
      return 0;
    }
    if (page.data.length === 0) io.out("No emails match.");
    for (const r of page.data) io.out(`${r.id}  ${(r.status === "delivered" ? c.green : r.status === "queued" || r.status === "deferred" ? c.yellow : c.red)(r.status.padEnd(10))} ${r.createdAtIso}  ${r.to.join(", ").slice(0, 40).padEnd(40)} ${c.dim(r.subject.slice(0, 40))}${r.opens ? c.dim(`  ${r.opens} open${r.opens === 1 ? "" : "s"}`) : ""}`);
    if (page.hasMore) io.out(c.dim(`more: sealpost logs --before ${page.nextCursor}`));
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}



/* ───────────────────────── template import ───────────────────────── */

async function templateCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { format: { type: "string" }, id: { type: "string" }, name: { type: "string" }, category: { type: "string" }, force: { type: "boolean" }, "dry-run": { type: "boolean" } });
  const c = styles(io);
  const [sub, file] = positionals;
  try {
    if (sub === "list" || sub === undefined) {
      const p = await loadProject(values.dir ?? ".");
      if (values.json) io.out(JSON.stringify(p.templates.map((t) => ({ id: t.id, name: t.name, category: t.category, blocks: t.blocks.length, variables: t.variables.length })), null, 2));
      else for (const t of p.templates) io.out(`${t.id.padEnd(34)} ${t.category.padEnd(13)} ${String(t.blocks.length).padStart(3)} blocks  ${c.dim(t.name)}`);
      return 0;
    }
    if (sub === "import" && file) {
      const format = values.format as ImportFormat | undefined;
      if (format && !["mjml", "html", "react"].includes(format)) throw new Error("--format must be mjml, html or react");
      const source = await readFile(file, "utf8");
      const category = values.category as never;
      const r = importTemplate(source, { format, id: values.id, name: values.name, category: category || undefined });
      const project = await loadProject(values.dir ?? ".");
      const dest = join(project.paths.templates, `${r.template.id}.json`);
      const exists = await stat(dest).then(() => true, () => false);
      if (values.json) io.out(JSON.stringify({ format: r.format, template: r.template, warnings: r.warnings, written: false }, null, 2));
      else {
        io.out(`${c.green("✔")} Read ${file} as ${c.bold(r.format)}: ${r.template.blocks.length} blocks, ${r.template.variables.length} variables  ${c.dim(`→ ${r.template.id}`)}`);
        for (const w of r.warnings) io.out(`  ${c.yellow("▲")} ${w}`);
      }
      if (values["dry-run"]) return 0;
      if (exists && !values.force) throw new Error(`templates/${r.template.id}.json already exists. Use --force to overwrite or --id to choose another id.`);
      await mkdir(project.paths.templates, { recursive: true });
      await writeFileAtomic(dest, `${JSON.stringify(r.template, null, 2)}\n`);
      if (!values.json) io.out(`  Saved ${c.bold(`templates/${r.template.id}.json`)}. Try it:  sealpost send ${r.template.id} --to you@example.org --auto-fill`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost template import <file.mjml|.tsx|.html> [--format mjml|react|html] [--id slug] [--name "…"] [--category Auth|Billing|Incidents|Growth|Transactional] [--force] [--dry-run] | list`);
    return 1;
  } catch (e) {
    if (e instanceof ImportError) {
      io.err(`${c.red("✖")} ${e.message}`);
      for (const i of e.issues) io.err(`  ${c.red("•")} ${i}`);
      return 1;
    }
    return fail(io, e);
  }
}

/* ───────────────────────── inbound (received mail) ───────────────────────── */

async function inboundCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { from: { type: "string" }, to: { type: "string" }, q: { type: "string" }, kind: { type: "string" }, limit: { type: "string" }, before: { type: "string" }, out: { type: "string" } });
  const c = styles(io);
  const [sub, a, b] = positionals;
  try {
    if (sub === "import" && a) {
      const rt = await runtimeFor(values.dir ?? ".");
      const rec = await ingestInbound(rt, await readFile(a), { source: "import" });
      io.out(values.json ? JSON.stringify(rec, null, 2) : `${c.green("✔")} Imported ${c.bold(rec.id)}  ${rec.kind}  ${rec.from?.address ?? "?"}  ${c.dim(rec.subject)}${rec.threadEmailId ? c.dim(`  (reply to ${rec.threadEmailId})`) : ""}`);
      return 0;
    }
    const project = await loadProject(values.dir ?? ".");
    if (sub === "show" && a) {
      const rec = await readInbound(project, a);
      if (!rec) throw new Error(`No received message '${a}'`);
      if (values.json) io.out(JSON.stringify(rec, null, 2));
      else {
        io.out(`${c.bold(rec.id)}  ${rec.kind}${rec.autoReply ? " (auto-reply)" : ""}  ${c.dim(rec.receivedAtIso)}  DKIM ${rec.dkim.result}`);
        io.out(`  ${rec.from?.name ? `${rec.from.name} ` : ""}<${rec.from?.address ?? rec.envelope.from}> → ${rec.to.map((t) => t.address).join(", ") || rec.envelope.to.join(", ")}`);
        io.out(`  ${rec.subject}`);
        if (rec.threadEmailId) io.out(`  ${c.dim(`replies to ${rec.threadEmailId}`)}`);
        if (rec.bounce) io.out(`  ${c.dim(`bounce${rec.reportVerified ? " (verified, acted on)" : " (not matched to mail we sent: ignored)"}`)} ${rec.bounce.recipients.map((r) => `${r.email} ${r.status ?? ""}`).join(", ")}`);
        for (const att of rec.attachments) io.out(`  📎 ${att.index}  ${att.filename}  ${c.dim(`${att.contentType} · ${att.size} bytes`)}`);
        io.out(`\n${rec.snippet}`);
      }
      return 0;
    }
    if (sub === "raw" && a) {
      const raw = await readInboundRaw(project, a);
      if (!raw) throw new Error(`No received message '${a}'`);
      if (values.out) {
        await writeFile(values.out, raw);
        io.out(`${c.green("✔")} Wrote ${raw.length} bytes to ${values.out}`);
      } else io.out(raw.toString("utf8"));
      return 0;
    }
    if (sub === "attachment" && a && b !== undefined) {
      const raw = await readInboundRaw(project, a);
      if (!raw) throw new Error(`No received message '${a}'`);
      const att = parseMimeMessage(raw).attachments[Number(b)];
      if (!att) throw new Error(`No attachment ${b}`);
      const dest = values.out ?? att.filename;
      await writeFile(dest, att.content);
      io.out(`${c.green("✔")} Saved ${att.filename} (${att.size} bytes) to ${dest}`);
      return 0;
    }
    if (sub === "delete" && a) {
      io.out((await deleteInbound(project, a)) ? `${c.green("✔")} Deleted ${a}` : `No received message '${a}'`);
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const kind = values.kind as "message" | "bounce" | "complaint" | undefined;
      if (kind && !["message", "bounce", "complaint"].includes(kind)) throw new Error("--kind must be message, bounce or complaint");
      const page = queryInbound(await listInboundAll(project), { from: values.from, to: values.to, q: values.q, kind, limit: values.limit ? Number(values.limit) : 20, before: values.before });
      if (values.json) io.out(JSON.stringify(page, null, 2));
      else {
        if (page.data.length === 0) io.out("No received mail. Enable it with inbound.enabled, or: sealpost inbound import message.eml");
        for (const r of page.data) io.out(`${r.id}  ${r.kind.padEnd(9)} ${r.receivedAtIso}  ${(r.from?.address ?? r.envelope.from).slice(0, 30).padEnd(30)} ${c.dim(r.subject.slice(0, 40))}${r.attachments.length ? c.dim(`  📎${r.attachments.length}`) : ""}${r.threadEmailId ? c.dim("  ↩") : ""}`);
        if (page.hasMore) io.out(c.dim(`more: sealpost inbound list --before ${page.nextCursor}`));
      }
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost inbound list [--from x --to y --q text --kind message|bounce|complaint] | show <id> | raw <id> [--out f] | attachment <id> <n> [--out f] | import <file.eml> | delete <id>`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}


async function scheduledCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {});
  const c = styles(io);
  const [sub, id] = positionals;
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    if (sub === "list" || sub === undefined) {
      const all = (await readScheduled(rt.project)).slice().reverse();
      if (values.json) io.out(JSON.stringify(all, null, 2));
      else if (all.length === 0) io.out("Nothing scheduled.");
      else for (const x of all) io.out(`${x.id}  ${x.status.padEnd(9)} ${x.scheduledAtIso}  ${String(x.request.templateId).padEnd(30)} ${c.dim(Array.isArray(x.request.to) ? x.request.to.join(",") : String(x.request.to))}${x.result?.error ? c.red(`  ${x.result.error}`) : ""}`);
      return 0;
    }
    if (sub === "cancel" && id) {
      const x = await cancelScheduled(rt, id);
      io.out(`${c.green("✔")} Cancelled ${x.id}`);
      return 0;
    }
    if (sub === "run") {
      const r = await processScheduled(rt);
      io.out(`${r.sent} sent, ${r.failed} failed`);
      return r.failed > 0 ? 2 : 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost scheduled list | cancel <id> | run`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}


async function mcpCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values } = parse(argv, { "allow-send": { type: "boolean" } });
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    process.stderr.write(`sealpost mcp ready (${rt.project.templates.length} templates, sending ${values["allow-send"] ? "ENABLED" : "disabled"})\n`);
    await runMcp({ rt, input: process.stdin, output: process.stdout, allowSend: Boolean(values["allow-send"]) });
    return 0;
  } catch (e) {
    return fail(io, e);
  }
}


/* ───────────────────────── storage ───────────────────────── */

/** Every file under `dir` on disk, as paths relative to it. */
async function diskTree(dir: string, base = dir): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await diskTree(full, base)));
    else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(full.slice(base.length + 1));
  }
  return out;
}

async function storageCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { force: { type: "boolean" } });
  const c = styles(io);
  const [sub] = positionals;
  try {
    const project = await loadProject(values.dir ?? ".");
    const st = project.storage;
    if (sub === "status" || sub === undefined) {
      const files = st.kind === "disk" ? (await diskTree(project.paths.state)).length : (await st.list(project.paths.state)).length;
      const cfg = project.config.storage;
      if (values.json) io.out(JSON.stringify({ type: st.kind, shared: st.shared, ...(st.kind === "postgres" ? { schema: cfg.schema, namespace: cfg.namespace, urlEnv: cfg.urlEnv } : { dir: project.paths.state }), topLevelFiles: files }, null, 2));
      else io.out(`${c.green("✔")} ${c.bold(st.kind)}${st.kind === "postgres" ? `  schema ${cfg.schema} · namespace ${cfg.namespace} · ${cfg.urlEnv} is set · reachable` : `  ${project.paths.state}`}${st.shared ? c.dim("  (shared: safe for several Sealpost processes)") : c.dim("  (one Sealpost process at a time)")}`);
      return 0;
    }
    if (sub === "migrate") {
      if (project.storage.kind === "disk") throw new Error('Set "storage": { "type": "postgres" } in sealpost.config.json (and export the connection string named by storage.urlEnv) before migrating.');
      const target = project.storage;
      const existing = (await target.list(project.paths.state)).length + ((await target.exists(project.paths.ledger)) ? 1 : 0);
      if (existing > 0 && !values.force) throw new Error("The database already holds Sealpost state for this namespace. Use --force to overwrite it.");
      const rels = await diskTree(project.paths.state);
      if (existing > 0) await target.removeTree(project.paths.state); // --force: replace, never merge into, what is there
      if (rels.length === 0) throw new Error(`Nothing to migrate: ${project.paths.state} is empty.`);
      let copied = 0;
      for (const rel of rels) {
        const path = join(project.paths.state, rel);
        if (rel.endsWith(".jsonl")) {
          const text = await diskStorage.readText(path);
          if (text !== "") await target.appendText(path, text);
        } else await target.writeBytes(path, await diskStorage.readBytes(path));
        copied++;
      }
      io.out(`${c.green("✔")} Copied ${copied} file${copied === 1 ? "" : "s"} (keys, ledger, logs, queues, received mail) into ${project.config.storage.schema}/${project.config.storage.namespace}.`);
      io.out(c.dim(`  The .sealpost/ folder is untouched. Verify with: sealpost ledger verify   Then keep it as a backup or remove it.`));
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost storage status | migrate [--force]`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── doctor / auth-check ───────────────────────── */

async function doctorCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values } = parse(argv, { send: { type: "string" } });
  const c = styles(io);
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const checks = await runDoctor(rt, { resolveTxt: (n) => resolveTxt(n), probe: defaultProbe, env: process.env });
    const failed = checks.filter((k) => k.status === "fail").length;
    const warned = checks.filter((k) => k.status === "warn").length;
    let sent: { receiptId?: string; messageId?: string; status: string; error?: string } | undefined;
    if (values.send && failed === 0) {
      const template = rt.project.templates.find((t) => t.id === "magic_link_otp_verification") ?? rt.project.templates[0];
      const out = await sendEmail(rt, { templateId: template.id, to: values.send, variables: {}, autoFill: true });
      sent = { status: out.status, receiptId: out.receipt?.receiptId, messageId: out.messageId, error: out.error ?? (out.status === "blocked" ? out.preflight.checks.find((k) => k.severity === "block")?.message : undefined) };
    }
    if (values.json) {
      io.out(JSON.stringify({ ok: failed === 0, failed, warnings: warned, checks, sent }, null, 2));
      return failed === 0 ? 0 : 2;
    }
    for (const k of checks) {
      io.out(`${k.status === "pass" ? c.green("✔") : k.status === "warn" ? c.yellow("▲") : c.red("✖")} ${k.title}  ${c.dim(k.detail)}`);
      if (k.fix) io.out(`    ${c.dim("→")} ${k.fix}`);
    }
    io.out(`\n${failed === 0 ? c.green(`Ready: ${warned} warning${warned === 1 ? "" : "s"}.`) : c.red(`${failed} blocking problem${failed === 1 ? "" : "s"}, ${warned} warning${warned === 1 ? "" : "s"}.`)}`);
    if (values.send && failed > 0) io.out(c.dim(`Not sending to ${values.send} until the blocking problems are fixed.`));
    if (sent) {
      if (sent.status === "delivered" || sent.status === "queued") io.out(`${c.green("✔")} ${sent.status === "delivered" ? "Handed to the relay" : "Queued for retry"}: ${sent.messageId}${sent.receiptId ? `  receipt ${sent.receiptId}` : ""}\n  Open it in ${values.send}'s inbox, then: Gmail ⋮ → Show original → Download original, and run:  sealpost auth-check original.eml`);
      else io.err(`${c.red("✖")} Test send ${sent.status}: ${sent.error ?? ""}`);
      if (sent.status !== "delivered" && sent.status !== "queued") return 2;
    }
    return failed === 0 ? 0 : 2;
  } catch (e) {
    return fail(io, e);
  }
}

async function authCheckCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, {});
  const c = styles(io);
  const file = positionals[0];
  if (!file) {
    io.err(`${c.red("✖")} Usage: sealpost auth-check <message.eml>   (the original message downloaded from the receiving inbox)`);
    return 1;
  }
  try {
    const report = analyzeAuthenticationResults(await readFile(file, "utf8"));
    if (values.json) {
      io.out(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 2;
    }
    io.out(`${c.bold(report.ok ? "Fully authenticated" : "Not fully authenticated")}  ${c.dim(`From ${report.fromDomain ?? "?"} · signed by ${report.signedDomains.join(", ") || "nobody"}`)}`);
    for (const r of report.results) io.out(`  ${r.verdict === "pass" ? c.green("✔") : c.red("✖")} ${r.method.toUpperCase().padEnd(5)} ${r.verdict.padEnd(9)} ${c.dim(`${r.receiver} ${r.detail}`.slice(0, 100))}`);
    for (const p of report.problems) io.out(`  ${c.yellow("▲")} ${p}`);
    return report.ok ? 0 : 2;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── domains ───────────────────────── */

async function domainCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { from: { type: "string" }, name: { type: "string" }, selector: { type: "string" }, "spf-include": { type: "string" }, dmarc: { type: "string" } });
  const c = styles(io);
  const [sub, name] = positionals;
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const cfg = rt.project.config;
    if (sub === "list" || sub === undefined) {
      if (values.json) io.out(JSON.stringify(allDomains(cfg), null, 2));
      else for (const d of allDomains(cfg)) io.out(`${d.domain === cfg.domain.domain ? c.bold("●") : " "} ${d.domain.padEnd(32)} ${d.fromEmail.padEnd(32)} ${c.dim(`selector ${d.dkimSelector} · dmarc ${d.dmarcPolicy}`)}`);
      return 0;
    }
    if (sub === "add" && name) {
      const next = ConfigSchema.safeParse({ ...cfg, domains: [...cfg.domains, { domain: name.toLowerCase(), fromName: values.name ?? cfg.domain.fromName, fromEmail: values.from ?? `hello@${name.toLowerCase()}`, dkimSelector: values.selector ?? cfg.domain.dkimSelector, spfInclude: values["spf-include"] ?? cfg.domain.spfInclude, dmarcPolicy: values.dmarc ?? "none" }] });
      if (!next.success) throw new ProjectError("Invalid domain", next.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`));
      if (allDomains(cfg).some((d) => d.domain.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already configured`);
      await saveConfig(rt.project, next.data);
      const p2 = await loadProject(rt.project.dir);
      const rt2 = await openRuntime(p2);
      const profile = domainFor(rt2, name);
      io.out(`${c.green("✔")} Added ${profile.domain}. A DKIM key was generated in .sealpost/ (mode 0600).`);
      io.out(`  Publish its records with: sealpost dns --domain ${profile.domain}   then verify: sealpost domain check ${profile.domain}`);
      return 0;
    }
    if (sub === "remove" && name) {
      if (name.toLowerCase() === cfg.domain.domain.toLowerCase()) throw new Error("The primary domain cannot be removed; change it in the config instead");
      if (!cfg.domains.some((d) => d.domain.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is not configured`);
      await saveConfig(rt.project, { ...cfg, domains: cfg.domains.filter((d) => d.domain.toLowerCase() !== name.toLowerCase()) });
      io.out(`${c.green("✔")} Removed ${name}. Its key file stays in .sealpost/ in case you re-add it.`);
      return 0;
    }
    if (sub === "check") {
      const targets = name ? [domainFor(rt, name)] : allDomains(cfg);
      let allOk = true;
      for (const profile of targets) {
        const results = await checkDnsRecords(await dnsRecordsFor(rt, profile), (n) => resolveTxt(n), dnsCheckOptions(rt, profile));
        const ok = results.every((r) => r.status === "ok" || r.status === "skipped");
        allOk &&= ok;
        if (values.json) {
          io.out(JSON.stringify({ domain: profile.domain, ok, results }, null, 2));
          continue;
        }
        io.out(`${c.bold(profile.domain)}  ${ok ? c.green("DNS ready") : c.red("DNS not ready")}`);
        for (const r of results) io.out(`  ${r.status === "ok" ? c.green("✔") : r.status === "skipped" ? c.dim("–") : c.red("✖")} ${r.purpose.padEnd(5)} ${r.fqdn}  ${c.dim(r.detail)}`);
      }
      return allOk ? 0 : 2;
    }
    io.err(`${c.red("✖")} Usage: sealpost domain list | add <domain> --from hello@domain [--name n] [--selector s] [--spf-include host] [--dmarc p] | remove <domain> | check [domain]`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── audiences / broadcasts ───────────────────────── */

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

async function audienceCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { name: { type: "string" }, var: { type: "string", multiple: true } });
  const c = styles(io);
  const [sub, a, b] = positionals;
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    if (sub === "create" && a) {
      const aud = await createAudience(rt, a);
      io.out(values.json ? JSON.stringify(aud, null, 2) : `${c.green("✔")} Created audience ${c.bold(aud.id)} (${aud.name})`);
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const all = await readAudiences(rt.project);
      if (values.json) io.out(JSON.stringify(all.map((x) => ({ id: x.id, name: x.name, contacts: x.contacts.length })), null, 2));
      else if (all.length === 0) io.out("No audiences yet. Create one with: sealpost audience create \"Customers\"");
      else for (const x of all) io.out(`${x.id}  ${String(x.contacts.length).padStart(6)} contacts  ${x.name}`);
      return 0;
    }
    if (sub === "show" && a) {
      const x = (await readAudiences(rt.project)).find((y) => y.id === a);
      if (!x) throw new Error(`No audience '${a}'`);
      if (values.json) io.out(JSON.stringify(x, null, 2));
      else {
        io.out(`${c.bold(x.name)}  ${x.id}  ${x.contacts.length} contacts`);
        for (const k of x.contacts.slice(0, 50)) io.out(`  ${k.email}${k.name ? `  ${c.dim(k.name)}` : ""}`);
        if (x.contacts.length > 50) io.out(c.dim(`  … and ${x.contacts.length - 50} more (use --json)`));
      }
      return 0;
    }
    if (sub === "add" && a && b) {
      const variables: Record<string, string> = {};
      for (const kv of values.var ?? []) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`--var expects key=value, got '${kv}'`);
        variables[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const r = await addContacts(rt, a, [{ email: b, name: values.name, variables: Object.keys(variables).length ? variables : undefined }]);
      if (r.rejected.length) throw new Error(`${r.rejected[0].email}: ${r.rejected[0].reason}`);
      io.out(`${c.green("✔")} ${r.added ? "Added" : "Updated"} ${b}  (${r.audience.contacts.length} contacts)`);
      return 0;
    }
    if (sub === "import" && a && b) {
      const rows = parseCsv(await readFile(b, "utf8"));
      if (rows.length < 2) throw new Error("The CSV needs a header row and at least one contact");
      const header = rows[0].map((h) => h.trim());
      const emailCol = header.findIndex((h) => h.toLowerCase() === "email");
      if (emailCol < 0) throw new Error("The CSV header must contain an 'email' column");
      const nameCol = header.findIndex((h) => h.toLowerCase() === "name");
      const contacts = rows.slice(1).map((r) => {
        const variables: Record<string, string> = {};
        header.forEach((h, i) => {
          if (i !== emailCol && i !== nameCol && h !== "" && (r[i] ?? "").trim() !== "") variables[h] = r[i].trim();
        });
        return { email: (r[emailCol] ?? "").trim(), name: nameCol >= 0 && (r[nameCol] ?? "").trim() !== "" ? r[nameCol].trim() : undefined, variables: Object.keys(variables).length ? variables : undefined };
      });
      const r = await addContacts(rt, a, contacts);
      if (values.json) io.out(JSON.stringify({ added: r.added, updated: r.updated, rejected: r.rejected, total: r.audience.contacts.length }, null, 2));
      else {
        io.out(`${c.green("✔")} Imported ${r.added} new, ${r.updated} updated  (${r.audience.contacts.length} contacts)`);
        for (const x of r.rejected.slice(0, 10)) io.out(`  ${c.yellow("▲")} ${x.email}: ${x.reason}`);
        if (r.rejected.length > 10) io.out(c.dim(`  … and ${r.rejected.length - 10} more rejected`));
      }
      return 0;
    }
    if (sub === "remove" && a && b) {
      const x = await removeContact(rt, a, b);
      io.out(`${c.green("✔")} Removed ${b}  (${x.contacts.length} contacts)`);
      return 0;
    }
    if (sub === "delete" && a) {
      await deleteAudience(rt, a);
      io.out(`${c.green("✔")} Deleted ${a}`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost audience create <name> | list | show <id> | add <id> <email> [--name n] [--var k=v] | import <id> <file.csv> | remove <id> <email> | delete <id>`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

async function broadcastCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { audience: { type: "string" }, template: { type: "string" }, at: { type: "string" }, domain: { type: "string" }, rate: { type: "string" }, var: { type: "string", multiple: true } });
  const c = styles(io);
  const [sub, a] = positionals;
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const line = (b: Awaited<ReturnType<typeof readBroadcasts>>[number]): string => `${b.id}  ${b.status.padEnd(9)} ${b.scheduledAtIso}  ${String(b.counts.delivered + b.counts.queued).padStart(5)}/${b.counts.total} sent  ${b.name}`;
    if (sub === "create" && a) {
      if (!values.audience || !values.template) throw new Error("--audience <id> and --template <id> are required");
      const variables: Record<string, string> = {};
      for (const kv of values.var ?? []) {
        const i = kv.indexOf("=");
        if (i < 1) throw new Error(`--var expects key=value, got '${kv}'`);
        variables[kv.slice(0, i)] = kv.slice(i + 1);
      }
      if (values.domain) domainFor(rt, values.domain);
      const b = await createBroadcast(rt, { name: a, audienceId: values.audience, templateId: values.template, domain: values.domain, variables, scheduledAtIso: values.at, ratePerMinute: values.rate ? Number(values.rate) : undefined });
      io.out(values.json ? JSON.stringify(b, null, 2) : `${c.green("✔")} Scheduled ${c.bold(b.id)} for ${b.scheduledAtIso} to ${b.counts.total} contacts at ${b.ratePerMinute}/min.\n  The scheduler runs inside \`sealpost studio\`; or run due broadcasts now with: sealpost broadcast run`);
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const all = await readBroadcasts(rt.project);
      if (values.json) io.out(JSON.stringify(all.map(publicBroadcast), null, 2));
      else if (all.length === 0) io.out("No broadcasts yet.");
      else for (const b of all) io.out(line(b));
      return 0;
    }
    if (sub === "show" && a) {
      const b = (await readBroadcasts(rt.project)).find((x) => x.id === a);
      if (!b) throw new Error(`No broadcast '${a}'`);
      io.out(values.json ? JSON.stringify(publicBroadcast(b), null, 2) : `${line(b)}\n  ${Object.entries(b.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      return 0;
    }
    if (sub === "cancel" && a) {
      const b = await cancelBroadcast(rt, a);
      io.out(`${c.green("✔")} Cancelled ${b.id} after ${b.cursor}/${b.counts.total} contacts`);
      return 0;
    }
    if (sub === "run") {
      for (;;) {
        await processBroadcasts(rt);
        await processOutbox(rt);
        const active = (await readBroadcasts(rt.project)).filter((b) => (b.status === "sending" || (b.status === "scheduled" && Date.parse(b.scheduledAtIso) <= Date.now())) && (!a || b.id === a));
        if (active.length === 0) break;
        for (const b of active) if (!values.json) io.out(c.dim(line(b)));
        await new Promise((r) => setTimeout(r, 1000));
      }
      const done = (await readBroadcasts(rt.project)).filter((b) => !a || b.id === a);
      if (values.json) io.out(JSON.stringify(done.map(publicBroadcast), null, 2));
      else for (const b of done) io.out(line(b));
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost broadcast create <name> --audience <id> --template <id> [--at ISO] [--rate n] [--domain d] [--var k=v] | list | show <id> | cancel <id> | run [id]`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

/* ───────────────────────── outbound webhooks ───────────────────────── */

async function webhookCmd(argv: string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parse(argv, { url: { type: "string" }, "secret-env": { type: "string" }, events: { type: "string" } });
  const c = styles(io);
  const [sub, id] = positionals;
  try {
    const rt = await runtimeFor(values.dir ?? ".");
    const cfg = rt.project.config;
    if (sub === "list" || sub === undefined) {
      if (values.json) io.out(JSON.stringify(cfg.webhooks.map((w) => ({ ...w, secretEnvSet: process.env[w.secretEnv] !== undefined })), null, 2));
      else if (cfg.webhooks.length === 0) io.out(`No webhook endpoints. Add one: sealpost webhook add app --url https://app.example.com/hooks/sealpost --secret-env SEALPOST_WHSEC\nEvents: ${WEBHOOK_EVENTS.join(", ")}`);
      else for (const w of cfg.webhooks) io.out(`${w.id.padEnd(14)} ${w.url}  ${c.dim(w.events.join(","))}  ${process.env[w.secretEnv] !== undefined ? c.green("secret set") : c.yellow(`${w.secretEnv} not set`)}`);
      return 0;
    }
    if (sub === "add" && id) {
      if (!values.url || !values["secret-env"]) throw new Error("--url and --secret-env are required");
      const next = ConfigSchema.safeParse({ ...cfg, webhooks: [...cfg.webhooks.filter((w) => w.id !== id), { id, url: values.url, events: values.events ? values.events.split(",").map((e) => e.trim()) : ["*"], secretEnv: values["secret-env"] }] });
      if (!next.success) throw new ProjectError("Invalid webhook", next.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`));
      await saveConfig(rt.project, next.data);
      io.out(`${c.green("✔")} Webhook '${id}' saved. Export the signing secret before starting the server:  export ${values["secret-env"]}="$(openssl rand -hex 32)"`);
      return 0;
    }
    if (sub === "remove" && id) {
      await saveConfig(rt.project, { ...cfg, webhooks: cfg.webhooks.filter((w) => w.id !== id) });
      io.out(`${c.green("✔")} Removed '${id}'`);
      return 0;
    }
    if (sub === "test" && id) {
      if (!cfg.webhooks.some((w) => w.id === id)) throw new Error(`No webhook '${id}'`);
      const ev = await emitEvent(rt, "webhook.ping", { message: "Hello from Sealpost" }, id);
      const r = await processOutbox(rt);
      const item = (await readOutbox(rt.project)).find((i) => i.eventId === ev?.id);
      io.out(`${item?.status === "delivered" ? c.green("✔ delivered") : c.red(`✖ ${item?.status ?? "not queued"}`)}  ${item?.lastNote ?? ""}  ${c.dim(`(${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} failed)`)}`);
      return item?.status === "delivered" ? 0 : 2;
    }
    if (sub === "log") {
      const box = (await readOutbox(rt.project)).slice(-30).reverse();
      if (values.json) io.out(JSON.stringify(box.map(publicDelivery), null, 2));
      else if (box.length === 0) io.out("No webhook deliveries yet.");
      else for (const i of box) io.out(`${i.createdAtIso}  ${i.status.padEnd(9)} ${i.type.padEnd(18)} ${i.endpointId.padEnd(12)} attempts ${i.attempts}  ${c.dim(i.lastNote ?? "")}`);
      return 0;
    }
    if (sub === "run") {
      const r = await processOutbox(rt);
      io.out(`${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} failed`);
      return 0;
    }
    io.err(`${c.red("✖")} Usage: sealpost webhook list | add <id> --url <https url> --secret-env <ENV> [--events a,b] | remove <id> | test <id> | log | run`);
    return 1;
  } catch (e) {
    return fail(io, e);
  }
}

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    io.out(HELP);
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    io.out(VERSION);
    return 0;
  }
  try {
    switch (cmd) {
      case "init":
        return await init(rest, io);
      case "validate":
        return await validate(rest, io);
      case "dns":
        return await dnsCmd(rest, io);
      case "compile":
        return await compileCmd(rest, io);
      case "send":
        return await sendCmd(rest, io);
      case "studio":
      case "serve":
        return await studio(rest, io);
      case "ledger":
        return await ledgerCmd(rest, io);
      case "receipt":
        return await receiptCmd(rest, io);
      case "queue":
        return await queueCmd(rest, io);
      case "suppress":
        return await suppressCmd(rest, io);
      case "storage":
        return await storageCmd(rest, io);
      case "mcp":
        return await mcpCmd(rest, io);
      case "scheduled":
        return await scheduledCmd(rest, io);
      case "template":
        return await templateCmd(rest, io);
      case "inbound":
        return await inboundCmd(rest, io);
      case "logs":
        return await logsCmd(rest, io);
      case "doctor":
        return await doctorCmd(rest, io);
      case "auth-check":
        return await authCheckCmd(rest, io);
      case "domain":
        return await domainCmd(rest, io);
      case "audience":
        return await audienceCmd(rest, io);
      case "broadcast":
        return await broadcastCmd(rest, io);
      case "webhook":
        return await webhookCmd(rest, io);
      case "sink":
        return await sinkCmd(rest, io);
      case "key":
        return await keyCmd(rest, io);
      case "auth":
        return await authCmd(rest, io);
      case "audit":
        return await auditCmd(rest, io);
      default:
        io.err(`Unknown command '${cmd}'.\n\n${HELP}`);
        return 1;
    }
  } catch (e) {
    return fail(io, e);
  }
}

