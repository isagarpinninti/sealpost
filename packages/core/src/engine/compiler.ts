import type { DomainProfile, EmailBlock, EmailTemplate, TemplateVariable, VariableType, VariableValue, VariableValues } from "../schemas/template";

/* ───────────────────────── variables ───────────────────────── */

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export interface ResolvedVariable {
  raw: VariableValue;
  /** The human-facing string: currency is `$1,250.00`, booleans are Yes / No. */
  display: string;
  fromDefault: boolean;
}

export interface VariableProblem {
  key: string;
  reason: "missing" | "wrong_type";
  message: string;
}

export interface ResolvedVariables {
  values: Record<string, ResolvedVariable>;
  problems: VariableProblem[];
  defaultsUsed: string[];
}

export function formatNumberWithCommas(n: number): string {
  const [int, frac] = String(Math.abs(n)).split(".");
  return `${n < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

export function formatCurrency(n: number): string {
  const [int, frac] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

const asNumber = (v: VariableValue): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Checks one value against its declared type and returns its display form, or the reason it is wrong. */
export function coerceVariable(type: VariableType, value: VariableValue): { ok: true; display: string; raw: VariableValue } | { ok: false; message: string } {
  switch (type) {
    case "number": {
      const n = asNumber(value);
      return n === null ? { ok: false, message: "expected a number" } : { ok: true, display: formatNumberWithCommas(n), raw: n };
    }
    case "currency": {
      const n = asNumber(value);
      return n === null ? { ok: false, message: "expected an amount" } : { ok: true, display: formatCurrency(n), raw: n };
    }
    case "boolean":
      return typeof value === "boolean" ? { ok: true, display: value ? "Yes" : "No", raw: value } : { ok: false, message: "expected true or false" };
    case "url":
      return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value) ? { ok: true, display: value, raw: value } : { ok: false, message: "expected an http(s) URL" };
    case "otp_code":
      return typeof value === "string" && /^[A-Za-z0-9]{4,10}$/.test(value) ? { ok: true, display: value, raw: value } : typeof value === "number" && /^\d{4,10}$/.test(String(value)) ? { ok: true, display: String(value), raw: String(value) } : { ok: false, message: "expected 4–10 letters or digits" };
    default:
      return typeof value === "string" ? { ok: true, display: value, raw: value } : typeof value === "number" || typeof value === "boolean" ? { ok: true, display: String(value), raw: value } : { ok: false, message: "expected text" };
  }
}

/** Resolves caller variables against the template's declarations, falling back to declared defaults. */
export function resolveVariables(template: Pick<EmailTemplate, "variables">, provided: Readonly<VariableValues>): ResolvedVariables {
  const values: Record<string, ResolvedVariable> = {};
  const problems: VariableProblem[] = [];
  const defaultsUsed: string[] = [];
  for (const v of template.variables) {
    const given = provided[v.key];
    const useDefault = (given === undefined || given === "") && v.defaultValue !== undefined;
    const value = useDefault ? v.defaultValue : given;
    if (value === undefined || value === "") {
      if (v.required) problems.push({ key: v.key, reason: "missing", message: `Required variable “${v.key}” is missing.` });
      continue;
    }
    const c = coerceVariable(v.type, value as VariableValue);
    if (!c.ok) {
      problems.push({ key: v.key, reason: "wrong_type", message: `Variable “${v.key}” (${v.type}): ${c.message}.` });
      continue;
    }
    values[v.key] = { raw: c.raw, display: c.display, fromDefault: useDefault };
    if (useDefault) defaultsUsed.push(v.key);
  }
  return { values, problems, defaultsUsed };
}

/** Fills every missing variable from `defaultValue ?? sampleValue` (the Studio's one-click auto-heal). */
export function autoFillSampleVariables(template: Pick<EmailTemplate, "variables">, provided: Readonly<VariableValues>): VariableValues {
  const out: VariableValues = { ...provided };
  for (const v of template.variables) if (out[v.key] === undefined || out[v.key] === "") out[v.key] = v.defaultValue ?? v.sampleValue;
  return out;
}

/* ───────────────────────── rendering ───────────────────────── */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function interpolate(text: string, vars: Record<string, ResolvedVariable>, mode: "html" | "text"): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    const lit = text.slice(last, at);
    out += mode === "html" ? escapeHtml(lit) : lit;
    const v = vars[m[1]];
    // A missing token stays visible so the pre-flight gate (EW-101) can see it; it is never silently dropped.
    out += v ? (mode === "html" ? escapeHtml(v.display) : v.display) : m[0];
    last = at + m[0].length;
  }
  const tail = text.slice(last);
  return out + (mode === "html" ? escapeHtml(tail) : tail);
}

const plain = (text: string, vars: Record<string, ResolvedVariable>): string => interpolate(text, vars, "text");

const truthy = (v: ResolvedVariable | undefined): boolean => v !== undefined && v.raw !== false && v.raw !== "";

const SAFE_URL = /^(https?:|mailto:)/i;

/** Strips control characters and whitespace the way browsers do before reading a scheme. */
export function normalizeUrl(url: string): string {
   
  return url.replace(/[\u0000- \u007f-\u009f]+/g, "");
}

export const isSafeUrl = (url: string): boolean => SAFE_URL.test(normalizeUrl(url)) && !/\{\{/.test(url);

export interface ResolvedUrl {
  blockId: string;
  url: string;
  safe: boolean;
  /** An image source: checked like a link, but never click-tracked. */
  image?: boolean;
}

export interface CompileOptions {
  /** Adds the unsubscribe link to footers. */
  domain?: Pick<DomainProfile, "unsubscribeUrl">;
  /** Adds an open pixel and wraps http(s) links: `<base>/o/<id>.gif`, `<base>/c/<id>?u=<url>`. */
  tracking?: { baseUrl: string; messageId: string };
}

export interface CompiledEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** Every link in the email as written, before tracking wrappers. */
  urls: ResolvedUrl[];
  /** Resolved http(s) links (safe ones only), for the tracking registry. */
  links: string[];
  /** Blocks hidden by `showIfVariable`. */
  hiddenBlocks: string[];
}

const TONES = {
  info: { bg: "#eff6ff", border: "#3b82f6", fg: "#1e3a8a" },
  warn: { bg: "#fffbeb", border: "#f59e0b", fg: "#78350f" },
  emerald: { bg: "#ecfdf5", border: "#10b981", fg: "#064e3b" },
  rose: { bg: "#fff1f2", border: "#f43f5e", fg: "#881337" },
} as const;

/**
 * Compiles a template to responsive table-based HTML plus a plain-text twin. Deterministic.
 * Every injected value (and every piece of template text) is HTML-escaped, so a variable can never inject markup.
 */
export function compileEmailTemplate(template: EmailTemplate, provided: Readonly<VariableValues>, opts: CompileOptions = {}): CompiledEmail {
  const { values } = resolveVariables(template, provided);
  const th = template.theme;
  const ink = "#0f172a";
  const muted = "#64748b";
  const font = `font-family:${th.fontFamily};`;
  const urls: ResolvedUrl[] = [];
  const hidden: string[] = [];
  const h = (s: string): string => interpolate(s, values, "html");
  const t = (s: string): string => plain(s, values);

  const href = (blockId: string, template_: string): { html: string; text: string } => {
    const url = t(template_);
    const safe = isSafeUrl(url);
    urls.push({ blockId, url, safe });
    if (!safe) return { html: "#", text: url };
    const wrapped = opts.tracking && /^https?:/i.test(normalizeUrl(url)) ? `${opts.tracking.baseUrl.replace(/\/$/, "")}/c/${encodeURIComponent(opts.tracking.messageId)}?u=${encodeURIComponent(url)}` : url;
    return { html: escapeHtml(wrapped), text: url };
  };

  const htmlParts: string[] = [];
  const textParts: string[] = [];
  const row = (inner: string, pad = "0 32px 16px"): string => `<tr><td style="padding:${pad};${font}color:${ink};">${inner}</td></tr>`;

  const render = (b: EmailBlock): void => {
    switch (b.type) {
      case "header":
        htmlParts.push(`<tr><td style="padding:28px 32px 20px;${font}border-bottom:1px solid #e2e8f0;"><span style="font-size:18px;font-weight:700;color:${th.accentColor};letter-spacing:-0.01em;">${h(b.brandName)}</span>${b.badgeText ? ` <span style="display:inline-block;margin-left:8px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${muted};">${h(b.badgeText)}</span>` : ""}${b.subtitle ? `<div style="margin-top:4px;font-size:13px;color:${muted};">${h(b.subtitle)}</div>` : ""}</td></tr><tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>`);
        textParts.push(`${t(b.brandName)}${b.badgeText ? ` [${t(b.badgeText)}]` : ""}${b.subtitle ? `\n${t(b.subtitle)}` : ""}`);
        break;
      case "heading": {
        const size = b.level === "h2" ? 18 : 24;
        htmlParts.push(row(`<${b.level ?? "h1"} style="margin:0;font-size:${size}px;line-height:1.25;font-weight:700;color:${ink};${font}">${h(b.text)}</${b.level ?? "h1"}>`));
        textParts.push(t(b.text).toUpperCase());
        break;
      }
      case "paragraph":
        htmlParts.push(row(`<p style="margin:0;font-size:15px;line-height:1.6;color:${b.muted ? muted : ink};">${h(b.text).replace(/\r?\n/g, "<br>")}</p>`));
        textParts.push(t(b.text));
        break;
      case "otp_code": {
        const code = values[b.variableKey]?.display ?? `{{${b.variableKey}}}`;
        htmlParts.push(row(`<div style="font-size:12px;color:${muted};margin-bottom:8px;">${h(b.label)}</div><div style="display:inline-block;padding:14px 24px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:8px;font-weight:700;color:${ink};">${escapeHtml(code)}</div>${b.expiryNote ? `<div style="margin-top:10px;font-size:12px;color:${muted};">${h(b.expiryNote)}</div>` : ""}`));
        textParts.push(`${t(b.label)}: ${code}${b.expiryNote ? `\n${t(b.expiryNote)}` : ""}`);
        break;
      }
      case "key_value":
        htmlParts.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;">${b.rows.map((r) => `<tr><td style="padding:10px 14px;font-size:13px;color:${muted};border-bottom:1px solid #f1f5f9;width:40%;">${h(r.label)}</td><td style="padding:10px 14px;font-size:13px;color:${ink};border-bottom:1px solid #f1f5f9;">${h(r.valueTemplate)}</td></tr>`).join("")}</table>`));
        textParts.push(b.rows.map((r) => `${t(r.label)}: ${t(r.valueTemplate)}`).join("\n"));
        break;
      case "line_items":
        htmlParts.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${b.items.map((i) => `<tr><td style="padding:8px 0;font-size:14px;color:${ink};border-bottom:1px solid #f1f5f9;">${h(i.description)}</td><td align="right" style="padding:8px 0;font-size:14px;color:${ink};border-bottom:1px solid #f1f5f9;font-family:Menlo,Consolas,monospace;">${h(i.amountTemplate)}</td></tr>`).join("")}<tr><td style="padding:12px 0 0;font-size:14px;font-weight:700;color:${ink};">${h(b.totalLabel)}</td><td align="right" style="padding:12px 0 0;font-size:16px;font-weight:700;color:${ink};font-family:Menlo,Consolas,monospace;">${h(b.totalTemplate)}</td></tr></table>`));
        textParts.push([...b.items.map((i) => `${t(i.description)}  ${t(i.amountTemplate)}`), `${t(b.totalLabel)}: ${t(b.totalTemplate)}`].join("\n"));
        break;
      case "button": {
        const link = href(b.id, b.urlTemplate);
        const style = b.style ?? "primary";
        const bg = style === "amber" ? "#f59e0b" : style === "outline" ? "#ffffff" : th.accentColor;
        const fg = style === "amber" ? "#0f172a" : style === "outline" ? th.accentColor : "#ffffff";
        const border = style === "outline" ? `2px solid ${th.accentColor}` : `2px solid ${bg}`;
        htmlParts.push(row(`<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${bg};border:${border};"><a href="${link.html}" target="_blank" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:${fg};text-decoration:none;${font}">${h(b.label)}</a></td></tr></table>`));
        textParts.push(`${t(b.label)}: ${link.text}`);
        break;
      }
      case "callout": {
        const c = TONES[b.tone];
        htmlParts.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:14px 16px;background:${c.bg};border-left:4px solid ${c.border};border-radius:6px;color:${c.fg};font-size:14px;line-height:1.5;"><strong>${h(b.title)}</strong><br>${h(b.text)}</td></tr></table>`));
        textParts.push(`${t(b.title)}\n${t(b.text)}`);
        break;
      }
      case "image": {
        const src = t(b.srcTemplate);
        const srcSafe = /^https?:\/\//i.test(normalizeUrl(src));
        urls.push({ blockId: b.id, url: src, safe: srcSafe, image: true });
        const link = b.hrefTemplate ? href(b.id, b.hrefTemplate) : null;
        const w = b.width ? ` width="${b.width}"` : "";
        const img = `<img src="${srcSafe ? escapeHtml(src) : ""}" alt="${h(b.alt)}"${w} style="display:block;border:0;outline:none;max-width:100%;height:auto;${b.width ? `width:${b.width}px;` : ""}">`;
        const align = b.align === "center" ? "center" : "left";
        htmlParts.push(row(`<table role="presentation" cellpadding="0" cellspacing="0" align="${align}"><tr><td>${link ? `<a href="${link.html}" target="_blank" style="text-decoration:none;">${img}</a>` : img}</td></tr></table>`));
        textParts.push(`[${t(b.alt) || "image"}]${link ? ` ${link.text}` : ""}`);
        break;
      }
      case "divider":
        htmlParts.push(`<tr><td style="padding:8px 32px;"><div style="border-top:1px solid #e2e8f0;height:1px;line-height:1px;font-size:0;">&nbsp;</div></td></tr>`);
        textParts.push("────────────────────");
        break;
      case "footer": {
        const un = opts.domain?.unsubscribeUrl;
        htmlParts.push(`<tr><td style="padding:20px 32px 28px;font-size:12px;line-height:1.5;color:${muted};${font}border-top:1px solid #e2e8f0;">${h(b.companyAddress).replace(/\r?\n/g, "<br>")}${un ? `<br><a href="${escapeHtml(un)}" style="color:${muted};text-decoration:underline;">${h(b.unsubscribeText ?? "Unsubscribe")}</a>` : ""}</td></tr>`);
        textParts.push(`${t(b.companyAddress)}${un ? `\n${t(b.unsubscribeText ?? "Unsubscribe")}: ${un}` : ""}`);
        break;
      }
    }
  };

  for (const b of template.blocks) {
    if (b.showIfVariable !== undefined && !truthy(values[b.showIfVariable])) {
      hidden.push(b.id);
      continue;
    }
    render(b);
  }

  const subject = t(template.subject);
  const preheader = t(template.preheader);
  const pixel = opts.tracking ? `<img src="${escapeHtml(opts.tracking.baseUrl.replace(/\/$/, ""))}/o/${encodeURIComponent(opts.tracking.messageId)}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` : "";
  const padding = preheader ? "&#847;&zwnj;&nbsp;".repeat(40) : "";
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background:${th.canvasColor};${font}">${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}${padding}</div>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${th.canvasColor};"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${th.cardColor};border-radius:12px;border:1px solid #e2e8f0;">${htmlParts.join("")}</table></td></tr></table>${pixel}</body></html>`;
  const text = `${preheader ? `${preheader}\n\n` : ""}${textParts.join("\n\n")}\n`;
  const links = [...new Set(urls.filter((u) => !u.image && u.safe && /^https?:/i.test(normalizeUrl(u.url))).map((u) => u.url))];
  return { subject, preheader, html, text, urls, links, hiddenBlocks: hidden };
}

/** Every `{{token}}` still present in `text`. */
export function unresolvedTokens(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];
}

/** Every variable key a template references (subject, preheader and all blocks, including hidden ones). */
export function referencedVariables(template: EmailTemplate): string[] {
  const found = new Set<string>();
  const scan = (s: string | undefined): void => {
    if (s) for (const k of unresolvedTokens(s)) found.add(k);
  };
  scan(template.subject);
  scan(template.preheader);
  for (const b of template.blocks) {
    if (b.showIfVariable) found.add(b.showIfVariable);
    switch (b.type) {
      case "header": scan(b.brandName); scan(b.badgeText); scan(b.subtitle); break;
      case "heading": scan(b.text); break;
      case "paragraph": scan(b.text); break;
      case "otp_code": scan(b.label); scan(b.expiryNote); found.add(b.variableKey); break;
      case "key_value": b.rows.forEach((r) => { scan(r.label); scan(r.valueTemplate); }); break;
      case "line_items": b.items.forEach((i) => { scan(i.description); scan(i.amountTemplate); }); scan(b.totalLabel); scan(b.totalTemplate); break;
      case "button": scan(b.label); scan(b.urlTemplate); break;
      case "image": scan(b.srcTemplate); scan(b.alt); scan(b.hrefTemplate); break;
      case "callout": scan(b.title); scan(b.text); break;
      case "footer": scan(b.companyAddress); scan(b.unsubscribeText); break;
      default: break;
    }
  }
  return [...found];
}

export type { TemplateVariable };
