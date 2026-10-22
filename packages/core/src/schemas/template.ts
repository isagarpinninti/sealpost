import { z } from "zod";

const ident = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/, "must start with a letter and use only letters, digits and _");
const slug = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "lowercase letters, digits and _");
const hostname = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "must be a domain name such as mail.example.com");
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex colour such as #0f172a");
const scalar = z.union([z.string(), z.number(), z.boolean()]);

export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;
export const VARIABLE_TYPES = ["string", "number", "currency", "url", "otp_code", "boolean"] as const;
export const CATEGORIES = ["Auth", "Billing", "Incidents", "Growth", "Transactional"] as const;

export const DomainProfileSchema = z
  .object({
    domain: hostname,
    fromName: z.string().min(1).max(120),
    fromEmail: z.string().min(3).max(254),
    replyTo: z.string().min(3).max(254).optional(),
    dkimSelector: z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/).max(63).default("sealpost"),
    spfInclude: z.string().max(253).optional(),
    dmarcPolicy: z.enum(DMARC_POLICIES).default("none"),
    unsubscribeUrl: z.string().url().max(2000).optional(),
    trackingBaseUrl: z.string().url().max(2000).optional(),
  })
  .strict();

export const MAILBOX_SECURITY = ["starttls", "tls", "none"] as const;

/** One SMTP relay. The password is never stored: `passwordEnv` names the environment variable that holds it. */
export const MailboxSchema = z
  .object({
    id: slug,
    label: z.string().min(1).max(80),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(MAILBOX_SECURITY).default("starttls"),
    username: z.string().max(254).optional(),
    passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(80).optional(),
  })
  .strict();

export const TemplateVariableSchema = z
  .object({
    key: ident,
    label: z.string().min(1).max(80),
    type: z.enum(VARIABLE_TYPES),
    required: z.boolean().default(true),
    /** Used when the caller omits the variable. */
    defaultValue: scalar.optional(),
    sampleValue: scalar,
  })
  .strict();

const blockBase = { id: ident, showIfVariable: ident.optional() };

export const EmailBlockSchema = z.discriminatedUnion("type", [
  z.object({ ...blockBase, type: z.literal("header"), brandName: z.string().max(120), badgeText: z.string().max(40).optional(), subtitle: z.string().max(200).optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("heading"), text: z.string().max(300), level: z.enum(["h1", "h2"]).optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("paragraph"), text: z.string().max(5000), muted: z.boolean().optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("otp_code"), label: z.string().max(200), variableKey: ident, expiryNote: z.string().max(300).optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("key_value"), rows: z.array(z.object({ label: z.string().max(120), valueTemplate: z.string().max(500) }).strict()).min(1).max(30) }).strict(),
  z.object({ ...blockBase, type: z.literal("line_items"), items: z.array(z.object({ description: z.string().max(300), amountTemplate: z.string().max(100) }).strict()).min(1).max(60), totalLabel: z.string().max(80), totalTemplate: z.string().max(100) }).strict(),
  z.object({ ...blockBase, type: z.literal("button"), label: z.string().max(120), urlTemplate: z.string().max(2000), style: z.enum(["primary", "amber", "outline"]).optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("callout"), tone: z.enum(["info", "warn", "emerald", "rose"]), title: z.string().max(200), text: z.string().max(2000) }).strict(),
  z.object({ ...blockBase, type: z.literal("image"), srcTemplate: z.string().max(2000), alt: z.string().max(300), hrefTemplate: z.string().max(2000).optional(), width: z.number().int().min(16).max(600).optional(), align: z.enum(["left", "center"]).optional() }).strict(),
  z.object({ ...blockBase, type: z.literal("divider") }).strict(),
  z.object({ ...blockBase, type: z.literal("footer"), companyAddress: z.string().max(400), unsubscribeText: z.string().max(200).optional() }).strict(),
]);

export const ThemeSchema = z
  .object({
    accentColor: color.default("#0f172a"),
    canvasColor: color.default("#f1f5f9"),
    cardColor: color.default("#ffffff"),
    fontFamily: z.string().regex(/^[\w ,'-]+$/).max(200).default("Helvetica, Arial, sans-serif"),
  })
  .strict();

export const EmailTemplateSchema = z
  .object({
    id: slug,
    name: z.string().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: z.enum(CATEGORIES),
    description: z.string().max(600).default(""),
    subject: z.string().min(1).max(500),
    preheader: z.string().max(300).default(""),
    variables: z.array(TemplateVariableSchema).max(60).default([]),
    theme: ThemeSchema.default({ accentColor: "#0f172a", canvasColor: "#f1f5f9", cardColor: "#ffffff", fontFamily: "Helvetica, Arial, sans-serif" }),
    blocks: z.array(EmailBlockSchema).min(1).max(80),
  })
  .strict();

export type DomainProfile = z.infer<typeof DomainProfileSchema>;
export type DomainProfileInput = z.input<typeof DomainProfileSchema>;
export type Mailbox = z.infer<typeof MailboxSchema>;
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;
export type EmailBlock = z.infer<typeof EmailBlockSchema>;
export type EmailBlockType = EmailBlock["type"];
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;
export type EmailTemplateInput = z.input<typeof EmailTemplateSchema>;
export type VariableType = (typeof VARIABLE_TYPES)[number];
export type VariableValue = string | number | boolean;
export type VariableValues = Record<string, VariableValue>;
