// RFC 8785 (JCS) for the value shapes this project signs: objects, arrays, strings,
// booleans, null and safe integers. Anything else is rejected rather than approximated.
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("only safe integers are canonicalized");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(jcs).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    // JCS orders keys by UTF-16 code units, which is JavaScript's default sort.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + jcs(v)).join(",") + "}";
  }
  throw new TypeError("value cannot be canonicalized");
}
