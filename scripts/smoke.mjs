// End-to-end smoke test of the PUBLISHED artifact: packs the packages, installs the tarballs into a clean directory
// and drives the real `sealpost` binary: init → validate → dns → compile → send (raw SMTP to the local sink) → receipt → studio → ledger.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const fail = (msg) => {
  console.error(`\n✖ smoke test failed: ${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const check = (cond, msg) => {
  if (!cond) fail(msg);
  console.log(`  ✔ ${msg}`);
};

const work = mkdtempSync(join(tmpdir(), "sealpost-smoke-"));
console.log(`smoke: ${work}`);
const pack = run("npm", ["pack", "-w", "@sealpost/core", "-w", "@sealpost/react", "-w", "@sealpost/sdk", "-w", "@sealpost/cli", "--pack-destination", work]);
if (pack.code !== 0) fail(`npm pack failed\n${pack.out}`);
const tars = readdirSync(work).filter((f) => f.endsWith(".tgz")).map((f) => join(work, f));
check(tars.length === 4, "packed 4 tarballs");

const app = join(work, "app");
run("mkdir", ["-p", app]);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
const install = run("npm", ["install", "--no-audit", "--no-fund", ...tars, "zod"], { cwd: app });
if (install.code !== 0) fail(`npm install failed\n${install.out}`);
const bin = join(app, "node_modules", "@sealpost", "cli", "dist", "cli.js");
const ew = (...args) => run("node", [bin, ...args], { cwd: app });
const OTP = "magic_link_otp_verification";

check(ew("--version").out.trim().match(/^\d+\.\d+\.\d+/) !== null, "sealpost --version");
check(ew("init", "proj", "--name", "smoke-project").code === 0, "init scaffolds templates and generates the DKIM + receipt keys");
check(ew("validate", "proj").code === 0, "validate passes");
const dns = ew("dns", "proj", "--json");
check(dns.code === 0 && JSON.parse(dns.out).map((r) => r.purpose).join() === "SPF,DKIM,DMARC,MX", "dns prints SPF, DKIM, DMARC and MX records");
check(ew("compile", OTP, "--dir", "proj").code === 2, "compile blocks a missing required variable (EW-101, exit 2)");
const compiled = ew("compile", OTP, "--dir", "proj", "--auto-fill", "--mime", "--json");
check(compiled.code === 0 && /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed/.test(JSON.parse(compiled.out).rawMime) && JSON.parse(compiled.out).dkim.ok, "compile --mime emits a DKIM-signed message that verifies");
check(ew("compile", OTP, "--dir", "proj", "--auto-fill", "--to", "a@b.co\r\nBcc: v@e.test").code === 2, "header injection is blocked (EW-102)");

const sent = ew("send", OTP, "--dir", "proj", "--to", "user@example.org", "--auto-fill", "--json");
const out = sent.code === 0 ? JSON.parse(sent.out) : {};
check(out.status === "delivered" && /^evw_/.test(out.receiptId ?? ""), "send delivers over raw SMTP to the loopback sink and seals an evw_ receipt");
check(ew("send", OTP, "--dir", "proj", "--to", "user@example.org", "--auto-fill").code === 2, "an identical second send is blocked (EW-108)");
const inbox = join(app, "proj", ".sealpost", "inbox");
const eml = readdirSync(inbox).find((f) => f.endsWith(".eml"));
const meta = JSON.parse(readFileSync(join(inbox, readdirSync(inbox).find((f) => f.endsWith(".json"))), "utf8"));
check(Boolean(eml) && meta.dkim?.ok === true, "the captured message carries a DKIM signature that the sink verified");
writeFileSync(join(work, "r.evw.json"), JSON.stringify({ token: out.receipt }));
check(ew("receipt", "verify", join(work, "r.evw.json"), "--eml", join(inbox, eml)).code === 0, "receipt verify: signature and message bytes match");

const port = 4900 + Math.floor(Math.random() * 90);
const server = spawn("node", [bin, "studio", "proj", "--port", String(port)], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", () => undefined);
server.stderr.on("data", () => undefined);
try {
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(100);
    up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
  }
  check(up, "studio server starts");
  check((await (await fetch(base)).text()).includes("Sealpost"), "bundled Studio UI is served");
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const same = await Promise.all(Array.from({ length: 6 }, () => post("/api/send", { templateId: "workspace_team_invitation", to: "dedupe@example.org", autoFill: true })));
  check(same.filter((r) => r.status === 201).length === 1, "6 concurrent identical sends dedupe to exactly one delivery");
  const many = await Promise.all(Array.from({ length: 6 }, (_, i) => post("/api/send", { templateId: "usage_cap_circuit_warning", to: `u${i}@example.org`, autoFill: true })));
  check(many.every((r) => r.status === 201), "concurrent sends to different recipients all land");
  const { Sealpost } = await import(pathToFileURL(join(app, "node_modules", "@sealpost", "sdk", "dist", "index.js")).href);
  const mail = new Sealpost({ apiKey: "unused-on-loopback", baseUrl: base });
  const viaSdk = await mail.emails.send({ template: "workspace_team_invitation", to: "sdk@example.org", autoFill: true });
  check(viaSdk.error === null && viaSdk.data.receipt.startsWith("evw_"), "@sealpost/sdk sends through the packaged server and returns a receipt");
  const batch = await mail.emails.batch([{ template: "usage_cap_circuit_warning", to: "b1@example.org", autoFill: true }, { template: "nope", to: "b2@example.org" }]);
  check(batch.data.accepted === 1 && batch.data.rejected === 1, "@sealpost/sdk batch reports per-email results");
  const mcp = spawn("node", [bin, "mcp", "--dir", "proj"], { cwd: app, stdio: ["pipe", "pipe", "pipe"] });
  const replies = [];
  let buf = "";
  mcp.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  mcp.stderr.on("data", () => undefined);
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  for (let i = 0; i < 50 && replies.length < 2; i++) await sleep(100);
  mcp.kill("SIGTERM");
  check(replies[0]?.result?.serverInfo?.name === "sealpost" && replies[1]?.result?.tools?.some((t) => t.name === "list_templates") && !replies[1].result.tools.some((t) => t.name === "send_email"), "sealpost mcp speaks MCP and keeps sending disabled by default");
  const spec = await (await fetch(`${base}/api/openapi.json`)).json();
  check(spec.openapi === "3.1.0", "OpenAPI document is served");
} finally {
  server.kill("SIGTERM");
}
check(ew("ledger", "verify", "proj").code === 0, "ledger verifies (chain + every receipt, no forks)");
console.log("\n✔ smoke test passed");
