export type ComposerMention = { start: number; end: number; query: string };

/** Mentions can appear in prose, but never inside an email address or URL. */
export function readComposerMention(
  text: string,
  caret: number,
  selectionEnd = caret,
): ComposerMention | null {
  if (caret !== selectionEnd || caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const before = text.slice(lineStart, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/[\s([{]/u.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (/[\n@<>]/u.test(query) || query.length > 160) return null;
  return { start: lineStart + at, end: caret, query };
}

export function insertComposerMention(
  text: string,
  mention: Pick<ComposerMention, "start" | "end">,
  label: string | undefined,
) {
  const token = label ? `@${label}` : "";
  const suffix = text.slice(mention.end);
  const separator = token && !/^\s/u.test(suffix) ? " " : "";
  const insertion = token + separator;
  return {
    text: text.slice(0, mention.start) + insertion + suffix,
    caret: mention.start + insertion.length,
  };
}
