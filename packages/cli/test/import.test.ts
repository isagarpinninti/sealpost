/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startServer, type RunningServer } from "../src";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
const MJML = `<mjml><mj-head><mj-title>Welcome {{name}}</mj-title></mj-head><mj-body><mj-section><mj-column><mj-text><h1>Hello {{name}}</h1></mj-text><mj-text>Your plan is {{plan}}.</mj-text><mj-button href="{{url}}">Open</mj-button></mj-column></mj-section></mj-body></mjml>`;

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-imp-"));
  expect(await run(["init", dir, "--name", "imp", "--domain", "mail.example.com"], io)).toBe(0);
  return dir;
}

describe("template import", () => {
  it("imports a file, saves it, and the template sends through the full pipeline", async () => {
    const dir = await project();
    const file = join(dir, "welcome.mjml");
    await writeFile(file, MJML);
    const out: string[] = [];
    const cap: Io = { ...io, out: (t) => out.push(t) };
    expect(await run(["template", "import", file, "--id", "welcome_mjml", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/Read .*as mjml: 3 blocks, 3 variables/);
    const saved = JSON.parse(await readFile(join(dir, "templates", "welcome_mjml.json"), "utf8"));
    expect(saved).toMatchObject({ id: "welcome_mjml", subject: "Welcome {{name}}" });
    expect(await run(["validate", dir], io)).toBe(0);
    out.length = 0;
    expect(await run(["send", "welcome_mjml", "--to", "a@example.org", "--auto-fill", "--dir", dir], cap)).toBe(0);
    expect(out.join("\n")).toMatch(/Delivered/);
  });

  it("refuses to overwrite without --force, supports --dry-run, and reports unusable input", async () => {
    const dir = await project();
    const file = join(dir, "a.mjml");
    await writeFile(file, MJML);
    expect(await run(["template", "import", file, "--id", "a_tpl", "--dry-run", "--dir", dir], io)).toBe(0);
    await expect(readFile(join(dir, "templates", "a_tpl.json"), "utf8")).rejects.toThrow();
    expect(await run(["template", "import", file, "--id", "a_tpl", "--dir", dir], io)).toBe(0);
    expect(await run(["template", "import", file, "--id", "a_tpl", "--dir", dir], io)).toBe(1);
    expect(await run(["template", "import", file, "--id", "a_tpl", "--force", "--dir", dir], io)).toBe(0);
    const empty = join(dir, "empty.html");
    await writeFile(empty, "<html><body></body></html>");
    expect(await run(["template", "import", empty, "--dir", dir], io)).toBe(1);
    expect(await run(["template", "import", file, "--format", "pdf", "--dir", dir], io)).toBe(1);
    expect(await run(["template", "import", "/nonexistent.html", "--dir", dir], io)).toBe(1);
  });

  it("previews over the API without saving, and reports problems as 422 import_failed", async () => {
    const dir = await project();
    const s: RunningServer = await startServer({ dir, port: 0 });
    closers.push(() => s.close());
    const post = async (body: unknown): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${s.url}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const ok = await post({ source: MJML, id: "preview_only" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, format: "mjml", template: { id: "preview_only", blocks: [{ type: "heading" }, { type: "paragraph" }, { type: "button" }] } });
    await expect(readFile(join(dir, "templates", "preview_only.json"), "utf8")).rejects.toThrow();
    const bad = await post({ source: "<html><body></body></html>" });
    expect([bad.status, bad.json.code]).toEqual([422, "import_failed"]);
    expect((await post({ format: "mjml" })).json.code).toBe("invalid_request");
    expect((await post({ source: "x", id: "Bad Id" })).status).toBe(400);
    expect((await post({ source: "x".repeat(2_000_001) })).status).toBe(400);
    expect((await post({ source: "x".repeat(1_500_000) })).status).toBe(200); // plain text imports as one (shortened) paragraph
  });
});
