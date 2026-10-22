/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON in integration tests */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startServer, loadProject, type RunningServer } from "../src";
import { readSuppressions } from "../src/store";
import { createUnsubToken, verifyUnsubToken } from "../src/unsub";
import type { Io } from "../src/ui";

const io: Io = { out: () => undefined, err: () => undefined, color: false, stdin: async () => "" };
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function project(patch: (cfg: any) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sealpost-unsub-"));
  expect(await run(["init", dir, "--name", "u", "--domain", "mail.example.com"], io)).toBe(0);
  const p = join(dir, "sealpost.config.json");
  const cfg = JSON.parse(await readFile(p, "utf8"));
  patch(cfg);
  await writeFile(p, JSON.stringify(cfg));
  return dir;
}
const hosted = (cfg: any): void => {
  cfg.unsubscribe = { hosted: true };
  delete cfg.domain.unsubscribeUrl;
  cfg.domain.trackingBaseUrl = "https://mail.example.com";
};
async function serve(dir: string): Promise<RunningServer> {
  const s = await startServer({ dir, port: 0 });
  closers.push(() => s.close());
  return s;
}
const OTP = "magic_link_otp_verification";
const vars = { userName: "Ada", otpCode: "482913", signInUrl: "https://app.example.com/in" };
const send = async (s: RunningServer, to: string, extra: Record<string, unknown> = {}): Promise<any> => (await fetch(`${s.url}/api/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: OTP, to, variables: vars, ...extra }) })).json();
const inboxRaw = async (s: RunningServer): Promise<string> => {
  const list = (await (await fetch(`${s.url}/api/inbox`)).json()).messages as any[];
  return ((await (await fetch(`${s.url}/api/inbox/${list[0].id}`)).json()) as any).raw as string;
};

describe("unsubscribe tokens", () => {
  it("round-trips, and rejects tampering, another secret and malformed tokens", () => {
    const secret = Buffer.alloc(32, 7);
    const t = createUnsubToken(secret, { e: "a@b.co", d: "mail.example.com", i: "em_1" });
    expect(verifyUnsubToken(secret, t)).toEqual({ e: "a@b.co", d: "mail.example.com", i: "em_1" });
    const [payload, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ e: "victim@b.co", d: "mail.example.com" })).toString("base64url");
    expect(verifyUnsubToken(secret, `${forged}.${mac}`)).toBeNull();
    expect(verifyUnsubToken(Buffer.alloc(32, 8), t)).toBeNull();
    for (const bad of ["", "x", `${payload}.`, `${payload}.${mac}.extra`, `${payload}.${mac.slice(1)}`, "a".repeat(2000)]) expect(verifyUnsubToken(secret, bad)).toBeNull();
  });
});

describe("hosted unsubscribe", () => {
  it("puts a per-recipient link in the footer and the headers, signed by DKIM", async () => {
    const s = await serve(await project(hosted));
    const r = await send(s, "ada@example.org");
    expect(r.status).toBe("delivered");
    const raw = await inboxRaw(s);
    const url = /List-Unsubscribe: <(https:\/\/mail\.example\.com\/u\/[^>]+)>/.exec(raw.replace(/\r\n[ \t]/g, ""))?.[1] ?? "";
    expect(url).toMatch(/^https:\/\/mail\.example\.com\/u\/[\w-]+\.[\w-]+$/);
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const inbox = (await (await fetch(`${s.url}/api/inbox`)).json()).messages as any[];
    expect(inbox[0].dkim.ok).toBe(true);
    const different = await send(s, "bo@example.org", { variables: { ...vars, otpCode: "111111" } });
    expect(different.status).toBe("delivered");
    const raw2 = await inboxRaw(s);
    expect(/List-Unsubscribe: <([^>]+)>/.exec(raw2.replace(/\r\n[ \t]/g, ""))?.[1]).not.toBe(url);
  });

  it("GET never changes anything; POST unsubscribes (also as RFC 8058 one-click); undo works", async () => {
    const dir = await project(hosted);
    const s = await serve(dir);
    const out = await send(s, "ada@example.org");
    const token = /\/u\/([\w.-]+)>/.exec((await inboxRaw(s)).replace(/\r\n[ \t]/g, ""))?.[1] ?? "";
    const get = await fetch(`${s.url}/u/${token}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("ada@example.org");
    expect(await readSuppressions(await loadProject(dir))).toEqual([]);

    const post = await fetch(`${s.url}/u/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(post.status).toBe(200);
    expect(await post.text()).toMatch(/re unsubscribed/);
    expect(await readSuppressions(await loadProject(dir))).toEqual([expect.objectContaining({ email: "ada@example.org", reason: "unsubscribed" })]);
    await fetch(`${s.url}/u/${token}`, { method: "POST" });
    expect((await readSuppressions(await loadProject(dir))).length).toBe(1);

    const blocked = await fetch(`${s.url}/api/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId: OTP, to: "ada@example.org", variables: { ...vars, otpCode: "222222" } }) });
    expect(blocked.status).toBe(403);
    const rec = (await (await fetch(`${s.url}/api/emails/${out.id}`)).json()) as any;
    expect(rec.unsubscribed).toBe(true);
    expect(rec.events.at(-1)).toMatchObject({ type: "unsubscribed" });

    const undo = await fetch(`${s.url}/u/${token}/resubscribe`, { method: "POST" });
    expect(await undo.text()).toContain("subscribed again");
    expect(await readSuppressions(await loadProject(dir))).toEqual([]);
  });

  it("does not let an unsubscribe link undo a bounce, and rejects forged or unknown links", async () => {
    const dir = await project(hosted);
    const s = await serve(dir);
    await send(s, "ada@example.org");
    const token = /\/u\/([\w.-]+)>/.exec((await inboxRaw(s)).replace(/\r\n[ \t]/g, ""))?.[1] ?? "";
    const { addSuppression } = await import("@sealpost/core");
    const { writeSuppressions } = await import("../src/store");
    await writeSuppressions(await loadProject(dir), addSuppression([], { email: "ada@example.org", reason: "hard_bounce", atIso: new Date().toISOString() }));
    await fetch(`${s.url}/u/${token}/resubscribe`, { method: "POST" });
    expect((await readSuppressions(await loadProject(dir))).map((x) => x.reason)).toEqual(["hard_bounce"]);
    expect((await fetch(`${s.url}/u/${token}x`)).status).toBe(404);
    expect((await fetch(`${s.url}/u/not-a-token`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${s.url}/u/${token}`, { method: "PUT" })).status).toBe(405);
  });

  it("is off by default (a static unsubscribeUrl is used) and mints links through the API", async () => {
    const off = await serve(await project());
    await send(off, "ada@example.org");
    expect(await inboxRaw(off)).toMatch(/List-Unsubscribe: <https:\/\/app\.example\.com\/unsubscribe>/);
    const mint = await fetch(`${off.url}/api/unsubscribe-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) });
    expect([mint.status, ((await mint.json()) as any).code]).toEqual([409, "unsubscribe_not_enabled"]);

    const on = await serve(await project(hosted));
    const ok = (await (await fetch(`${on.url}/api/unsubscribe-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Mixed@Case.io" }) })).json()) as any;
    expect(ok.url).toMatch(/^https:\/\/mail\.example\.com\/u\//);
  });
});
