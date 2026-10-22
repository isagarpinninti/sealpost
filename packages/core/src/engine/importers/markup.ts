/** A tolerant HTML / XML tree parser, enough to read email markup. It never executes or fetches anything. */

export interface ElementNode {
  type: "el";
  tag: string;
  attrs: Record<string, string>;
  children: MarkupNode[];
}
export interface TextNode {
  type: "text";
  text: string;
}
export type MarkupNode = ElementNode | TextNode;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", euro: "€", pound: "£", yen: "¥", laquo: "«", raquo: "»", times: "×", zwnj: "‌", shy: "­" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const MAX_NODES = 50_000;
const MAX_DEPTH = 120;

/** Parses markup into a tree. Unknown or unbalanced tags are repaired, never fatal; very large inputs are truncated. */
export function parseMarkup(src: string): ElementNode {
  const root: ElementNode = { type: "el", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let i = 0;
  let nodes = 0;
  const top = (): ElementNode => stack[stack.length - 1];
  const addText = (t: string): void => {
    if (t !== "") top().children.push({ type: "text", text: decodeEntities(t) });
  };
  while (i < src.length && nodes < MAX_NODES) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      addText(src.slice(i));
      break;
    }
    if (lt > i) addText(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      top().children.push({ type: "text", text: src.slice(i + 9, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src[i + 1] === "/") {
      const end = src.indexOf(">", i + 2);
      const name = src.slice(i + 2, end < 0 ? src.length : end).trim().toLowerCase();
      i = end < 0 ? src.length : end + 1;
      const at = stack.map((n) => n.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(src.slice(i, i + 80));
    if (!m) {
      addText("<");
      i += 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    let j = i + m[0].length;
    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (j < src.length) {
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === ">") {
        j++;
        break;
      }
      if (src[j] === "/" && src[j + 1] === ">") {
        selfClose = true;
        j += 2;
        break;
      }
      const a = /^([^\s=>/"']+)/.exec(src.slice(j, j + 200));
      if (!a) {
        j++;
        continue;
      }
      j += a[1].length;
      while (j < src.length && /\s/.test(src[j])) j++;
      let value = "";
      if (src[j] === "=") {
        j++;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] === '"' || src[j] === "'") {
          const q = src[j];
          const end = src.indexOf(q, j + 1);
          value = src.slice(j + 1, end < 0 ? src.length : end);
          j = end < 0 ? src.length : end + 1;
        } else {
          const v = /^[^\s>]+/.exec(src.slice(j, j + 2000));
          value = v ? v[0] : "";
          j += value.length;
        }
      }
      attrs[a[1].toLowerCase()] = decodeEntities(value);
    }
    i = j;
    const el: ElementNode = { type: "el", tag, attrs, children: [] };
    nodes++;
    top().children.push(el);
    if (selfClose || VOID.has(tag)) continue;
    if (RAW_TEXT.has(tag)) {
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      el.children.push({ type: "text", text: src.slice(i, close < 0 ? src.length : close) });
      const end = close < 0 ? -1 : src.indexOf(">", close);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

export const isEl = (n: MarkupNode | undefined): n is ElementNode => n?.type === "el";

export function* walk(n: MarkupNode): Generator<ElementNode> {
  if (n.type !== "el") return;
  yield n;
  for (const c of n.children) yield* walk(c);
}

export function findFirst(n: MarkupNode, pred: (e: ElementNode) => boolean): ElementNode | undefined {
  for (const e of walk(n)) if (pred(e)) return e;
  return undefined;
}

/** `a: b; c: d` → { a: "b", c: "d" } (lower-cased keys). */
export function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "section", "center", "pre"]);

/**
 * Visible text of a node. `<br>` and block boundaries become newlines; a link whose text differs from its URL
 * becomes `text (url)` so nothing is lost when formatting is dropped.
 */
export function textOf(n: MarkupNode, opts: { links?: boolean } = {}): string {
  const links = opts.links ?? true;
  const own = n.type === "el" ? n.tag : "";
  const parts: string[] = [];
  const visit = (node: MarkupNode): void => {
    if (node.type === "text") {
      parts.push(node.text.replace(/[ \t\r\n ‌​­͏]+/g, " "));
      return;
    }
    if (node.tag === "br") return void parts.push("\n");
    if (node.tag === "style" || node.tag === "script" || node.tag === "head" || (node.tag === "title" && node.tag !== own)) return;
    if (node.tag === "img") return;
    const block = BLOCK_TAGS.has(node.tag);
    if (block) parts.push("\n");
    if (node.tag === "li") parts.push("• ");
    if (node.tag === "a" && links && node.attrs.href) {
      const inner = textOf(node, { links: false }).trim();
      const href = node.attrs.href;
      parts.push(inner === "" ? href : /^(https?:|mailto:)/i.test(href) && inner !== href && !/^\{\{/.test(inner) ? `${inner} (${href})` : inner);
      return;
    }
    for (const c of node.children) visit(c);
    if (block) parts.push("\n");
  };
  visit(n);
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
