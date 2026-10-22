import { canonicalize, type JsonValue } from "../crypto/canonical";
import { sha256Hex } from "../crypto/keys";
import type { DomainProfile, EmailTemplate, VariableValues } from "../schemas/template";
import { compileEmailTemplate, normalizeUrl, resolveVariables, unresolvedTokens, type CompileOptions, type CompiledEmail } from "./compiler";
import { isSuppressed, normalizeEmail, type SuppressionEntry } from "./suppression";

export type PreflightCode = "EW-101" | "EW-102" | "EW-103" | "EW-104" | "EW-105" | "EW-106" | "EW-107" | "EW-108";
export type PreflightGate = "CLEAR" | "WARN" | "BLOCKED";

export interface PreflightCheck {
  code: PreflightCode;
  severity: "ok" | "warn" | "block";
  message: string;
}

export interface DispatchRequest {
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  variables: VariableValues;
}

export interface PreflightContext {
  template: EmailTemplate;
  domain: DomainProfile;
  suppressions?: readonly SuppressionEntry[];
  /** Idempotency keys already dispatched inside the dedupe window. */
  recentKeys?: ReadonlySet<string>;
  compile?: CompileOptions;
}

export interface PreflightResult {
  gate: PreflightGate;
  /** 0–100 deliverability score: 100 minus 30 per blocker and 8 per warning. */
  score: number;
  checks: PreflightCheck[];
  idempotencyKey: string;
  compiled: CompiledEmail;
  /** Variables that fell back to their declared default. */
  defaultsUsed: string[];
  recipients: { to: string[]; cc: string[]; bcc: string[]; fromName: string; fromEmail: string };
}

 
const CONTROL = /[\r\n\0\u0085\u2028\u2029]/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const DANGEROUS = /^(javascript|data|vbscript|file):/i;

export const isValidEmail = (e: string): boolean => e.length <= 254 && EMAIL.test(e) && !e.includes("..") && !e.startsWith(".") && !e.split("@")[0].endsWith(".");

const SPAM_PHRASES = ["free money", "act now", "click here", "100% free", "you are a winner", "winner!", "limited time offer", "buy now", "cash bonus", "no obligation", "risk free", "guaranteed income"];

/**
 * Runs the eight deliverability and security checks on a dispatch. Pure apart from hashing.
 * EW-101 variables · EW-102 header injection · EW-103 alignment · EW-104 links · EW-105 preheader/length ·
 * EW-106 spam heuristics · EW-107 suppression · EW-108 idempotency.
 */
export async function evaluateDispatchPreflight(req: DispatchRequest, ctx: PreflightContext): Promise<PreflightResult> {
  const { template, domain } = ctx;
  const to = (Array.isArray(req.to) ? req.to : [req.to]).map((s) => s.trim());
  const cc = (req.cc ?? []).map((s) => s.trim());
  const bcc = (req.bcc ?? []).map((s) => s.trim());
  const fromName = req.fromName ?? domain.fromName;
  const fromEmail = (req.fromEmail ?? domain.fromEmail).trim();
  const resolved = resolveVariables(template, req.variables);
  const effective: VariableValues = Object.fromEntries(Object.entries(resolved.values).map(([k, v]) => [k, v.raw]));
  const compiled = compileEmailTemplate(template, req.variables, { domain, ...ctx.compile });
  const checks: PreflightCheck[] = [];
  const push = (code: PreflightCode, severity: PreflightCheck["severity"], message: string): void => {
    checks.push({ code, severity, message });
  };

  // EW-101
  const declared = new Set(template.variables.map((v) => v.key));
  const leftovers = [...new Set([...unresolvedTokens(compiled.subject), ...unresolvedTokens(compiled.html), ...unresolvedTokens(compiled.text)])];
  const undeclared = leftovers.filter((k) => !declared.has(k));
  const unfilled = leftovers.filter((k) => declared.has(k));
  const problems = resolved.problems.map((p) => p.message);
  if (undeclared.length) problems.push(`Undeclared variable(s) referenced: ${undeclared.map((k) => `{{${k}}}`).join(", ")}.`);
  if (unfilled.length && !resolved.problems.length) problems.push(`Unreplaced token(s) remain: ${unfilled.map((k) => `{{${k}}}`).join(", ")}.`);
  push("EW-101", problems.length ? "block" : "ok", problems.length ? problems.join(" ") : resolved.defaultsUsed.length ? `All variables resolved (${resolved.defaultsUsed.length} from defaults: ${resolved.defaultsUsed.join(", ")}).` : "All variables resolved and typed correctly.");

  // EW-102
  const bad: string[] = [];
  const guard = (label: string, value: string, email: boolean): void => {
    if (CONTROL.test(value)) bad.push(`${label} contains a line break or control character`);
    else if (email && !isValidEmail(value)) bad.push(`${label} “${value.slice(0, 40)}” is not a valid address`);
  };
  to.forEach((a) => guard("to", a, true));
  cc.forEach((a) => guard("cc", a, true));
  bcc.forEach((a) => guard("bcc", a, true));
  guard("fromEmail", fromEmail, true);
  guard("fromName", fromName, false);
  if (req.replyTo) guard("replyTo", req.replyTo, true);
  guard("subject", compiled.subject, false);
  if (to.length === 0) bad.push("no recipient");
  push("EW-102", bad.length ? "block" : "ok", bad.length ? `Header guard: ${bad.join("; ")}.` : "No CR/LF/NUL injection and every address is well-formed.");

  // EW-103
  const fromDomain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  const root = domain.domain.toLowerCase();
  const aligned = fromDomain === root || fromDomain.endsWith(`.${root}`);
  push("EW-103", aligned ? "ok" : "block", aligned ? `From domain ${fromDomain} aligns with ${root}.` : `From domain “${fromDomain}” is not ${root} or a subdomain of it: DMARC alignment would fail.`);

  // EW-104
  const badLinks = compiled.urls.filter((u) => DANGEROUS.test(normalizeUrl(u.url)) || /\{\{/.test(u.url) || !u.safe);
  for (const v of template.variables) {
    const raw = effective[v.key];
    if (v.type === "url" && typeof raw === "string" && (DANGEROUS.test(normalizeUrl(raw)) || /\{\{/.test(raw))) badLinks.push({ blockId: `variable:${v.key}`, url: raw, safe: false });
  }
  push("EW-104", badLinks.length ? "block" : "ok", badLinks.length ? `Unsafe or unresolved link(s): ${badLinks.map((l) => `${l.blockId} → ${l.url.slice(0, 60)}`).join("; ")}.` : "Every link is http(s) or mailto and fully resolved.");

  // EW-105
  const w105: string[] = [];
  if (compiled.subject.length > 78) w105.push(`subject is ${compiled.subject.length} characters (over 78)`);
  if (compiled.preheader.trim() === "") w105.push("the preheader is empty");
  push("EW-105", w105.length ? "warn" : "ok", w105.length ? `Deliverability: ${w105.join(" and ")}.` : "Subject length and preheader are healthy.");

  // EW-106
  const w106: string[] = [];
  const letters = compiled.subject.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters === letters.toUpperCase()) w106.push("the subject is ALL CAPS");
  const lower = `${compiled.subject} ${compiled.text}`.toLowerCase();
  const hits = SPAM_PHRASES.filter((p) => lower.includes(p));
  if (hits.length) w106.push(`spam-trigger phrase(s): ${hits.join(", ")}`);
  if ((compiled.subject.match(/!/g) ?? []).length > 1) w106.push("multiple exclamation marks in the subject");
  const ratio = compiled.html.length === 0 ? 0 : compiled.text.length / compiled.html.length;
  if (ratio < 0.04) w106.push(`the text-to-HTML ratio is ${(ratio * 100).toFixed(1)}% (under 4%)`);
  push("EW-106", w106.length ? "warn" : "ok", w106.length ? `Spam heuristics: ${w106.join("; ")}.` : "No spam-trigger patterns found.");

  // EW-107
  const hits107 = [...to, ...cc, ...bcc].map((r) => ({ r, s: isSuppressed(ctx.suppressions ?? [], r) })).filter((x) => x.s);
  push("EW-107", hits107.length ? "block" : "ok", hits107.length ? `Suppressed recipient(s): ${hits107.map((x) => `${x.r} (${x.s?.reason})`).join(", ")}. No socket will be opened.` : "No recipient is on the suppression list.");

  // EW-108
  const idempotencyKey = await sha256Hex(canonicalize({ templateId: template.id, to: to.map(normalizeEmail).sort(), variables: effective } as unknown as JsonValue));
  const dup = ctx.recentKeys?.has(idempotencyKey) ?? false;
  push("EW-108", dup ? "block" : "ok", dup ? `This exact send (template, recipient, variables) was already dispatched: key ${idempotencyKey.slice(0, 12)}…` : `Idempotency key ${idempotencyKey.slice(0, 12)}… is new.`);

  const blocks = checks.filter((c) => c.severity === "block").length;
  const warns = checks.filter((c) => c.severity === "warn").length;
  return { gate: blocks ? "BLOCKED" : warns ? "WARN" : "CLEAR", score: Math.max(0, 100 - blocks * 30 - warns * 8), checks, idempotencyKey, compiled, defaultsUsed: resolved.defaultsUsed, recipients: { to, cc, bcc, fromName, fromEmail } };
}
