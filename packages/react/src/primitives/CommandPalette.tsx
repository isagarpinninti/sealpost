"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, Search, Sparkles } from "lucide-react";
import { cn } from "../utils";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  /** Free text with no exact match is offered as an extra "Search" action. Omit to disable. */
  onFreeText?: (text: string) => void;
}

export function CommandPalette({ open, onClose, items, onFreeText }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q === "" ? items : items.filter((i) => `${i.label} ${i.group} ${i.keywords ?? ""}`.toLowerCase().includes(q));
    if (q === "") return filtered;
    if (!onFreeText) return filtered;
    return [
      ...filtered,
      { id: "__free", group: "Search", label: `Find a pact for “${query.trim()}”`, hint: "Free text", icon: <Sparkles size={14} />, run: () => onFreeText(query.trim()) } satisfies PaletteItem,
    ];
  }, [items, query, onFreeText]);

  if (!open) return null;

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    onClose();
    setQuery("");
    setIndex(0);
    item.run();
  };

  const rows = results.map((item, i) => ({ item, i, header: i === 0 || results[i - 1].group !== item.group }));
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm" onClick={onClose} />
      <div className="studio-fade relative w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_30px_80px_-20px_rgba(15,23,42,0.5)] dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 dark:border-slate-800">
          <Search size={16} className="text-slate-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(results[index]);
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="Type a request, or search workflows, people, views…"
            aria-label="Command palette search"
            className="h-12 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          <kbd className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 dark:border-slate-700">esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-auto p-1.5" role="listbox">
          {results.length === 0 ? <li className="px-3 py-6 text-center text-sm text-slate-500">No matches</li> : null}
          {rows.map(({ item, i, header }) => {
            return (
              <li key={item.id}>
                {header ? <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{item.group}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(item)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                    i === index ? "bg-brand-50 text-brand-900 dark:bg-brand-400/10 dark:text-brand-100" : "text-slate-700 dark:text-slate-300",
                  )}
                >
                  <span className="text-slate-400">{item.icon}</span>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint ? <span className="text-[11px] text-slate-400">{item.hint}</span> : null}
                  {i === index ? <CornerDownLeft size={12} className="text-slate-400" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
