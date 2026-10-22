"use client";

import { Check, Download, Palette, RotateCcw, Upload, Database } from "lucide-react";
import { Badge, Button, Card, CardHeader, Segmented, cn } from "@sealpost/react";
import { ACCENTS, RADII, TEXT_SIZES, type AccentId, type RadiusId, type TextSizeId, type ThemeMode, type ThemePrefs } from "@/lib/theme";
import { ApiKeysCard } from "../ApiKeysCard";
import { Label, PageHeader } from "../ui";

interface Props {
  prefs: ThemePrefs;
  onPrefs: (patch: Partial<Pick<ThemePrefs, "mode" | "accent" | "radius" | "textSize">>) => void;
  onResetTheme: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onResetWorkspace: () => void;
  importError: string | null;
  counts: { templates: number; variables: number; ledger: number };
  mode: "server" | "local" | "connecting";
  fingerprint: string | null;
}

export function SettingsView({ prefs, onPrefs, onResetTheme, onExport, onImport, onResetWorkspace, importError, counts, mode, fingerprint }: Props) {
  return (
    <div>
      <PageHeader title="Settings" description="Make the studio yours, and move your configuration between browsers or teammates." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader
            icon={<Palette size={16} />}
            title="Appearance"
            subtitle="Applies instantly and is remembered on this device"
            right={
              <Button onClick={onResetTheme}>
                <RotateCcw size={13} /> Reset
              </Button>
            }
          />
          <div className="space-y-5 p-4">
            <div>
              <Label>Theme</Label>
              <Segmented<ThemeMode>
                ariaLabel="Theme mode"
                value={prefs.mode}
                onChange={(mode) => onPrefs({ mode })}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            </div>
            <div>
              <Label>Accent colour</Label>
              <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Accent colour">
                {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={prefs.accent === id}
                    aria-label={ACCENTS[id].label}
                    title={ACCENTS[id].label}
                    onClick={() => onPrefs({ accent: id })}
                    className={cn(
                      "relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg ring-2 ring-offset-2 ring-offset-white transition-all focus-visible:outline-none dark:ring-offset-slate-900",
                      prefs.accent === id ? "ring-slate-900 dark:ring-white" : "ring-transparent hover:ring-slate-300 dark:hover:ring-slate-600",
                    )}
                    style={{ background: `linear-gradient(135deg, ${ACCENTS[id].scale[4]}, ${ACCENTS[id].swatch})` }}
                  >
                    {prefs.accent === id ? <Check size={16} className="text-white mix-blend-difference" /> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Corners</Label>
                <Segmented<RadiusId>
                  ariaLabel="Corner style"
                  value={prefs.radius}
                  onChange={(radius) => onPrefs({ radius })}
                  options={(Object.keys(RADII) as RadiusId[]).map((id) => ({ value: id, label: RADII[id].label }))}
                />
              </div>
              <div>
                <Label>Text size</Label>
                <Segmented<TextSizeId>
                  ariaLabel="Text size"
                  value={prefs.textSize}
                  onChange={(textSize) => onPrefs({ textSize })}
                  options={(Object.keys(TEXT_SIZES) as TextSizeId[]).map((id) => ({ value: id, label: TEXT_SIZES[id].label }))}
                />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Preview</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary">Dispatch email</Button>
                <Button>Secondary</Button>
                <Badge tone="brand">Accent badge</Badge>
                <Badge tone="emerald">Clear</Badge>
                <Badge tone="amber">Warning</Badge>
                <Badge tone="rose">Blocked</Badge>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader icon={<Database size={16} />} title="Workspace data" subtitle={mode === "server" ? "Stored as files in your project directory." : "Stored in this browser. Export to share or back up."} />
          <div className="space-y-4 p-4">
            <div className="grid grid-cols-3 gap-3 text-center">
              {(
                [
                  ["Templates", counts.templates],
                  ["Variables", counts.variables],
                  ["Receipts", counts.ledger],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{n}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={onExport}>
                <Download size={13} /> Export workspace
              </Button>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
                <Upload size={13} /> Import workspace
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImport(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <Button variant="danger" onClick={onResetWorkspace}>
                Reset to built-ins
              </Button>
            </div>
            {importError ? (
              <pre role="alert" className="whitespace-pre-wrap rounded-lg border border-rose-300 bg-rose-50 p-2.5 font-mono text-[11px] text-rose-800 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-300">
                {importError}
              </pre>
            ) : null}
            <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              The export contains your email templates (blocks, variables, theme), the domain profile and the mailbox list (never passwords) as plain JSON. Drop the templates into <code className="rounded bg-slate-100 px-1 font-mono text-[11px] dark:bg-slate-800">templates/</code> of any Sealpost project.
              {mode === "local" ? " Local demo keys, inbox and ledger live only in this browser." : ` Receipt key ${fingerprint ? `${fingerprint.slice(0, 16)}…` : ""} and the DKIM key are stored on the server with mode 0600.`}
            </p>
          </div>
        </Card>
        {mode === "server" ? <ApiKeysCard /> : null}
      </div>
    </div>
  );
}
