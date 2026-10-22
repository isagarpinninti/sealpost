import { useSyncExternalStore } from "react";

export interface PersistedStore<T> {
  subscribe(cb: () => void): () => void;
  getSnapshot(): T;
  getServerSnapshot(): T;
  set(next: T): void;
}

/** localStorage-backed external store; falls back to memory when storage is unavailable. */
export function createPersistedStore<T extends object>(key: string, fallback: T): PersistedStore<T> {
  let cachedRaw: string | null | undefined;
  let cached: T = fallback;
  const listeners = new Set<() => void>();

  const read = (): T => {
    if (typeof window === "undefined") return fallback;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return cached;
    }
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    try {
      cached = raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
    } catch {
      cached = fallback;
    }
    return cached;
  };

  return {
    subscribe(cb) {
      listeners.add(cb);
      const onStorage = (e: StorageEvent): void => {
        if (e.key === key) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: read,
    getServerSnapshot: () => fallback,
    set(next) {
      cached = next;
      cachedRaw = JSON.stringify(next);
      try {
        window.localStorage.setItem(key, cachedRaw);
      } catch {
        /* storage unavailable: keep in memory */
      }
      listeners.forEach((l) => l());
    },
  };
}

export function usePersisted<T extends object>(store: PersistedStore<T>): [T, (next: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return [value, store.set];
}
