const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ConversationReferenceMatch<T> = {
  reference: T;
  start: number;
  end: number;
};

/** Match complete authored labels before binding only unambiguous IDs. */
export function conversationReferenceMatches<T extends { label: string }>(
  text: string,
  references: readonly T[],
): ConversationReferenceMatch<T>[] {
  const names = [...references].sort((a, b) => b.label.length - a.label.length);
  const labels = [...new Set(names.map((reference) => reference.label))];
  const labelCounts = new Map<string, number>();
  for (const reference of names)
    labelCounts.set(
      reference.label,
      (labelCounts.get(reference.label) || 0) + 1,
    );
  const pattern = labels.length
    ? new RegExp(
        `@(${labels.map((label) => escape(label)).join("|")})(?=$|[\\s.,!?;:)\\]])`,
        "gu",
      )
    : null;
  const matches: ConversationReferenceMatch<T>[] = [];
  for (const match of pattern ? text.matchAll(pattern) : []) {
    const label = match[1];
    if (labelCounts.get(label) !== 1) continue;
    const reference = names.find((item) => item.label === label);
    if (reference)
      matches.push({
        reference,
        start: match.index!,
        end: match.index! + match[0].length,
      });
  }
  return matches;
}
