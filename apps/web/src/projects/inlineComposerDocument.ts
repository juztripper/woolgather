import { Schema, type Node as DocumentNode } from "@tiptap/pm/model";

export type InlineReference = { id: string; label: string; kind: string };
export const composerSchema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: {
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: { group: "inline" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      selectable: false,
      attrs: { id: {}, label: {}, kind: {} },
      toDOM: (node) => [
        "span",
        { "data-mention-id": node.attrs.id },
        `@${node.attrs.label}`,
      ],
      leafText: (node) => `@${node.attrs.label}`,
    },
  },
});
export function inlineText(node: DocumentNode): string {
  if (node.isText) return node.text || "";
  if (node.type.name === "mention") return `@${node.attrs.label}`;
  if (node.type.name === "hard_break") return "\n";
  let text = "";
  node.forEach((child) => {
    text += inlineText(child);
  });
  return text;
}
export function inlineIds(doc: DocumentNode): string[] {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "mention") ids.add(node.attrs.id);
  });
  return [...ids];
}
export function plainContent(text: string) {
  return text
    .split("\n")
    .flatMap((line, index) => [
      ...(index ? [composerSchema.nodes.hard_break.create()] : []),
      ...(line ? [composerSchema.text(line)] : []),
    ]);
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function inlineDocument(
  text: string,
  references: InlineReference[],
  previous?: DocumentNode,
) {
  const oldText = previous ? inlineText(previous) : "";
  let prefix = 0,
    suffix = 0;
  while (
    prefix < Math.min(oldText.length, text.length) &&
    oldText[prefix] === text[prefix]
  )
    prefix++;
  while (
    suffix < Math.min(oldText.length, text.length) - prefix &&
    oldText.at(-1 - suffix) === text.at(-1 - suffix)
  )
    suffix++;
  const previousTokens: { start: number; id: string }[] = [];
  let offset = 0;
  previous?.firstChild?.forEach((node) => {
    if (node.type.name === "mention")
      previousTokens.push({ start: offset, id: node.attrs.id });
    offset += inlineText(node).length;
  });
  const names = [...new Set(references.map((item) => item.label))].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = names.length
    ? new RegExp(
        `(^|[\\s([{])@(${names.map(escape).join("|")})(?=$|[\\s.,!?;:)\\]])`,
        "gu",
      )
    : null;
  const used = new Set<string>();
  const content: DocumentNode[] = [];
  let start = 0;
  for (const match of pattern ? text.matchAll(pattern) : []) {
    const from = match.index! + match[1].length;
    const end = from + match[2].length + 1;
    const oldStart =
      end <= prefix
        ? from
        : from >= text.length - suffix
          ? from + oldText.length - text.length
          : -1;
    const oldId = previousTokens.find((token) => token.start === oldStart)?.id;
    const candidates = references.filter((item) => item.label === match[2]);
    const reference =
      candidates.find((item) => item.id === oldId) ||
      candidates.find(
        (item) =>
          !used.has(item.id) &&
          !previousTokens.some((token) => token.id === item.id),
      ) ||
      candidates.find((item) => !used.has(item.id)) ||
      candidates[0];
    content.push(
      ...plainContent(text.slice(start, from)),
      composerSchema.nodes.mention.create(reference),
    );
    used.add(reference.id);
    start = end;
  }
  content.push(...plainContent(text.slice(start)));
  return composerSchema.node("doc", null, [
    composerSchema.node("paragraph", null, content),
  ]);
}
export function positionAtOffset(doc: DocumentNode, offset: number) {
  let textOffset = 0,
    result = doc.content.size - 1;
  doc.firstChild?.forEach((node, position) => {
    const length = inlineText(node).length;
    if (offset >= textOffset && offset <= textOffset + length)
      result =
        position +
        1 +
        (node.isText
          ? offset - textOffset
          : offset === textOffset
            ? 0
            : node.nodeSize);
    textOffset += length;
  });
  return Math.max(1, result);
}
export function offsetAtPosition(doc: DocumentNode, position: number) {
  let offset = 0;
  doc.firstChild?.forEach((node, start) => {
    if (position >= start + 1 + node.nodeSize)
      offset += inlineText(node).length;
    else if (position > start + 1)
      offset += node.isText ? position - start - 1 : inlineText(node).length;
  });
  return offset;
}
