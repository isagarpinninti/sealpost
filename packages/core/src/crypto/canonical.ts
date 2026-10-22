export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: object keys sorted recursively, no whitespace. Byte-compatible with Assentra's canonicalize. */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}
