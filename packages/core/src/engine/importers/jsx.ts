import type { ElementNode, MarkupNode } from "./markup";

/**
 * A static reader for the JSX of a React Email template. It parses the markup only: nothing is evaluated, no code
 * runs, no module is loaded. Props become `{{variables}}`; anything it cannot read statically is reported.
 */
export interface JsxResult {
  root: ElementNode | null;
  /** The component's name, for naming the template. */
  componentName?: string;
  /** `PreviewProps` (React Email's convention for sample data). */
  previewProps: Record<string, string | number | boolean>;
  /** Names destructured from the component's props. */
  propNames: string[];
  warnings: string[];
}

const COMPONENT_TAGS: Record<string, string> = {
  html: "div",
  head: "head",
  body: "div",
  container: "div",
  section: "div",
  row: "div",
  column: "div",
  tailwind: "div",
  heading: "h1",
  text: "p",
  link: "a",
  img: "img",
  hr: "hr",
  button: "a",
  preview: "div",
};

class Reader {
  i = 0;
  readonly warnings: string[] = [];
  /** `const main = { … }` style objects declared in the file, by name. */
  readonly styles: Record<string, Record<string, string>> = {};
  constructor(
    readonly s: string,
    scan = true,
  ) {
    if (scan) for (const m of s.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::\s*[\w.<>[\], ]+)?=\s*\{/g)) {
      const sub = new Reader(s, false);
      sub.i = (m.index ?? 0) + m[0].length - 1;
      const body = sub.scanBraces();
      if (/^\s*(?:\w+\s*:|\.\.\.|$)/.test(body)) this.styles[m[1]] = parseStyleObject(`{${body}}`);
    }
  }

  skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  /** Index just past the `}` matching the `{` at `this.i`, honouring strings, template literals and comments. */
  scanBraces(): string {
    const start = this.i;
    let depth = 0;
    const s = this.s;
    let j = this.i;
    const skipString = (q: string): void => {
      j++;
      while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
      j++;
    };
    const skipTemplate = (): void => {
      j++;
      while (j < s.length && s[j] !== "`") {
        if (s[j] === "\\") j += 2;
        else if (s[j] === "$" && s[j + 1] === "{") {
          let d = 0;
          while (j < s.length) {
            if (s[j] === "{") d++;
            else if (s[j] === "}" && --d === 0) break;
            else if (s[j] === '"' || s[j] === "'") skipString(s[j]);
            j++;
          }
          j++;
        } else j++;
      }
      j++;
    };
    while (j < s.length) {
      const c = s[j];
      if (c === '"' || c === "'") skipString(c);
      else if (c === "`") skipTemplate();
      else if (c === "/" && s[j + 1] === "/") j = s.indexOf("\n", j) < 0 ? s.length : s.indexOf("\n", j);
      else if (c === "/" && s[j + 1] === "*") j = s.indexOf("*/", j) < 0 ? s.length : s.indexOf("*/", j) + 2;
      else {
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          this.i = j + 1;
          return s.slice(start + 1, j);
        }
        j++;
      }
    }
    this.i = s.length;
    return s.slice(start + 1);
  }

  /** The text a JS expression stands for, with identifiers turned into `{{tokens}}`; null if it is not static. */
  expr(code: string): string | null {
    const c = code.trim();
    if (c === "" || /^\/\*[\s\S]*\*\/$/.test(c)) return "";
    let m = /^props\.([A-Za-z_]\w*)$/.exec(c) ?? /^([A-Za-z_]\w*)$/.exec(c);
    if (m && !["true", "false", "null", "undefined"].includes(m[1])) return `{{${m[1]}}}`;
    m = /^(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1$/.exec(c);
    if (m) return m[2].replace(/\\(.)/g, "$1");
    m = /^`((?:\\[\s\S]|[^`\\])*)`$/.exec(c);
    if (m) {
      let ok = true;
      const out = m[1].replace(/\$\{\s*(?:props\.)?([A-Za-z_]\w*)\s*\}/g, (_x, k: string) => `{{${k}}}`).replace(/\$\{[^}]*\}/g, () => {
        ok = false;
        return "";
      });
      return ok ? out.replace(/\\(.)/g, "$1") : null;
    }
    if (/^-?\d+(\.\d+)?$/.test(c)) return c;
    return null;
  }

  attrs(): { attrs: Record<string, string>; style: Record<string, string>; selfClose: boolean } {
    const attrs: Record<string, string> = {};
    const style: Record<string, string> = {};
    for (;;) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === undefined) return { attrs, style, selfClose: false };
      if (c === "/" && this.s[this.i + 1] === ">") {
        this.i += 2;
        return { attrs, style, selfClose: true };
      }
      if (c === ">") {
        this.i++;
        return { attrs, style, selfClose: false };
      }
      if (c === "{") {
        this.scanBraces();
        this.warnings.push("A spread of props ({...props}) on an element was ignored");
        continue;
      }
      const nm = /^[A-Za-z_:][\w:.-]*/.exec(this.s.slice(this.i, this.i + 100));
      if (!nm) {
        this.i++;
        continue;
      }
      this.i += nm[0].length;
      const name = nm[0];
      this.skipWs();
      if (this.s[this.i] !== "=") {
        attrs[name] = "true";
        continue;
      }
      this.i++;
      this.skipWs();
      const q = this.s[this.i];
      if (q === '"' || q === "'") {
        const end = this.s.indexOf(q, this.i + 1);
        attrs[name] = this.s.slice(this.i + 1, end < 0 ? this.s.length : end);
        this.i = end < 0 ? this.s.length : end + 1;
      } else if (q === "{") {
        const code = this.scanBraces();
        if (name === "style") {
          const ref = /^\s*([A-Za-z_]\w*)\s*$/.exec(code)?.[1];
          const resolved = ref ? this.styles[ref] : parseStyleObject(code);
          if (ref && !resolved) this.warnings.push(`The style constant ${ref} could not be read`);
          for (const [k, v] of Object.entries(resolved ?? {})) style[k] = v;
        } else {
          const v = this.expr(code);
          if (v === null) this.warnings.push(`The value of ${name}={${code.trim().slice(0, 40)}} is dynamic and was ignored`);
          else attrs[name] = v;
        }
      }
    }
  }

  element(): ElementNode | null {
    if (this.s[this.i] !== "<") return null;
    this.i++;
    let name = "";
    if (this.s[this.i] !== ">") {
      const nm = /^[A-Za-z][\w.:-]*/.exec(this.s.slice(this.i, this.i + 100));
      if (!nm) return null;
      name = nm[0];
      this.i += name.length;
    } else this.i++; // fragment
    const { attrs, style, selfClose } = name === "" ? { attrs: {}, style: {}, selfClose: false } : this.attrs();
    const lower = name.toLowerCase();
    const component = /^[A-Z]/.test(name);
    const tag = component ? (COMPONENT_TAGS[lower] ?? `x-${lower}`) : lower === "" ? "div" : lower;
    const node: ElementNode = { type: "el", tag, attrs: { ...attrs }, children: [] };
    if (component) node.attrs["data-component"] = name;
    if (Object.keys(style).length) node.attrs.style = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(";");
    if (component && lower === "heading" && (attrs.as === "h2" || attrs.as === "h3" || attrs.as === "h4")) node.tag = attrs.as === "h2" ? "h2" : "h3";
    if (component && lower === "button") node.attrs.role = "button";
    if (selfClose) return node;
    for (;;) {
      if (this.i >= this.s.length) return node;
      const c = this.s[this.i];
      if (c === "<") {
        if (this.s[this.i + 1] === "/") {
          const end = this.s.indexOf(">", this.i);
          this.i = end < 0 ? this.s.length : end + 1;
          return node;
        }
        const child = this.element();
        if (child) node.children.push(child);
        else this.i++;
      } else if (c === "{") {
        const code = this.scanBraces();
        const v = this.expr(code);
        if (v === null) this.warnings.push(`{${code.trim().replace(/\s+/g, " ").slice(0, 50)}} can't be imported statically and was skipped`);
        else if (v !== "") node.children.push({ type: "text", text: v });
      } else {
        let end = this.i;
        while (end < this.s.length && this.s[end] !== "<" && this.s[end] !== "{") end++;
        const raw = this.s.slice(this.i, end);
        this.i = end;
        const text = raw.replace(/\s*\n\s*/g, " ");
        if (text.trim() !== "" || !/\n/.test(raw)) node.children.push({ type: "text", text: text.replace(/&nbsp;/g, " ") });
      }
    }
  }
}

/** `{ backgroundColor: "#000", color: "#fff" }` → { "background-color": "#000", color: "#fff" }; non-literal values are skipped. */
function parseStyleObject(code: string): Record<string, string> {
  const inner = code.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out: Record<string, string> = {};
  for (const m of inner.matchAll(/([A-Za-z_]\w*)\s*:\s*(?:"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))/g)) {
    const key = m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out[key] = m[2] ?? m[3] ?? (m[4] !== undefined ? `${m[4]}px` : "");
  }
  return out;
}

function parsePreviewProps(src: string): Record<string, string | number | boolean> {
  const m = /\.PreviewProps\s*=\s*\{([\s\S]*?)\}\s*(?:as\s+\w+)?\s*;?/.exec(src);
  const out: Record<string, string | number | boolean> = {};
  if (!m) return out;
  for (const p of m[1].matchAll(/([A-Za-z_]\w*)\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|(-?\d+(?:\.\d+)?)|(true|false))/g)) {
    out[p[1]] = p[2] ?? p[3] ?? p[4] ?? (p[5] !== undefined ? Number(p[5]) : p[6] === "true");
  }
  return out;
}

function propNames(src: string): string[] {
  const m = /export\s+default\s+(?:function\s+\w*|async\s+function\s+\w*)?\s*\(?\s*\{([^}]*)\}/.exec(src) ?? /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|\w+)?)\s*(?:=>)?\s*\(\s*\{([^}]*)\}/.exec(src);
  return m ? m[1].split(",").map((p) => p.split(/[:=]/)[0].trim()).filter((p) => /^[A-Za-z_]\w*$/.test(p)) : [];
}

export function readReactEmail(source: string): JsxResult {
  const previewProps = parsePreviewProps(source);
  const props = propNames(source);
  const htmlAt = source.search(/<Html[\s>]/);
  let start = htmlAt;
  if (start < 0) {
    const m = /return\s*\(?\s*(<[A-Za-z>])/.exec(source) ?? /=>\s*\(?\s*(<[A-Za-z>])/.exec(source);
    start = m && m.index !== undefined ? m.index + m[0].length - m[1].length : -1;
  }
  if (start < 0) return { root: null, previewProps, propNames: props, warnings: ["No JSX found. Expected a React Email component such as <Html>…</Html>."] };
  const r = new Reader(source);
  r.i = start;
  const root = r.element();
  const componentName = /export\s+(?:default\s+)?(?:const|function)\s+([A-Z]\w+)/.exec(source)?.[1] ?? /\bconst\s+([A-Z]\w+)\s*=\s*\(/.exec(source)?.[1];
  return { root, componentName, previewProps, propNames: props, warnings: [...new Set(r.warnings)] };
}

export type { MarkupNode };
