import { EmailTemplateSchema, type EmailTemplate } from "../schemas/template";
import { referencedVariables } from "./compiler";

export interface TemplateValidation {
  ok: boolean;
  errors: string[];
  template?: EmailTemplate;
}

/** Schema + cross-reference validation: unique ids and keys, and every referenced `{{variable}}` is declared. */
export function validateTemplate(input: unknown): TemplateValidation {
  const parsed = EmailTemplateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`) };
  const t = parsed.data;
  const errors: string[] = [];
  const dupes = (ids: string[]): string[] => [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  for (const k of dupes(t.variables.map((v) => v.key))) errors.push(`variable '${k}' is declared more than once`);
  for (const k of dupes(t.blocks.map((b) => b.id))) errors.push(`block id '${k}' is used more than once`);
  const declared = new Map(t.variables.map((v) => [v.key, v]));
  for (const k of referencedVariables(t)) if (!declared.has(k)) errors.push(`'{{${k}}}' is used but not declared in variables`);
  for (const b of t.blocks) {
    if (b.type === "otp_code" && declared.get(b.variableKey)?.type !== "otp_code") errors.push(`block '${b.id}': variable '${b.variableKey}' must be declared with type otp_code`);
    if (b.showIfVariable && !declared.has(b.showIfVariable)) errors.push(`block '${b.id}': showIfVariable '${b.showIfVariable}' is not declared`);
  }
  for (const v of t.variables) {
    if (v.type === "url" && typeof v.sampleValue !== "string") errors.push(`variable '${v.key}': a url needs a string sample`);
  }
  return { ok: errors.length === 0, errors, template: t };
}
