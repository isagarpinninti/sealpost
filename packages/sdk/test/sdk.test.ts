import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { Sealpost, verifyWebhook } from "../src";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function fake(handler: (req: IncomingMessage, body: string) => { status: number; json: unknown } | "hang"): Promise<{ url: string; seen: Array<{ method: string; url: string; auth: string; body: string; headers: IncomingMessage["headers"] }> }> {
  const seen: Array<{ method: string; url: string; auth: string; body: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body, headers: req.headers });
      const r = handler(req, body);
      if (r === "hang") return;
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("@sealpost/sdk", () => {
  it("sends with a bearer key and maps the response", async () => {
    const f = await fake(() => ({ status: 201, json: { ok: true, status: "delivered", messageId: "<m@x>", receipt: { token: "evw_abc", receiptId: "evw_1" }, preflight: { gate: "CLEAR", score: 100, checks: [], idempotencyKey: "k" } } }));
    const mail = new Sealpost({ apiKey: "evk_test", baseUrl: f.url });
    const { data, error } = await mail.emails.send({ template: "t", to: "a@b.co", variables: { x: 1 } });
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "delivered", messageId: "<m@x>", receipt: "evw_abc", receiptId: "evw_1" });
    expect(f.seen[0]).toMatchObject({ method: "POST", url: "/api/send", auth: "Bearer evk_test" });
    expect(JSON.parse(f.seen[0].body)).toEqual({ templateId: "t", to: "a@b.co", variables: { x: 1 } });
  });

  it("returns a blocked send as an error carrying the gate result, never throws", async () => {
    const pre = { gate: "BLOCKED", score: 40, checks: [], idempotencyKey: "k" };
    const f = await fake(() => ({ status: 403, json: { ok: false, error: "Blocked by the pre-flight gate", code: "preflight_blocked", preflight: pre } }));
    const r = await new Sealpost({ apiKey: "k", baseUrl: f.url }).emails.send({ template: "t", to: "a@b.co" });
    expect(r.data).toBeNull();
    expect(r.error).toMatchObject({ status: 403, code: "preflight_blocked", preflight: { gate: "BLOCKED" } });
  });

  it("reports network failures and timeouts as errors", async () => {
    const down = await new Sealpost({ apiKey: "k", baseUrl: "http://127.0.0.1:1" }).stats.get();
    expect(down.error?.status).toBe(0);
    const f = await fake(() => "hang");
    const slow = await new Sealpost({ apiKey: "k", baseUrl: f.url, timeoutMs: 100 }).stats.get();
    expect(slow.error?.message).toMatch(/timed out/);
  });

  it("encodes suppression removal and requires an api key", async () => {
    const f = await fake(() => ({ status: 200, json: { ok: true, suppressions: [] } }));
    const mail = new Sealpost({ apiKey: "k", baseUrl: `${f.url}/` });
    await mail.suppressions.remove("a+b@x.io");
    expect(f.seen[0].url).toBe("/api/suppressions?email=a%2Bb%40x.io");
    expect(f.seen[0].method).toBe("DELETE");
    expect(() => new Sealpost({ apiKey: "" })).toThrow();
  });

  it("verifies webhook signatures against the raw body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "email.delivered" });
    const t = 1_700_000_000;
    const header = `t=${t},v1=${createHmac("sha256", "whsec").update(`${t}.${body}`).digest("hex")}`;
    expect(await verifyWebhook("whsec", body, header, { nowSeconds: t + 10 })).toEqual({ ok: true });
    expect(await verifyWebhook("whsec", `${body} `, header, { nowSeconds: t + 10 })).toEqual({ ok: false, reason: "mismatch" });
    expect(await verifyWebhook("whsec", body, header, { nowSeconds: t + 4000 })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyWebhook("whsec", body, "x")).toEqual({ ok: false, reason: "malformed" });
    expect(await new Sealpost({ apiKey: "k" }).webhooks.verify("whsec", body, header, { nowSeconds: t })).toEqual({ ok: true });
  });

  it("maps audiences, broadcasts and domains onto the REST API", async () => {
    const f = await fake((req) => {
      if (req.url === "/api/broadcasts") return { status: 201, json: { ok: true, broadcast: { id: "brd_1", status: "scheduled" } } };
      if (req.url?.endsWith("/check")) return { status: 200, json: { ok: false, domain: "a.io", results: [{ purpose: "SPF", status: "missing" }] } };
      return { status: 200, json: { ok: true, added: 1, updated: 0, total: 1, rejected: [] } };
    });
    const mail = new Sealpost({ apiKey: "k", baseUrl: f.url });
    const b = await mail.broadcasts.create({ name: "n", audienceId: "aud_1", template: "t", scheduledAt: new Date("2030-01-01T00:00:00Z"), ratePerMinute: 120 });
    expect(b.data?.id).toBe("brd_1");
    expect(JSON.parse(f.seen[0].body)).toMatchObject({ templateId: "t", scheduledAtIso: "2030-01-01T00:00:00.000Z", ratePerMinute: 120 });
    const c = await mail.audiences.addContacts("aud_1", [{ email: "a@b.co", name: "A" }]);
    expect(c.data).toMatchObject({ added: 1, total: 1 });
    expect(f.seen[1].url).toBe("/api/audiences/aud_1/contacts");
    const d = await mail.domains.check("a.io");
    expect(d.data).toMatchObject({ ok: false, domain: "a.io" });
  });

  it("sends the idempotency key as a header, flags replays, and surfaces the request id", async () => {
    const f = await fake((req) => (req.url === "/api/send" ? { status: 201, json: { ok: true, id: "em_1", status: "delivered", messageId: "<m>", preflight: {} } } : { status: 409, json: { ok: false, error: "clash", code: "idempotency_key_reuse", requestId: "req_abc" } }));
    const mail = new Sealpost({ apiKey: "k", baseUrl: f.url });
    const r = await mail.emails.send({ template: "t", to: "a@b.co", idempotencyKey: "order-1", tags: [{ name: "c", value: "v" }], metadata: { u: "1" } });
    expect(r.data).toMatchObject({ id: "em_1", replayed: false });
    expect(f.seen[0].headers["idempotency-key"]).toBe("order-1");
    expect(JSON.parse(f.seen[0].body)).toEqual({ templateId: "t", to: "a@b.co", tags: [{ name: "c", value: "v" }], metadata: { u: "1" } });
    const bad = await mail.emails.get("em_9");
    expect(bad.error).toMatchObject({ status: 409, code: "idempotency_key_reuse", requestId: "req_abc" });
  });

  it("lists emails with filters and page cursors", async () => {
    const f = await fake(() => ({ status: 200, json: { ok: true, data: [{ id: "em_1" }], hasMore: true, nextCursor: "em_1" } }));
    const mail = new Sealpost({ apiKey: "k", baseUrl: f.url });
    const page = await mail.emails.list({ status: "bounced", tag: "campaign:welcome", limit: 5, since: new Date("2030-01-01T00:00:00Z"), before: "em_9" });
    expect(page.data).toMatchObject({ hasMore: true, nextCursor: "em_1" });
    expect(f.seen[0].url).toBe("/api/emails?status=bounced&tag=campaign%3Awelcome&since=2030-01-01T00%3A00%3A00.000Z&limit=5&before=em_9");
  });

  it("lists and reads received mail, and downloads attachments as bytes", async () => {
    const f = await fake((req) => {
      if (req.url?.includes("/attachments/")) return { status: 200, json: "BIN" };
      if (req.url === "/api/inbound/in_missing") return { status: 404, json: { ok: false, error: "No such received message", code: "not_found" } };
      if (req.url?.startsWith("/api/inbound?")) return { status: 200, json: { ok: true, data: [{ id: "in_1", kind: "message" }], hasMore: false, nextCursor: null } };
      return { status: 200, json: { ok: true, id: "in_1", subject: "hi", text: "body", headers: [] } };
    });
    const mail = new Sealpost({ apiKey: "k", baseUrl: f.url });
    const page = await mail.inbound.list({ kind: "bounce", q: "refund", since: new Date("2030-01-01T00:00:00Z"), limit: 3 });
    expect(page.data?.data[0].id).toBe("in_1");
    expect(f.seen[0].url).toBe("/api/inbound?q=refund&kind=bounce&since=2030-01-01T00%3A00%3A00.000Z&limit=3");
    expect((await mail.inbound.get("in_1")).data).toMatchObject({ subject: "hi", text: "body" });
    expect((await mail.inbound.get("in_missing")).error).toMatchObject({ status: 404, code: "not_found" });
    const att = await mail.inbound.attachment("in_1", 0);
    expect(att.data?.bytes).toBeInstanceOf(Uint8Array);
    expect(f.seen.at(-1)?.url).toBe("/api/inbound/in_1/attachments/0");
    const reply = await mail.emails.send({ template: "t", to: "a@b.co", inReplyTo: "in_1" });
    expect(JSON.parse(f.seen.at(-1)?.body ?? "{}")).toMatchObject({ inReplyTo: "in_1" });
    void reply;
  });

  it("schedules a send, lists and cancels scheduled sends, and mints unsubscribe links", async () => {
    const f = await fake((req) => {
      if (req.url === "/api/send") return { status: 202, json: { ok: true, id: "sch_1", status: "scheduled", scheduledAt: "2030-01-01T00:00:00.000Z" } };
      if (req.url === "/api/scheduled") return { status: 200, json: { ok: true, scheduled: [{ id: "sch_1", status: "scheduled" }] } };
      if (req.url === "/api/unsubscribe-link") return { status: 200, json: { ok: true, url: "https://m.example.com/u/abc" } };
      return { status: 200, json: { ok: true, scheduled: { id: "sch_1", status: "cancelled" } } };
    });
    const mail = new Sealpost({ apiKey: "k", baseUrl: f.url });
    const r = await mail.emails.send({ template: "t", to: "a@b.co", scheduledAt: new Date("2030-01-01T00:00:00Z") });
    expect(r.data).toMatchObject({ status: "scheduled", id: "sch_1", scheduledAt: "2030-01-01T00:00:00.000Z" });
    expect(JSON.parse(f.seen[0].body).scheduledAt).toBe("2030-01-01T00:00:00.000Z");
    expect((await mail.scheduled.list()).data).toHaveLength(1);
    expect((await mail.scheduled.cancel("sch_1")).data?.status).toBe("cancelled");
    expect(f.seen.at(-1)).toMatchObject({ method: "DELETE", url: "/api/scheduled/sch_1" });
    expect((await mail.unsubscribeLink("a@b.co")).data).toBe("https://m.example.com/u/abc");
  });
});
