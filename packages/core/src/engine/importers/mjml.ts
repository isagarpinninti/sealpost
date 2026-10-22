import { buildTemplate, newContext, visit, hex, type ImportContext, type ImportOptions } from "./blocks";
import { findFirst, isEl, parseMarkup, textOf, type ElementNode, type MarkupNode } from "./markup";

const SKIP_SILENT = new Set(["mj-spacer", "mj-font", "mj-style", "mj-breakpoint", "mj-html-attributes", "mj-selector"]);

/** MJML elements → the equivalent plain-HTML nodes the HTML mapper understands. */
function convert(n: MarkupNode, ctx: ImportContext): MarkupNode | null {
  if (n.type === "text") return n;
  const tag = n.tag;
  if (SKIP_SILENT.has(tag)) return null;
  const kids = (): MarkupNode[] => n.children.map((c) => convert(c, ctx)).filter((c): c is MarkupNode => c !== null);
  const el = (t: string, attrs: Record<string, string>, children: MarkupNode[]): ElementNode => ({ type: "el", tag: t, attrs, children });
  switch (tag) {
    case "mj-text":
      return el("div", { style: n.attrs["font-size"] ? `font-size:${n.attrs["font-size"]}` : "" }, kids());
    case "mj-button": {
      const bg = hex(n.attrs["background-color"]);
      return el("a", { href: n.attrs.href ?? "#", role: "button", style: `background-color:${bg ?? "#414141"};padding:10px 25px;display:inline-block` }, kids());
    }
    case "mj-image": {
      const img = el("img", { src: n.attrs.src ?? "", alt: n.attrs.alt ?? "", ...(n.attrs.width ? { width: n.attrs.width } : {}) }, []);
      return n.attrs.href ? el("a", { href: n.attrs.href }, [img]) : img;
    }
    case "mj-divider":
      return el("hr", {}, []);
    case "mj-social": {
      const links = n.children.filter((c): c is ElementNode => isEl(c) && c.tag === "mj-social-element");
      if (links.length === 0) return null;
      ctx.warnings.push("Social icons were imported as a plain list of links.");
      return el("p", {}, links.flatMap((l, i): MarkupNode[] => [...(i > 0 ? [{ type: "text", text: " · " } as MarkupNode] : []), el("a", { href: l.attrs.href ?? "#" }, [{ type: "text", text: l.attrs.name ?? textOf(l) } as MarkupNode])]));
    }
    case "mj-navbar": {
      const links = n.children.filter((c): c is ElementNode => isEl(c) && c.tag === "mj-navbar-link");
      return links.length ? el("p", {}, links.flatMap((l, i): MarkupNode[] => [...(i > 0 ? [{ type: "text", text: " · " } as MarkupNode] : []), el("a", { href: l.attrs.href ?? "#" }, l.children)])) : null;
    }
    case "mj-table":
      return el("table", {}, kids());
    case "mj-raw":
      ctx.warnings.push("<mj-raw> HTML can't be represented in blocks and was skipped.");
      return null;
    case "mj-carousel":
    case "mj-accordion":
      ctx.warnings.push(`<${tag}> isn't supported and was skipped.`);
      return null;
    case "mj-column":
    case "mj-group":
    case "mj-section":
    case "mj-wrapper":
    case "mj-hero":
    case "mj-body":
      return el("div", {}, kids());
    default:
      return el(tag.startsWith("mj-") ? "div" : tag, tag.startsWith("mj-") ? {} : n.attrs, kids());
  }
}

/** Imports MJML source. A best-effort mapping onto Sealpost blocks, not an MJML renderer. */
export function importMjml(source: string, opts: ImportOptions = {}): ReturnType<typeof buildTemplate> {
  const ctx = newContext();
  const root = parseMarkup(source);
  const mjml = findFirst(root, (e) => e.tag === "mjml");
  if (!mjml) throw new Error("No <mjml> element found");
  const head = findFirst(mjml, (e) => e.tag === "mj-head");
  const body = findFirst(mjml, (e) => e.tag === "mj-body");
  if (!body) throw new Error("No <mj-body> found");
  if (head) {
    const title = findFirst(head, (e) => e.tag === "mj-title");
    if (title) ctx.hints.title = textOf(title);
    const prev = findFirst(head, (e) => e.tag === "mj-preview");
    if (prev) ctx.hints.preheader = textOf(prev);
    const all = findFirst(head, (e) => e.tag === "mj-all");
    if (all?.attrs["font-family"]) ctx.hints.font = all.attrs["font-family"].split(",").slice(0, 3).join(",");
    const btn = findFirst(head, (e) => e.tag === "mj-button");
    if (btn?.attrs["background-color"]) ctx.hints.accent = hex(btn.attrs["background-color"]);
  }
  ctx.hints.canvas = hex(body.attrs["background-color"]);
  const section = findFirst(body, (e) => e.tag === "mj-section" || e.tag === "mj-wrapper");
  ctx.hints.card = hex(section?.attrs["background-color"]) ?? "#ffffff";
  const firstBtn = findFirst(body, (e) => e.tag === "mj-button");
  if (!ctx.hints.accent && firstBtn) ctx.hints.accent = hex(firstBtn.attrs["background-color"]);
  const columns = [...(function* all(n: ElementNode): Generator<ElementNode> {
    for (const c of n.children) if (isEl(c)) {
      if (c.tag === "mj-section") yield c;
      yield* all(c);
    }
  })(body)].map((s) => s.children.filter((c) => isEl(c) && c.tag === "mj-column").length);
  ctx.flags.columns = Math.max(0, ...columns);
  const tree = convert(body, ctx);
  if (tree && isEl(tree)) visit(ctx, tree);
  return buildTemplate(ctx, opts);
}
