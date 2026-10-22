import { describe, expect, it } from "vitest";
import { SAMPLE_DOMAIN, autoFillSampleVariables, compileEmailTemplate, detectImportFormat, evaluateDispatchPreflight, importTemplate, ImportError, type EmailTemplate } from "../src";

const MJML = `<mjml>
  <mj-head>
    <mj-title>Welcome to Acme, {{ user.firstName }}!</mj-title>
    <mj-preview>Your account is ready</mj-preview>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
      <mj-button background-color="#4f46e5" />
    </mj-attributes>
    <mj-style>.x { color: red }</mj-style>
  </mj-head>
  <mj-body background-color="#f4f4f5">
    <mj-section background-color="#ffffff">
      <mj-column>
        <mj-image src="https://cdn.acme.test/logo.png" alt="Acme" width="140px" href="https://acme.test" />
        <mj-text font-size="24px"><h1>Welcome, {{ user.firstName }}</h1></mj-text>
        <mj-text>Thanks for joining. <b>Here</b> is what to do next:<br/>Read our <a href="https://acme.test/docs">docs</a> and say hi.</mj-text>
        <mj-spacer height="10px" />
        <mj-button href="{{ dashboardUrl }}">Open your dashboard</mj-button>
        <mj-divider border-color="#eee" />
      </mj-column>
    </mj-section>
    <mj-section>
      <mj-column><mj-text>Plan</mj-text></mj-column>
      <mj-column><mj-text>Pro</mj-text></mj-column>
    </mj-section>
    <mj-section>
      <mj-column>
        <mj-table>
          <tr><td>Plan</td><td>{{plan}}</td></tr>
          <tr><td>Seats</td><td>{{seats}}</td></tr>
        </mj-table>
        <mj-raw><div>custom</div></mj-raw>
        <mj-social><mj-social-element name="twitter" href="https://twitter.com/acme" /></mj-social>
        <mj-text>Acme Inc, 1 Main St<br/><a href="{{unsubscribe_url}}">Unsubscribe</a> · © 2026 Acme</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

const REACT = `import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components";
import * as React from "react";

interface WelcomeProps {
  userName?: string;
  dashboardUrl?: string;
  seats?: number;
}

const baseUrl = process.env.VERCEL_URL ? \`https://\${process.env.VERCEL_URL}\` : "";

export const Welcome = ({ userName, dashboardUrl, seats }: WelcomeProps) => (
  <Html>
    <Head />
    <Preview>Welcome to Acme, {userName}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Img src={\`\${baseUrl}/static/logo.png\`} width="120" height="40" alt="Acme" />
        <Heading style={h1}>Welcome, {userName}!</Heading>
        <Text style={text}>You have {seats} seats on the Pro plan. {" "}
          Read the <Link href="https://acme.test/docs">docs</Link>.</Text>
        <Section style={btnContainer}>
          <Button style={button} href={dashboardUrl}>Open dashboard</Button>
        </Section>
        <Hr />
        {items.map((i) => <Text key={i}>{i}</Text>)}
        <CustomThing foo="bar" />
        <Text style={footer}>Acme Inc, 1 Main St, SF · <Link href="https://acme.test/unsubscribe">Unsubscribe</Link></Text>
      </Container>
    </Body>
  </Html>
);

Welcome.PreviewProps = { userName: "Alan", dashboardUrl: "https://acme.test/app", seats: 5 } as WelcomeProps;
export default Welcome;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, 'Segoe UI', sans-serif" };
const container = { margin: "0 auto", padding: "20px 0 48px", width: "560px", backgroundColor: "#fafafa" };
const h1 = { fontSize: "24px" };
const text = { fontSize: "14px" };
const button = { backgroundColor: "#5e6ad2", borderRadius: "3px", color: "#fff", padding: "12px 20px" };
const btnContainer = { textAlign: "center" as const };
const footer = { color: "#8898aa", fontSize: "12px" };
`;

const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Your invoice {{invoiceNumber}}</title><style>body{margin:0}</style></head>
<body style="background-color:#f6f9fc;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">Invoice {{invoiceNumber}} is ready&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table align="center" role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:37.5em;background-color:#ffffff;margin:0 auto">
<tbody><tr style="width:100%"><td>
  <table width="100%"><tr><td><img alt="Acme" src="https://cdn.acme.test/logo.png" width="96" style="display:block;outline:none;border:none"></td>
  <td align="right"><a href="https://acme.test/invoices/{{invoiceNumber}}" target="_blank">View online</a></td></tr></table>
  <h2 style="font-size:20px">Invoice {{invoiceNumber}}</h2>
  <p style="font-size:14px;line-height:24px">Hi {{customerName}},<br>thanks for your business. Your invoice is below.</p>
  <table width="100%" style="border:1px solid #eee"><tbody>
    <tr><td>Pro plan</td><td>$49.00</td></tr>
    <tr><td>Extra seats</td><td>$20.00</td></tr>
    <tr><td>Total</td><td>$69.00</td></tr>
  </tbody></table>
  <a href="{{payUrl}}" target="_blank" style="background-color:#000;border-radius:3px;color:#fff;font-size:14px;text-decoration:none;display:inline-block;padding:12px 20px">Pay now</a>
  <hr style="border:none;border-top:1px solid #eaeaea">
  <p style="font-size:30px;letter-spacing:8px;font-family:monospace">{{verifyCode}}</p>
  <ul><li>Net 30</li><li>Wire accepted</li></ul>
  <p style="font-size:12px;color:#8898aa">Acme Inc, 1 Main St<br><a href="{{unsubscribeUrl}}">Unsubscribe</a> &copy; 2026</p>
  <img src="https://track.acme.test/open.gif" width="1" height="1" alt="">
</td></tr></tbody></table></body></html>`;

const clean = (t: EmailTemplate) => ({ ...t, blocks: t.blocks.map((b) => ({ ...b })) });
const types = (t: EmailTemplate): string[] => t.blocks.map((b) => b.type);

describe("format detection", () => {
  it("recognises MJML, React Email and HTML", () => {
    expect(detectImportFormat(MJML)).toBe("mjml");
    expect(detectImportFormat(REACT)).toBe("react");
    expect(detectImportFormat(HTML)).toBe("html");
    expect(detectImportFormat("<p>hi</p>")).toBe("html");
  });
});

describe("MJML import", () => {
  const r = importTemplate(MJML, { id: "welcome_mjml" });
  it("maps head, theme and blocks", () => {
    expect(r.format).toBe("mjml");
    const t = clean(r.template);
    expect(t).toMatchObject({ id: "welcome_mjml", name: "Welcome to Acme, user_firstName!", subject: "Welcome to Acme, {{user_firstName}}!", preheader: "Your account is ready", theme: { accentColor: "#4f46e5", canvasColor: "#f4f4f5", cardColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" } });
    expect(types(r.template)).toEqual(["image", "heading", "paragraph", "button", "divider", "paragraph", "paragraph", "key_value", "paragraph", "footer"]);
    expect(r.template.blocks[0]).toMatchObject({ type: "image", srcTemplate: "https://cdn.acme.test/logo.png", alt: "Acme", hrefTemplate: "https://acme.test", width: 140 });
    expect(r.template.blocks[1]).toMatchObject({ type: "heading", text: "Welcome, {{user_firstName}}", level: "h1" });
    expect(r.template.blocks[2]).toMatchObject({ type: "paragraph", text: expect.stringContaining("docs (https://acme.test/docs)") });
    expect(r.template.blocks[3]).toMatchObject({ type: "button", label: "Open your dashboard", urlTemplate: "{{dashboardUrl}}", style: "primary" });
    expect(r.template.blocks[7]).toMatchObject({ type: "key_value", rows: [{ label: "Plan", valueTemplate: "{{plan}}" }, { label: "Seats", valueTemplate: "{{seats}}" }] });
    expect(r.template.blocks[9]).toMatchObject({ type: "footer", companyAddress: expect.stringContaining("Acme Inc, 1 Main St") });
  });
  it("declares typed variables from the tokens it found", () => {
    const v = Object.fromEntries(r.template.variables.map((x) => [x.key, x.type]));
    expect(v).toMatchObject({ user_firstName: "string", dashboardUrl: "url", plan: "string", seats: "string" });
  });
  it("explains what it could not carry over", () => {
    const w = r.warnings.join("\n");
    expect(w).toMatch(/mj-raw/);
    expect(w).toMatch(/Social icons/);
    expect(w).toMatch(/2 columns/);
    expect(w).toMatch(/user\.firstName/);
  });
  it("produces a template that passes the real pre-flight gate", async () => {
    const t = r.template;
    const pre = await evaluateDispatchPreflight({ to: "a@example.org", variables: autoFillSampleVariables(t, {}) }, { template: t, domain: SAMPLE_DOMAIN });
    expect(pre.checks.filter((c) => c.severity === "block").map((c) => c.message)).toEqual([]);
  });
});

describe("React Email import (JSX read statically)", () => {
  const r = importTemplate(REACT, { id: "welcome_react" });
  it("maps components to blocks, props to variables and PreviewProps to samples", () => {
    const t = r.template;
    expect(t.preheader).toBe("Welcome to Acme, {{userName}}");
    expect(t.name).toBe("Welcome");
    expect(t.theme).toMatchObject({ accentColor: "#5e6ad2", canvasColor: "#ffffff", cardColor: "#fafafa" });
    expect(types(t)).toEqual(["image", "heading", "paragraph", "button", "divider", "footer"]);
    expect(t.blocks[0]).toMatchObject({ type: "image", alt: "Acme", width: 120, srcTemplate: "{{baseUrl}}/static/logo.png" });
    expect(t.blocks[1]).toMatchObject({ type: "heading", text: "Welcome, {{userName}}!" });
    expect(t.blocks[2]).toMatchObject({ type: "paragraph", text: expect.stringContaining("You have {{seats}} seats on the Pro plan.") });
    expect(t.blocks[2]).toMatchObject({ text: expect.stringContaining("docs (https://acme.test/docs)") });
    expect(t.blocks[3]).toMatchObject({ type: "button", label: "Open dashboard", urlTemplate: "{{dashboardUrl}}", style: "primary" });
    expect(t.blocks[5]).toMatchObject({ type: "footer", companyAddress: "Acme Inc, 1 Main St, SF" });
    const v = Object.fromEntries(t.variables.map((x) => [x.key, [x.type, x.sampleValue]]));
    expect(v).toMatchObject({ userName: ["string", "Alan"], dashboardUrl: ["url", "https://acme.test/app"], seats: ["number", 5], baseUrl: ["url", expect.stringMatching(/^https:\/\/example\.com/)] });
  });
  it("reports dynamic expressions and custom components instead of guessing", () => {
    const w = r.warnings.join("\n");
    expect(w).toMatch(/items\.map/);
    expect(w).toMatch(/<CustomThing>/);
  });
  it("never executes the file: code in the source is inert", () => {
    const evil = `import {Html,Text} from "@react-email/components";\nglobalThis.PWNED = true; process.exit(1);\nexport default () => (<Html><Text>{require("fs").readFileSync("/etc/passwd")}</Text><Text>safe</Text></Html>);`;
    const t = importTemplate(evil).template;
    expect(t.blocks).toMatchObject([{ type: "paragraph", text: "safe" }]);
    expect((globalThis as Record<string, unknown>).PWNED).toBeUndefined();
  });
  it("accepts a bare component without Html and rejects source with no JSX", () => {
    expect(importTemplate(`export default function X(){ return (<Section><Heading>Hi</Heading></Section>); }`, { format: "react" }).template.blocks[0]).toMatchObject({ type: "heading", text: "Hi" });
    expect(() => importTemplate("const a = 1;", { format: "react" })).toThrow(/No JSX/);
  });
});

describe("HTML import (also React Email render() output)", () => {
  const r = importTemplate(HTML, { id: "invoice_html", category: "Billing" });
  it("walks layout tables, finds the preheader, skips tracking pixels and rebuilds structure", () => {
    const t = r.template;
    expect(t).toMatchObject({ id: "invoice_html", name: "Your invoice invoiceNumber", category: "Billing", subject: "Your invoice {{invoiceNumber}}", preheader: "Invoice {{invoiceNumber}} is ready", theme: { canvasColor: "#f6f9fc", cardColor: "#ffffff" } });
    expect(types(t)).toEqual(["image", "paragraph", "heading", "paragraph", "line_items", "button", "divider", "otp_code", "paragraph", "footer"]);
    expect(t.blocks[0]).toMatchObject({ type: "image", srcTemplate: "https://cdn.acme.test/logo.png", width: 96, align: "left" });
    expect(t.blocks[1]).toMatchObject({ type: "paragraph", text: "View online (https://acme.test/invoices/{{invoiceNumber}})" });
    expect(t.blocks[4]).toMatchObject({ type: "line_items", items: [{ description: "Pro plan", amountTemplate: "$49.00" }, { description: "Extra seats", amountTemplate: "$20.00" }], totalLabel: "Total", totalTemplate: "$69.00" });
    expect(t.blocks[5]).toMatchObject({ type: "button", label: "Pay now", urlTemplate: "{{payUrl}}", style: "primary" });
    expect(t.blocks[7]).toMatchObject({ type: "otp_code", variableKey: "verifyCode" });
    expect(t.blocks[8]).toMatchObject({ type: "paragraph", text: "• Net 30\n• Wire accepted" });
    expect(t.blocks[9]).toMatchObject({ type: "footer", companyAddress: "Acme Inc, 1 Main St\n© 2026" });
    expect(t.blocks.some((b) => b.type === "image" && /track\.acme/.test(b.srcTemplate))).toBe(false);
    expect(r.template.variables.find((x) => x.key === "verifyCode")?.type).toBe("otp_code");
  });
  it("compiles to HTML that contains no leftover markup from the source", () => {
    const t = r.template;
    const c = compileEmailTemplate(t, autoFillSampleVariables(t, {}));
    expect(c.html).toContain("<img src=\"https://cdn.acme.test/logo.png\"");
    expect(c.html).not.toContain("track.acme.test");
    expect(c.text).toContain("Total: $69.00");
  });
});

describe("token normalisation and errors", () => {
  it("converts Mailchimp and Handlebars syntax and drops template logic with a warning", () => {
    const r = importTemplate(`<html><body><p>Hi *|FNAME|*, {{#if vip}}VIP{{/if}} {{ order.total | money }} {{{raw}}}</p></body></html>`);
    expect(r.template.blocks[0]).toMatchObject({ type: "paragraph", text: "Hi {{fname}}, VIP {{order_total}} {{raw}}" });
    expect(r.warnings.join("\n")).toMatch(/Template logic/);
    expect(r.template.variables.map((v) => v.key).sort()).toEqual(["fname", "order_total", "raw"]);
  });
  it("throws a plain ImportError for empty or unusable input", () => {
    expect(() => importTemplate("   ")).toThrow(ImportError);
    expect(() => importTemplate("<html><body><style>x{}</style></body></html>")).toThrow(/Nothing importable/);
    expect(() => importTemplate("<mj-body></mj-body>", { format: "mjml" })).toThrow(/No <mjml>/);
    expect(() => importTemplate("x".repeat(2_000_001))).toThrow(/larger than 2 MB/);
  });
  it("cuts oversized text to the template limits instead of failing", () => {
    const r = importTemplate(`<html><body><p>${"word ".repeat(2000)}</p></body></html>`);
    expect(r.template.blocks[0].type).toBe("paragraph");
  });
  it("survives hostile markup", () => {
    const hostile = "<div>".repeat(5000) + "<p onclick=alert(1)>hi<script>alert(1)</script></p>" + "<a href=javascript:alert(1)>x</a>";
    const r = importTemplate(hostile);
    expect(JSON.stringify(r.template)).not.toContain("onclick");
    expect(r.template.blocks.length).toBeGreaterThan(0);
  });
});
