# Importing existing templates

Bring a template you already have into Sealpost: **MJML**, a **React Email** component, or the **HTML** of any email (including what React Email's `render()` produces).

```bash
sealpost template import welcome.mjml
sealpost template import emails/welcome.tsx --id welcome --category Growth
sealpost template import receipt.html --dry-run            # show what would be imported, write nothing
sealpost send welcome --to you@example.org --auto-fill
```

In the Studio: **Studio → Templates → Import** (the file icon). Paste or drop a file, see the blocks, variables and warnings and a live preview, then **Add to workspace**. The import runs in your browser; the source is never uploaded. The REST equivalent is `POST /api/import` (a preview; nothing is saved).

## What is mapped

Sealpost emails are a single column of typed blocks, so an import is an honest approximation, not a pixel copy. The importer tells you what it could not carry over.

| Source | Becomes |
| --- | --- |
| `<h1>`–`<h6>`, `mj-text` with a heading, `Heading` | `heading` (h1 stays h1, the rest become h2) |
| `<p>`, `<div>` text, `mj-text`, `Text` | `paragraph` (inline links become `text (url)`; bold, italic and colours are dropped) |
| An `<a>` that looks like a button, `mj-button`, `Button` | `button` (`primary`, or `outline` when it has no fill) |
| `<img>`, `mj-image`, `Img`, a linked image | `image` (width, alt, optional link). 1×1 tracking pixels are skipped |
| `<hr>`, `mj-divider`, `Hr` | `divider` |
| A two-column data table, `mj-table` | `key_value`; with a "Total" row and money amounts, `line_items` |
| A spaced monospace code such as `{{code}}` or `482913` | `otp_code` |
| `<ul>`/`<ol>` | a `paragraph` of bullet lines |
| The last text containing "unsubscribe", ©, "view in browser" | `footer` (the unsubscribe link itself is added by Sealpost from your domain's `unsubscribeUrl`) |
| A hidden preview element, `mj-preview`, `Preview` | the template's preheader |
| `<title>`, `mj-title` | the subject (and name) |
| Body, container and button colours, font stack | the template theme |

Dynamic values become `{{variables}}`, declared and typed from their names (`…Url` → `url`, `…Code` → `otp_code`, counts → `number`) with sample values. React Email's `PreviewProps` supply the samples.

### Variable syntax converted

`{{ user.name }}` → `{{user_name}}`, `{{{raw}}}` → `{{raw}}`, Mailchimp `*|FNAME|*` → `{{fname}}`, JSX `{name}`, `{props.name}` and template literals such as `` `${baseUrl}/logo.png` ``. Handlebars/Liquid logic (`{{#if}}`, `{% … %}`, partials, loops) cannot be expressed in Sealpost blocks and is removed with a warning.

## What is not carried over (and you are told)

- Multi-column layouts are flattened into one column.
- `mj-raw`, carousels, accordions, custom React components, `.map()` loops, conditionals and any other expression that cannot be read statically.
- Inline formatting, web fonts and per-element styling.
- Anything that would exceed Sealpost's limits is shortened.

## React Email files are read, never run

The importer reads the JSX as text. It does not execute your file, resolve imports or load modules, so code in the file (including `process.exit()` or file reads) is inert. Style objects such as `const main = { backgroundColor: "#fff" }` are read from the file to pick up theme colours.

If a component is too dynamic to read, render it to HTML with React Email (`render(<Email />)`) and import that HTML instead.

## Limits

The source can be up to 2 MB. Markup nested deeper than 120 levels is cut off. The result is validated against the Sealpost template schema, so an import either produces a valid template or a clear error.
