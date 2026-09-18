import { z } from "zod";
import { blockText, flatBlocks } from "./ideaBlocks";
import { materializeIdea, type IdeaDocument } from "./ideaDocument";

export const ideaReadinessBasisSchema = z.object({
  parts: z.array(z.string()).max(3000),
});
export type IdeaReadinessBasis = z.infer<typeof ideaReadinessBasisSchema>;

// Readiness records the presence of reviewed content, not an exact wording match.
// Editing/reordering a part keeps it; removing it or clearing its text does not.
export function ideaReadinessBasis(
  body: string,
  document: IdeaDocument,
): IdeaReadinessBasis {
  const doc = materializeIdea(body, document).document;
  const parts = new Set<string>();
  if (doc.title.trim()) parts.add("title");
  for (const block of flatBlocks(doc.blocks)) {
    const text = blockText(block).trim();
    if (
      block.type === "heading" &&
      block.id.startsWith("questions-") &&
      text === "Questions & answers"
    )
      continue;
    if (text) parts.add(`text:${block.id}`);
    if (["image", "file"].includes(block.type) && block.props.url)
      parts.add(`attachment:${block.id}:${String(block.props.url)}`);
  }
  for (const reference of doc.references)
    parts.add(`reference:${reference.id}`);
  return { parts: [...parts].sort() };
}

export function preservesIdeaReadiness(
  basis: IdeaReadinessBasis,
  body: string,
  document: IdeaDocument,
) {
  const current = new Set(ideaReadinessBasis(body, document).parts);
  return (
    basis.parts.length > 0 && basis.parts.every((part) => current.has(part))
  );
}
