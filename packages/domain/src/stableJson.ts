// Postgres JSONB returns object keys in its own order. Key order cannot make a
// saved document dirty or reset the editor's selection and undo history.
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
