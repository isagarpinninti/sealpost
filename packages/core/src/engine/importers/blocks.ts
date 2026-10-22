import { EmailTemplateSchema, VARIABLE_TYPES, type EmailBlock, type EmailTemplate } from "../../schemas/template";
import { isEl, parseStyle, textOf, type ElementNode, type MarkupNode } from "./markup";

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;
export type DraftBlock = Distribute<EmailBlock>;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export interface ImportOptions {
  id?: string;
  name?: string;
  category?: EmailTemplate["category"];
  subject?: string;
  /** Sample values for variables, such as React Email's `PreviewProps`. */
  samples?: Record<string, string | number | boolean>;
}

export interface Hints {
  title?: string;
  preheader?: string;
  canvas?: string;
  card?: string;
  accent?: string;
  font?: string;
}

export interface ImportContext {
  blocks: DraftBlock[];
  warnings: string[];
  hints: Hints;
  flags: { formatting: boolean; columns: number; deep?: boolean; shortened?: boolean };
}

export const newContext = (): ImportContext => ({ blocks: [], warnings: [], hints: {}, flags: { formatting: false, columns: 0 } });

const IGNORE = new Set(["head", "style", "script", "title", "meta", "link", "noscript", "svg", "x-font", "x-tailwind-config"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const INLINE = new Set(["span", "b", "strong", "i", "em", "u", "small", "font", "sup", "sub", "code", "abbr", "mark", "br", "s", "a", "label", "cite", "x-codeinline"]);
const STRUCTURAL = new Set(["p", "div", "section", "table", "ul", "ol", "blockquote", "hr", "img", "td", "tr", "th", "tbody", "thead", "tfoot", "center", "article", "main", "header", "footer", "pre", "li", ...HEADINGS]);

/* ───────────────────────── tokens ───────────────────────── */

const keyOf = (raw: string): string | null => {
  let k = raw.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (k === "") return null;
  if (/^[0-9]/.test(k)) k = `v_${k}`;
  return k.slice(0, 48);
};

/** Mailchimp `*|FNAME|*`, Handlebars `{{ user.name }}`, `{{{raw}}}` and Liquid/Handlebars blocks → plain `{{tokens}}`. */
export function normalizeTokens(text: string, warnings: string[]): string {
  const dropped = new Set<string>();
  let out = text.replace(/\*\|([A-Za-z0-9_:]+)\|\*/g, (_m, k: string) => {
    const key = keyOf(k.replace(/:.*/, ""));
    return key ? `{{${key.toLowerCase()}}}` : "";
  });
  out = out.replace(/\{\{\{\s*([^{}]+?)\s*\}\}\}/g, "{{$1}}");
  out = out.replace(/\{%[\s\S]*?%\}/g, (m) => {
    dropped.add(m.trim().slice(0, 40));
    return "";
  });
  out = out.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (m, inner: string) => {
    if (/^[#/>!^@]/.test(inner) || /^else\b/.test(inner) || /\s/.test(inner.trim().replace(/\s*\|.*$/, "")) && !/^[A-Za-z_][\w.\-]*$/.test(inner.trim().replace(/\s*\|.*$/, ""))) {
      dropped.add(m.slice(0, 40));
      return "";
    }
    const key = keyOf(inner.replace(/\s*\|.*$/, ""));
    if (!key) {
      dropped.add(m.slice(0, 40));
      return "";
    }
    if (key !== inner.trim()) dropped.add(`renamed: ${inner.trim()} → ${key}`);
    return `{{${key}}}`;
  });
  for (const d of dropped) warnings.push(d.startsWith("renamed:") ? `Variable ${d.slice(9)} (dots and spaces are not allowed in names)` : `Template logic ${d} can't be imported and was removed`);
  return out;
}

const humanize = (k: string): string => k.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).slice(0, 80);

/* ───────────────────────── leaf recognisers ───────────────────────── */

const px = (v: string | undefined): number | undefined => {
  const m = /^(\d+(?:\.\d+)?)\s*(px)?$/i.exec((v ?? "").trim());
  return m ? Math.round(Number(m[1])) : undefined;
};

function bgOf(st: Record<string, string>, attrs: Record<string, string> = {}): string | undefined {
  const raw = st["background-color"] ?? (/^#|^rgb/i.test(st.background ?? "") ? st.background : undefined) ?? (/^#/.test(attrs.bgcolor ?? "") ? attrs.bgcolor : undefined) ?? st.background?.split(/\s+/).find((p) => /^#[0-9a-f]{3,8}$/i.test(p));
  return hex(raw);
}

/** `#abc` → `#aabbcc`; `rgb()` → hex; anything else undefined. */
export function hex(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const t = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) return `#${m[1].split("").map((x) => x + x).join("")}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(t);
  if (m) return `#${m[1]}`;
  const r = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(t);
  if (r) return `#${[r[1], r[2], r[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
}

export function isButtonLike(a: ElementNode): boolean {
  if (a.tag !== "a") return false;
  const st = parseStyle(a.attrs.style);
  const cls = `${a.attrs.class ?? ""}`;
  if (a.attrs.role === "button" || /\b(btn|button)\b/i.test(cls)) return true;
  const hasBg = bgOf(st, a.attrs) !== undefined;
  const display = st.display ?? "";
  return hasBg && (/inline-block|block/.test(display) || st.padding !== undefined || Object.keys(st).some((k) => k.startsWith("padding")));
}

function isHidden(st: Record<string, string>): boolean {
  return st.display === "none" || st.visibility === "hidden" || st["mso-hide"] === "all" || (st["max-height"] === "0" || st["max-height"] === "0px") && st.overflow === "hidden";
}

function isTrackingPixel(img: ElementNode): boolean {
  const st = parseStyle(img.attrs.style);
  const w = px(img.attrs.width) ?? px(st.width);
  const h = px(img.attrs.height) ?? px(st.height);
  return (w !== undefined && w <= 2) || (h !== undefined && h <= 2) || isHidden(st) || !(img.attrs.src ?? "").trim();
}

const CODE_LIKE = /^(\{\{[A-Za-z0-9_]+\}\}|[A-Z0-9]{4,8}|\d{4,8}|\d{3}[ -]\d{3})$/;

function contains(n: ElementNode, pred: (e: ElementNode) => boolean): boolean {
  for (const c of n.children) if (isEl(c) && (pred(c) || contains(c, pred))) return true;
  return false;
}

const hasStructure = (n: ElementNode): boolean => contains(n, (e) => STRUCTURAL.has(e.tag) || e.tag === "img" || isButtonLike(e));

/* ───────────────────────── tree → blocks ───────────────────────── */

function paragraph(ctx: ImportContext, text: string, style?: Record<string, string>): void {
  const t = text.trim();
  if (t === "") return;
  const spaced = Number.parseFloat(style?.["letter-spacing"] ?? "0") >= 3;
  if (spaced && CODE_LIKE.test(t) && ctx.blocks.length < 80) {
    const tok = /^\{\{([A-Za-z0-9_]+)\}\}$/.exec(t);
    if (!tok) ctx.warnings.push(`The literal code "${t}" was replaced by an {{code}} variable.`);
    ctx.blocks.push({ type: "otp_code", label: "Your code", variableKey: tok?.[1] ?? "code" });
    return;
  }
  if (/(color|font-size)/.test(Object.keys(style ?? {}).join())) ctx.flags.formatting = true;
  ctx.blocks.push({ type: "paragraph", text: t });
}

function imageBlock(ctx: ImportContext, img: ElementNode, align: "left" | "center", href?: string): void {
  if (isTrackingPixel(img)) return;
  const st = parseStyle(img.attrs.style);
  const w = px(img.attrs.width) ?? px(st.width) ?? px(st["max-width"]);
  ctx.blocks.push({ type: "image", srcTemplate: img.attrs.src.trim(), alt: (img.attrs.alt ?? "").trim(), ...(href ? { hrefTemplate: href } : {}), ...(w ? { width: Math.min(600, Math.max(16, w)) } : {}), align });
}

function buttonBlock(ctx: ImportContext, a: ElementNode): void {
  const st = parseStyle(a.attrs.style);
  const bg = bgOf(st, a.attrs);
  const label = textOf(a, { links: false }).trim();
  if (label === "" && !a.attrs.href) return;
  if (bg && !ctx.hints.accent && bg !== "#ffffff") ctx.hints.accent = bg;
  const outline = bg === undefined || bg === "#ffffff" || /transparent|none/i.test(st.background ?? "");
  ctx.blocks.push({ type: "button", label: label || "Open", urlTemplate: (a.attrs.href ?? "#").trim(), style: outline ? "outline" : "primary" });
}

function dataTable(ctx: ImportContext, rows: string[][]): void {
  if (rows.length === 0) return;
  const money = /^[-+]?\s*[$€£¥]?\s*[\d{][\d,.{}A-Za-z_]*\s*[$€£¥]?$/;
  const last = rows[rows.length - 1];
  if (rows.length >= 2 && rows.every((r) => r.length === 2) && /total|amount due|balance/i.test(last[0]) && rows.slice(0, -1).every((r) => money.test(r[1]))) {
    ctx.blocks.push({ type: "line_items", items: rows.slice(0, -1).map((r) => ({ description: r[0], amountTemplate: r[1] })), totalLabel: last[0], totalTemplate: last[1] });
    return;
  }
  if (rows.every((r) => r.length === 2)) return void ctx.blocks.push({ type: "key_value", rows: rows.map((r) => ({ label: r[0], valueTemplate: r[1] })) });
  ctx.warnings.push("A table with more than two columns was imported as plain lines.");
  paragraph(ctx, rows.map((r) => r.join("  ·  ")).join("\n"));
}

function tableBlocks(ctx: ImportContext, table: ElementNode, align: "left" | "center", depth: number): void {
  const rows: ElementNode[] = [];
  const collect = (n: ElementNode): void => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.tag === "tr") rows.push(c);
      else if (c.tag === "tbody" || c.tag === "thead" || c.tag === "tfoot") collect(c);
    }
  };
  collect(table);
  const cells = rows.map((r) => r.children.filter((c): c is ElementNode => isEl(c) && (c.tag === "td" || c.tag === "th")));
  const layout = cells.some((cs) => cs.some((c) => hasStructure(c)));
  if (layout) {
    const widest = Math.max(0, ...cells.map((cs) => cs.filter((c) => textOf(c) !== "" || hasStructure(c)).length));
    if (widest > 1) ctx.flags.columns = Math.max(ctx.flags.columns, widest);
    for (const cs of cells) for (const c of cs) visit(ctx, c, centered(c) ? "center" : align, depth + 1);
    return;
  }
  dataTable(ctx, cells.map((cs) => cs.map((c) => textOf(c)).filter((t, i, all) => t !== "" || all.length > 1)).filter((r) => r.some((t) => t !== "")));
}

function centered(n: ElementNode): boolean {
  if (n.tag === "table") return false; // a table's align / auto margins place the table, not its content
  const st = parseStyle(n.attrs.style);
  return n.attrs.align === "center" || st["text-align"] === "center" || /auto/.test(st.margin ?? "") && /auto/.test(st["margin-left"] ?? st.margin ?? "");
}

function flushInline(ctx: ImportContext, buf: MarkupNode[]): void {
  if (buf.length === 0) return;
  const holder: ElementNode = { type: "el", tag: "span", attrs: {}, children: buf.splice(0) };
  paragraph(ctx, textOf(holder));
}

/** Walks one element, appending blocks. Layout wrappers are looked through; formatting is dropped. */
export function visit(ctx: ImportContext, n: ElementNode, align: "left" | "center" = "left", depth = 0): void {
  if (ctx.blocks.length >= 80) return;
  if (depth > 200) return void (ctx.flags.deep = true);
  const tag = n.tag;
  if (IGNORE.has(tag)) return;
  const st = parseStyle(n.attrs.style);
  if (isHidden(st)) {
    const t = textOf(n).replace(/[ ‌​͏­\s]+/g, " ").trim();
    if (t !== "" && !ctx.hints.preheader) ctx.hints.preheader = t;
    return;
  }
  const here = centered(n) ? "center" : align;
  if (HEADINGS.has(tag)) {
    const t = textOf(n, { links: false });
    if (t !== "") ctx.blocks.push({ type: "heading", text: t, level: tag === "h1" ? "h1" : "h2" });
    return;
  }
  if (tag === "hr") return void ctx.blocks.push({ type: "divider" });
  if (tag === "img") return imageBlock(ctx, n, here);
  if (tag === "a") {
    if (isButtonLike(n)) return buttonBlock(ctx, n);
    const imgs = n.children.filter((c): c is ElementNode => isEl(c) && c.tag === "img");
    if (imgs.length === 1 && textOf(n, { links: false }) === "") return imageBlock(ctx, imgs[0], here, (n.attrs.href ?? "").trim() || undefined);
    if (hasStructure(n)) return void visitChildren(ctx, n, here, depth);
    return paragraph(ctx, textOf(n), st);
  }
  if (tag === "table") return tableBlocks(ctx, n, here, depth);
  if (tag === "ul" || tag === "ol") {
    const items = n.children.filter((c): c is ElementNode => isEl(c) && c.tag === "li").map((li, i) => `${tag === "ol" ? `${i + 1}.` : "•"} ${textOf(li).replace(/^• /, "")}`);
    return paragraph(ctx, items.join("\n"));
  }
  if (tag === "p" || tag === "blockquote" || tag === "pre") {
    if (!hasStructure(n)) return paragraph(ctx, textOf(n), st);
    return void visitChildren(ctx, n, here, depth);
  }
  if (!hasStructure(n)) return paragraph(ctx, textOf(n), st);
  visitChildren(ctx, n, here, depth);
}

function visitChildren(ctx: ImportContext, n: ElementNode, align: "left" | "center", depth: number): void {
  const inline: MarkupNode[] = [];
  for (const c of n.children) {
    if (c.type === "text") {
      if (c.text.trim() !== "") inline.push(c);
      continue;
    }
    if (INLINE.has(c.tag) && !isButtonLike(c) && !hasStructure(c) && !(c.tag === "a" && c.children.some((x) => isEl(x) && x.tag === "img"))) {
      inline.push(c);
      continue;
    }
    flushInline(ctx, inline);
    visit(ctx, c, align, depth + 1);
  }
  flushInline(ctx, inline);
}

/* ───────────────────────── finishing ───────────────────────── */

const FOOTER = /(unsubscribe|©|&copy;|copyright|all rights reserved|manage (your )?(email )?preferences|view (this email )?in (your )?browser)/i;

function finishBlocks(ctx: ImportContext): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (const b of ctx.blocks) {
    const prev = out[out.length - 1];
    if (b.type === "divider" && (prev === undefined || prev.type === "divider")) continue;
    out.push(b);
  }
  while (out.length > 0 && out[out.length - 1].type === "divider") out.pop();
  const last = out[out.length - 1];
  if (last?.type === "paragraph" && FOOTER.test(last.text)) {
    const links = /(unsubscribe|view (this email )?in (your )?browser|manage (your )?(email )?preferences)( \([^)]*\))?/gi;
    const lines = last.text.split("\n").map((l) => l.replace(links, "").replace(/(^|\s)[·|•-]+(\s|$)/g, " ").replace(/[ \t]{2,}/g, " ").replace(/\s*[·|•-]\s*$/, "").trim()).filter((l) => l !== "");
    out[out.length - 1] = { type: "footer", companyAddress: (lines.join("\n").trim() || last.text).slice(0, 400), unsubscribeText: "Unsubscribe" };
  }
  return out;
}

/* ───────────────────────── template assembly ───────────────────────── */

const LIMITS: Record<string, Record<string, number>> = {
  heading: { text: 300 },
  paragraph: { text: 5000 },
  button: { label: 120, urlTemplate: 2000 },
  image: { srcTemplate: 2000, alt: 300, hrefTemplate: 2000 },
  otp_code: { label: 200 },
  footer: { companyAddress: 400, unsubscribeText: 200 },
};

/** Cuts text that exceeds Sealpost's field limits, and rows beyond the maximum, so a long source still imports. */
function fitBlock(b: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const cut = (v: unknown, max: number): unknown => {
    if (typeof v === "string" && v.length > max) {
      warnings.push("Some long text was shortened to fit Sealpost's field limits.");
      return v.slice(0, max);
    }
    return v;
  };
  const lim = LIMITS[String(b.type)] ?? {};
  for (const [k, max] of Object.entries(lim)) if (k in b) b[k] = cut(b[k], max);
  if (b.type === "key_value" && Array.isArray(b.rows)) b.rows = (b.rows as Array<Record<string, unknown>>).slice(0, 30).map((r) => ({ label: cut(r.label, 120), valueTemplate: cut(r.valueTemplate, 500) }));
  if (b.type === "line_items" && Array.isArray(b.items)) {
    b.items = (b.items as Array<Record<string, unknown>>).slice(0, 60).map((r) => ({ description: cut(r.description, 300), amountTemplate: cut(r.amountTemplate, 100) }));
    b.totalLabel = cut(b.totalLabel, 80);
    b.totalTemplate = cut(b.totalTemplate, 100);
  }
  return b;
}

function allStrings(v: unknown, into: string[]): void {
  if (typeof v === "string") into.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, into);
  else if (v && typeof v === "object") for (const x of Object.values(v)) allStrings(x, into);
}

function guessType(key: string, sample: string | number | boolean | undefined, otp: boolean): (typeof VARIABLE_TYPES)[number] {
  if (typeof sample === "boolean") return "boolean";
  if (typeof sample === "number") return "number";
  if (otp) return "otp_code";
  if (/(^|_)(url|link|href|uri)$|url$/i.test(key) || (typeof sample === "string" && /^https?:\/\//.test(sample))) return "url";
  if (/(^|_)(count|minutes|hours|days|qty|quantity|seconds)$/i.test(key)) return "number";
  return "string";
}

function sampleFor(key: string, type: (typeof VARIABLE_TYPES)[number], provided: string | number | boolean | undefined): string | number | boolean {
  if (provided !== undefined) return provided;
  switch (type) {
    case "url": return `https://example.com/${key.replace(/_?url$/i, "") || "path"}`;
    case "otp_code": return "482913";
    case "number": return 5;
    case "boolean": return true;
    default: return `Sample ${humanize(key).toLowerCase()}`;
  }
}

const slugOf = (s: string): string => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9_]+/, "");
  return (base.length >= 2 ? base : "imported_email").slice(0, 60);
};

export function buildTemplate(ctx: ImportContext, opts: ImportOptions): { template: EmailTemplate; warnings: string[] } {
  const warnings = [...ctx.warnings];
  const blocks = finishBlocks(ctx);
  if (blocks.length === 0) throw new ImportError("Nothing importable was found: the markup has no text, buttons, images or tables.");
  if (ctx.blocks.length >= 80) warnings.push("The template was cut at 80 blocks.");
  if (ctx.flags.formatting) warnings.push("Inline formatting (colours, sizes, bold, italic) isn't part of Sealpost blocks and was removed. Links inside text are kept as “text (url)”.");
  if (ctx.flags.columns > 1) warnings.push(`Multi-column layout (${ctx.flags.columns} columns) was flattened into a single column; Sealpost emails are one column.`);

  if (ctx.flags.deep) warnings.push("Very deeply nested markup was cut off.");
  const norm = (s: string): string => normalizeTokens(s, warnings);
  const numbered: Array<Record<string, unknown>> = blocks.map((b, i) => ({ ...(JSON.parse(JSON.stringify(b)) as Record<string, unknown>), id: `b${i + 1}` }));
  const mapStrings = (v: unknown): unknown => (typeof v === "string" ? norm(v) : Array.isArray(v) ? v.map(mapStrings) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "type" || k === "id" || k === "variableKey" || k === "level" || k === "style" || k === "tone" || k === "align" ? x : mapStrings(x)])) : v);
  const finalBlocks = numbered.map((b) => fitBlock(mapStrings(b) as Record<string, unknown>, warnings));

  const subject = norm(opts.subject ?? ctx.hints.title ?? "").trim() || "Imported email";
  const name = normalizeTokens(opts.name ?? ctx.hints.title ?? "Imported email", []).replace(/\{\{|\}\}/g, "").trim().slice(0, 120) || "Imported email";
  const preheader = norm(ctx.hints.preheader ?? "").slice(0, 300);

  const strings: string[] = [subject, preheader];
  allStrings(finalBlocks, strings);
  const keys = new Set<string>();
  for (const s of strings) for (const m of s.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,47})\}\}/g)) keys.add(m[1]);
  const otpKeys = new Set(finalBlocks.filter((b) => b.type === "otp_code").map((b) => String(b.variableKey)));
  for (const k of otpKeys) keys.add(k);
  const samples = opts.samples ?? {};
  const variables = [...keys].map((key) => {
    const type = guessType(key, samples[key], otpKeys.has(key));
    return { key, label: humanize(key), type, required: true, sampleValue: sampleFor(key, type, samples[key]) };
  });
  if (variables.length > 60) warnings.push("More than 60 variables were found; only the first 60 were declared.");

  const font = (ctx.hints.font ?? "").replace(/["']/g, "").replace(/[^\w ,-]/g, "").trim();
  const draft = {
    id: opts.id ?? slugOf(name),
    name,
    version: "1.0.0",
    category: opts.category ?? "Transactional",
    description: "Imported from an existing template.",
    subject: subject.slice(0, 500),
    preheader,
    variables: variables.slice(0, 60),
    theme: { ...(ctx.hints.accent ? { accentColor: ctx.hints.accent } : {}), ...(ctx.hints.canvas ? { canvasColor: ctx.hints.canvas } : {}), ...(ctx.hints.card ? { cardColor: ctx.hints.card } : {}), ...(font ? { fontFamily: font.slice(0, 200) } : {}) },
    blocks: finalBlocks,
  };
  const parsed = EmailTemplateSchema.safeParse(draft);
  if (!parsed.success) throw new ImportError("The imported content does not fit a Sealpost template", parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`));
  return { template: parsed.data, warnings: [...new Set(warnings)] };
}

/** Theme hints from the page chrome: body background, the centred card, the font. */
export function themeFromBody(ctx: ImportContext, body: ElementNode): void {
  const st = parseStyle(body.attrs.style);
  ctx.hints.canvas ??= bgOf(st, body.attrs);
  ctx.hints.font ??= st["font-family"]?.split(",").slice(0, 3).join(",");
  for (const e of walkLimited(body, 400)) {
    const s = parseStyle(e.attrs.style);
    const w = px(e.attrs.width) ?? px(s["max-width"]) ?? px(s.width);
    if (!ctx.hints.card && w !== undefined && w >= 420 && w <= 700) {
      const bg = bgOf(s, e.attrs);
      if (bg && bg !== ctx.hints.canvas) ctx.hints.card = bg;
    }
    if (!ctx.hints.font && s["font-family"]) ctx.hints.font = s["font-family"].split(",").slice(0, 3).join(",");
  }
}

function* walkLimited(n: ElementNode, limit: number): Generator<ElementNode> {
  let count = 0;
  const stack: ElementNode[] = [n];
  while (stack.length && count++ < limit) {
    const cur = stack.shift() as ElementNode;
    yield cur;
    for (const c of cur.children) if (isEl(c)) stack.push(c);
  }
}
