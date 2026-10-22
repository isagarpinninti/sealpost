"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@sealpost/react";
import { SealpostLogo } from "@/components/brand/SealpostLogo";
import { TextInput } from "./ui";

/** Shown when the server requires an API key. The key lives in sessionStorage only. */
export function TokenGate({ project, error, onSubmit }: { project: string; error: string | null; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-6 text-slate-100"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="dark"><SealpostLogo size="md" showBadge /></div>
        <div>
          <h1 className="text-base font-semibold">Sign in to {project}</h1>
          <p className="mt-1 text-xs text-slate-400">This server requires an API key. Create one with <code className="font-mono">sealpost auth add-key &lt;label&gt;</code> or use the admin key from <code className="font-mono">SEALPOST_API_KEY</code>.</p>
        </div>
        <div className="relative">
          <KeyRound size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <TextInput type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key" aria-label="API key" className="pl-9 font-mono" />
        </div>
        {error ? <p role="alert" className="text-xs text-rose-400">{error}</p> : null}
        <Button type="submit" variant="primary" className="w-full py-2.5 text-sm">
          Continue
        </Button>
      </form>
    </div>
  );
}
