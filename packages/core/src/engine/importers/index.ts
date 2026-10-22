import { buildTemplate, ImportError, newContext, themeFromBody, visit, type ImportOptions } from "./blocks";
import { findFirst, isEl, parseMarkup, textOf } from "./markup";
import { readReactEmail } from "./jsx";
import { importMjml } from "./mjml";
import type { EmailTemplate } from "../../schemas/template";

export { ImportError } from "./blocks";
export type { ImportOptions } from "./blocks";

export type ImportFormat = "mjml" | "html" | "react";

export interface ImportResult {
  format: ImportFormat;
  template: EmailTemplate;
  /** What could not be carried over, in plain language. */
  warnings: string[];
}

/** Guesses the format from the content. */
export function detectImportFormat(source: string): ImportFormat {
  if (/<mjml[\s>]/i.test(source)) return "mjml";
  if (/from\s+["']@react-email\//.test(source) || /<Html[\s>]/.test(source) || (/export\s+default/.test(source) && /return\s*\(?\s*<[A-Z]/.test(source))) return "react";
  return "html";
}

export function importHtml(source: string, opts: ImportOptions = {}): ReturnType<typeof buildTemplate> {
  const ctx = newContext();
  const root = parseMarkup(source);
  const title = findFirst(root, (e) => e.tag === "title");
  if (title) ctx.hints.title = textOf(title);
  const body = findFirst(root, (e) => e.tag === "body") ?? root;
  themeFromBody(ctx, body);
  visit(ctx, body);
  return buildTemplate(ctx, opts);
}

export function importReactEmail(source: string, opts: ImportOptions = {}): ReturnType<typeof buildTemplate> {
  const r = readReactEmail(source);
  if (!r.root) throw new ImportError(r.warnings[0] ?? "No JSX found");
  const ctx = newContext();
  ctx.warnings.push(...r.warnings);
  const preview = findFirst(r.root, (e) => e.attrs["data-component"] === "Preview");
  if (preview) ctx.hints.preheader = textOf(preview).trim();
  const body = findFirst(r.root, (e) => e.attrs["data-component"] === "Body") ?? r.root;
  themeFromBody(ctx, body);
  const custom = new Set<string>();
  const scan = (n: typeof r.root): void => {
    if (n.tag.startsWith("x-") && n.attrs["data-component"] && !["Font", "Tailwind"].includes(n.attrs["data-component"])) custom.add(n.attrs["data-component"]);
    for (const c of n.children) if (isEl(c)) scan(c);
  };
  scan(r.root);
  for (const c of custom) ctx.warnings.push(`The custom component <${c}> can't be read statically and was skipped.`);
  visit(ctx, body);
  const title = textOf(findFirst(r.root, (e) => e.attrs["data-component"] === "Heading") ?? r.root).split("\n")[0];
  ctx.hints.title ??= preview ? ctx.hints.preheader : title;
  const spaced = r.componentName?.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return buildTemplate(ctx, { ...opts, name: opts.name ?? spaced, samples: { ...r.previewProps, ...opts.samples } });
}

/**
 * Turns an existing email template into a Sealpost template. `mjml` reads MJML, `html` reads any email HTML
 * (including the output of React Email's `render()`), `react` reads a React Email component's JSX without running it.
 * Throws `ImportError` when nothing usable is found. The result is validated; check `warnings` for what was approximated.
 */
export function importTemplate(source: string, opts: ImportOptions & { format?: ImportFormat } = {}): ImportResult {
  if (source.trim() === "") throw new ImportError("The source is empty");
  if (source.length > 2_000_000) throw new ImportError("The source is larger than 2 MB");
  const format = opts.format ?? detectImportFormat(source);
  const run = format === "mjml" ? importMjml : format === "react" ? importReactEmail : importHtml;
  try {
    const { template, warnings } = run(source, opts);
    return { format, template, warnings };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(e instanceof Error ? e.message : "Import failed");
  }
}
