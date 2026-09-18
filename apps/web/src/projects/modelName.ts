/** Display casing only; provider IDs and saved routing stay unchanged. */
export function formatModelName(model: string): string {
  return model
    .replace(/^gpt-/i, "GPT-")
    .replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`);
}
