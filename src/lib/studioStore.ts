import { SAMPLE_DOMAIN, TEMPLATE_PACKS, type DomainProfile, type EmailTemplate, type Mailbox } from "@sealpost/core";
import { createPersistedStore } from "./persisted";
import { DEFAULT_THEME, THEME_KEY, type ThemePrefs } from "./theme";

/** `null` means "use the built-in defaults" so upgrades keep flowing to people who never customised. */
export interface WorkspaceConfig {
  templates: EmailTemplate[] | null;
  domain: DomainProfile | null;
  transport: "sink" | "smtp" | null;
  mailboxes: Mailbox[] | null;
}

export const DEFAULT_WORKSPACE: WorkspaceConfig = { templates: null, domain: null, transport: null, mailboxes: null };
export const DEFAULT_TEMPLATES: EmailTemplate[] = [...TEMPLATE_PACKS];
export const DEFAULT_DOMAIN: DomainProfile = SAMPLE_DOMAIN;

export const workspaceStore = createPersistedStore<WorkspaceConfig>("sealpost-workspace", DEFAULT_WORKSPACE);
export const themeStore = createPersistedStore<ThemePrefs>(THEME_KEY, DEFAULT_THEME);

export interface WorkspaceExport {
  format: "sealpost.workspace/1";
  exportedAt: string;
  templates: EmailTemplate[];
  domain: DomainProfile;
  mailboxes: Mailbox[];
}
