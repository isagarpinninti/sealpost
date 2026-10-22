/** Client for the `sealpost studio` server. When unreachable the Studio runs in local (browser-only) mode. */
export interface ServerInfo {
  name: string;
  version: string;
  project: string;
  domain: string;
  fromEmail: string;
  transport: "sink" | "smtp";
  sinkPort: number | null;
  dkimSelector: string;
  authRequired: boolean;
  keyFingerprint: string;
  publicKeyJwk: JsonWebKey;
}

const TOKEN_KEY = "sealpost-token";

export const getToken = (): string => {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
export const setToken = (t: string): void => {
  try {
    if (t) window.sessionStorage.setItem(TOKEN_KEY, t);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const issues = Array.isArray(json.issues) ? ` — ${(json.issues as string[]).slice(0, 3).join("; ")}` : "";
    throw new ApiError(res.status, `${typeof json.error === "string" ? json.error : `HTTP ${res.status}`}${issues}`, json);
  }
  return json as T;
}

/** Returns server info when a Sealpost server answers /api/health, else null (local mode). */
export async function probeServer(): Promise<ServerInfo | null> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<ServerInfo>;
    return json.name === "sealpost" ? (json as ServerInfo) : null;
  } catch {
    return null;
  }
}
