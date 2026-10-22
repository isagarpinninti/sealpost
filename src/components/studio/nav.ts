export type ViewId = "overview" | "studio" | "dispatch" | "broadcast" | "logs" | "ledger" | "domain" | "setup" | "sdk" | "settings";

/** ⌘/Ctrl/Alt + index+1. Settings is ⌘, instead. */
export const VIEW_ORDER: ViewId[] = ["overview", "studio", "dispatch", "broadcast", "logs", "ledger", "domain", "setup", "sdk", "settings"];

export const VIEW_TITLES: Record<ViewId, string> = {
  overview: "Overview",
  studio: "Studio",
  dispatch: "Send",
  broadcast: "Broadcasts",
  logs: "Logs",
  ledger: "Ledger",
  domain: "Domains",
  setup: "Setup",
  sdk: "Developers",
  settings: "Settings",
};

export const VIEW_BLURBS: Record<ViewId, string> = {
  overview: "Activity and health at a glance",
  studio: "Design and edit email templates",
  dispatch: "Send a test and read the test inbox",
  broadcast: "Audiences and scheduled sends",
  logs: "Every email sent and received",
  ledger: "Signed delivery receipts",
  domain: "Sending domains, relays and suppressions",
  setup: "Guided first-run setup",
  sdk: "SDKs, API and embeddable components",
  settings: "Appearance and workspace",
};

export const NAV_GROUPS: ReadonlyArray<{ label?: string; items: ViewId[] }> = [
  { items: ["overview"] },
  { label: "Build", items: ["studio", "dispatch", "broadcast"] },
  { label: "Monitor", items: ["logs", "ledger"] },
  { label: "Configure", items: ["domain", "setup", "sdk"] },
];
