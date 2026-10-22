import { EmailTemplateSchema, type EmailTemplate } from "@sealpost/core";

export function blankTemplate(id: string, name = "New template"): EmailTemplate {
  return EmailTemplateSchema.parse({
    id,
    name,
    version: "1.0.0",
    category: "Transactional",
    description: "",
    subject: "Hello {{firstName}}",
    preheader: "A short preview of this message.",
    variables: [{ key: "firstName", label: "First name", type: "string", required: true, sampleValue: "Alex" }],
    blocks: [
      { id: "header", type: "header", brandName: "Your Brand" },
      { id: "heading", type: "heading", text: "Hi {{firstName}}" },
      { id: "body", type: "paragraph", text: "Write your message here." },
      { id: "footer", type: "footer", companyAddress: "Your Company, 1 Main Street", unsubscribeText: "Unsubscribe" },
    ],
  });
}
