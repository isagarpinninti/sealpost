import { DomainProfileSchema, EmailTemplateSchema, type DomainProfile, type EmailTemplate, type EmailTemplateInput } from "../schemas/template";

const footer = { id: "footer", type: "footer", companyAddress: "Acme Platform, Inc.\n500 Market Street, San Francisco, CA 94105", unsubscribeText: "Manage email preferences" } as const;
const header = { id: "header", type: "header", brandName: "Acme Platform", badgeText: "Secure", subtitle: "Transactional message" } as const;

const magicLink: EmailTemplateInput = {
  id: "magic_link_otp_verification",
  name: "Magic Link & OTP Verification",
  version: "1.0.0",
  category: "Auth",
  description: "A 6-digit sign-in code, a one-click sign-in button and a device / IP security table.",
  subject: "{{otpCode}} is your Acme sign-in code",
  preheader: "Use this code to finish signing in. It expires in {{expiresMinutes}} minutes.",
  variables: [
    { key: "userName", label: "Recipient name", type: "string", required: true, sampleValue: "Priya" },
    { key: "otpCode", label: "One-time code", type: "otp_code", required: true, sampleValue: "482913" },
    { key: "signInUrl", label: "Sign-in link", type: "url", required: true, sampleValue: "https://app.example.com/auth/verify?token=abc123" },
    { key: "expiresMinutes", label: "Minutes until expiry", type: "number", required: false, defaultValue: 10, sampleValue: 10 },
    { key: "ipAddress", label: "Request IP", type: "string", required: false, defaultValue: "unknown", sampleValue: "203.0.113.24" },
    { key: "deviceName", label: "Device", type: "string", required: false, defaultValue: "unknown device", sampleValue: "Chrome on macOS" },
    { key: "location", label: "Approximate location", type: "string", required: false, sampleValue: "Berlin, DE" },
  ],
  blocks: [
    header,
    { id: "h1", type: "heading", text: "Your sign-in code" },
    { id: "p1", type: "paragraph", text: "Hi {{userName}}, enter this code to finish signing in. It expires in {{expiresMinutes}} minutes." },
    { id: "otp", type: "otp_code", label: "One-time code", variableKey: "otpCode", expiryNote: "Never share this code. Acme will never ask for it." },
    { id: "btn", type: "button", label: "Sign in instantly", urlTemplate: "{{signInUrl}}", style: "primary" },
    { id: "kv", type: "key_value", rows: [{ label: "Device", valueTemplate: "{{deviceName}}" }, { label: "IP address", valueTemplate: "{{ipAddress}}" }, { label: "Location", valueTemplate: "{{location}}" }], showIfVariable: "location" },
    { id: "warn", type: "callout", tone: "warn", title: "Didn't request this?", text: "Someone may have typed your email by mistake. You can safely ignore this message." },
    { id: "div", type: "divider" },
    footer,
  ],
};

const wireInvoice: EmailTemplateInput = {
  id: "enterprise_wire_invoice",
  name: "Enterprise Wire Invoice",
  version: "1.0.0",
  category: "Billing",
  description: "An itemized B2B invoice with a wire clearing reference and a PDF receipt button.",
  subject: "Invoice {{invoiceNumber}}: {{total}} due {{dueDate}}",
  preheader: "Wire instructions and your PDF receipt for invoice {{invoiceNumber}}.",
  variables: [
    { key: "customerName", label: "Customer", type: "string", required: true, sampleValue: "Globex Supplies" },
    { key: "invoiceNumber", label: "Invoice number", type: "string", required: true, sampleValue: "INV-2291" },
    { key: "platformFee", label: "Platform fee", type: "currency", required: true, sampleValue: 48000 },
    { key: "supportFee", label: "Premium support", type: "currency", required: true, sampleValue: 14000 },
    { key: "total", label: "Total due", type: "currency", required: true, sampleValue: 62000 },
    { key: "dueDate", label: "Due date", type: "string", required: true, sampleValue: "Nov 14, 2026" },
    { key: "wireReference", label: "Wire reference", type: "string", required: true, sampleValue: "WIRE-5530-GLX" },
    { key: "pdfUrl", label: "PDF receipt link", type: "url", required: true, sampleValue: "https://billing.example.com/invoices/INV-2291.pdf" },
  ],
  blocks: [
    { ...header, subtitle: "Billing" },
    { id: "h1", type: "heading", text: "Invoice {{invoiceNumber}}" },
    { id: "p1", type: "paragraph", text: "Hello {{customerName}}, here is your invoice. Please pay by wire transfer before {{dueDate}}." },
    { id: "items", type: "line_items", items: [{ description: "Platform licence, Enterprise (annual)", amountTemplate: "{{platformFee}}" }, { description: "Premium support (annual)", amountTemplate: "{{supportFee}}" }], totalLabel: "Total due", totalTemplate: "{{total}}" },
    { id: "kv", type: "key_value", rows: [{ label: "Wire reference", valueTemplate: "{{wireReference}}" }, { label: "Due date", valueTemplate: "{{dueDate}}" }] },
    { id: "btn", type: "button", label: "Download PDF receipt", urlTemplate: "{{pdfUrl}}", style: "amber" },
    { id: "div", type: "divider" },
    footer,
  ],
};

const incident: EmailTemplateInput = {
  id: "p1_incident_failover_alert",
  name: "P1 Incident Failover Alert",
  version: "1.0.0",
  category: "Incidents",
  description: "An SRE P1 alert with the affected service, replication lag and a failover runbook link.",
  subject: "[{{severity}}] {{affectedService}} degraded: failover {{failoverState}}",
  preheader: "{{incidentId}} in {{region}}: replication lag {{rpoLagSeconds}} s. Runbook inside.",
  variables: [
    { key: "severity", label: "Severity", type: "string", required: false, defaultValue: "P1", sampleValue: "P1" },
    { key: "incidentId", label: "Incident id", type: "string", required: true, sampleValue: "INC-4821" },
    { key: "affectedService", label: "Affected service", type: "string", required: true, sampleValue: "checkout-api" },
    { key: "region", label: "Region", type: "string", required: true, sampleValue: "eu-central-1" },
    { key: "rpoLagSeconds", label: "Replication lag (s)", type: "number", required: true, sampleValue: 12 },
    { key: "failoverState", label: "Failover state", type: "string", required: false, defaultValue: "pending", sampleValue: "engaged" },
    { key: "autoFailover", label: "Automatic failover engaged", type: "boolean", required: false, sampleValue: true },
    { key: "runbookUrl", label: "Runbook link", type: "url", required: true, sampleValue: "https://runbooks.example.com/RB-17" },
  ],
  theme: { accentColor: "#9f1239", canvasColor: "#f1f5f9", cardColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" },
  blocks: [
    { ...header, brandName: "Acme SRE", badgeText: "Incident", subtitle: "On-call notification" },
    { id: "h1", type: "heading", text: "{{severity}} · {{affectedService}} is degraded" },
    { id: "alert", type: "callout", tone: "rose", title: "{{incidentId}}", text: "Replication lag in {{region}} is {{rpoLagSeconds}} seconds, above the recovery-point budget." },
    { id: "auto", type: "callout", tone: "emerald", title: "Automatic failover engaged", text: "Traffic is draining to the standby region. No action is required unless the drain stalls.", showIfVariable: "autoFailover" },
    { id: "kv", type: "key_value", rows: [{ label: "Service", valueTemplate: "{{affectedService}}" }, { label: "Region", valueTemplate: "{{region}}" }, { label: "Replication lag", valueTemplate: "{{rpoLagSeconds}} s" }, { label: "Failover", valueTemplate: "{{failoverState}}" }] },
    { id: "btn", type: "button", label: "Open the failover runbook", urlTemplate: "{{runbookUrl}}", style: "primary" },
    { id: "div", type: "divider" },
    footer,
  ],
};

const invitation: EmailTemplateInput = {
  id: "workspace_team_invitation",
  name: "Workspace Team Invitation",
  version: "1.0.0",
  category: "Growth",
  description: "A role-based workspace invite with the inviter's name and an expiry notice.",
  subject: "{{inviterName}} invited you to {{workspaceName}}",
  preheader: "Join {{workspaceName}} as {{role}}. This invitation expires in {{expiresInDays}} days.",
  variables: [
    { key: "inviterName", label: "Inviter", type: "string", required: true, sampleValue: "Elena Vasquez" },
    { key: "workspaceName", label: "Workspace", type: "string", required: true, sampleValue: "Platform Engineering" },
    { key: "role", label: "Role", type: "string", required: true, sampleValue: "Admin" },
    { key: "acceptUrl", label: "Accept link", type: "url", required: true, sampleValue: "https://app.example.com/invite/9f31c2" },
    { key: "expiresInDays", label: "Days until expiry", type: "number", required: false, defaultValue: 7, sampleValue: 7 },
  ],
  blocks: [
    { ...header, subtitle: "Workspace invitation" },
    { id: "h1", type: "heading", text: "You're invited to {{workspaceName}}" },
    { id: "p1", type: "paragraph", text: "{{inviterName}} has invited you to join {{workspaceName}} with the {{role}} role." },
    { id: "btn", type: "button", label: "Accept invitation", urlTemplate: "{{acceptUrl}}", style: "primary" },
    { id: "note", type: "callout", tone: "info", title: "This invitation expires", text: "It stays valid for {{expiresInDays}} days. After that, ask {{inviterName}} to send a new one." },
    { id: "div", type: "divider" },
    footer,
  ],
};

const usageCap: EmailTemplateInput = {
  id: "usage_cap_circuit_warning",
  name: "Usage Cap Circuit Warning",
  version: "1.0.0",
  category: "Transactional",
  description: "An API or escrow quota warning at 85% utilization with an auto-negotiate link.",
  subject: "{{accountName}} has used {{utilizationPct}}% of its API cap",
  preheader: "{{usedUnits}} of {{capUnits}} units used. Raise the cap before calls are blocked.",
  variables: [
    { key: "accountName", label: "Account", type: "string", required: true, sampleValue: "Acme Corp" },
    { key: "utilizationPct", label: "Utilization (%)", type: "number", required: true, sampleValue: 85 },
    { key: "usedUnits", label: "Units used", type: "number", required: true, sampleValue: 850000 },
    { key: "capUnits", label: "Cap (units)", type: "number", required: true, sampleValue: 1000000 },
    { key: "resetDate", label: "Reset date", type: "string", required: false, defaultValue: "the 1st of next month", sampleValue: "Nov 1, 2026" },
    { key: "negotiateUrl", label: "Auto-negotiate link", type: "url", required: true, sampleValue: "https://app.example.com/billing/cap" },
  ],
  blocks: [
    { ...header, subtitle: "Usage alert" },
    { id: "h1", type: "heading", text: "{{utilizationPct}}% of your cap is used" },
    { id: "warn", type: "callout", tone: "warn", title: "Circuit breaker approaching", text: "Calls will be blocked at 100% of the cap. The cap resets on {{resetDate}}." },
    { id: "kv", type: "key_value", rows: [{ label: "Account", valueTemplate: "{{accountName}}" }, { label: "Used", valueTemplate: "{{usedUnits}} units" }, { label: "Cap", valueTemplate: "{{capUnits}} units" }] },
    { id: "btn", type: "button", label: "Auto-negotiate a higher cap", urlTemplate: "{{negotiateUrl}}", style: "amber" },
    { id: "div", type: "divider" },
    footer,
  ],
};

export const TEMPLATE_PACKS: readonly EmailTemplate[] = [magicLink, wireInvoice, incident, invitation, usageCap].map((t) => EmailTemplateSchema.parse(t));

export function getTemplatePack(id: string): EmailTemplate | undefined {
  return TEMPLATE_PACKS.find((t) => t.id === id);
}

export const SAMPLE_DOMAIN: DomainProfile = DomainProfileSchema.parse({ domain: "mail.example.com", fromName: "Acme Platform", fromEmail: "hello@mail.example.com", replyTo: "support@mail.example.com", dkimSelector: "sealpost", dmarcPolicy: "none", unsubscribeUrl: "https://app.example.com/unsubscribe" });
