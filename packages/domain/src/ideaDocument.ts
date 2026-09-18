import { z } from "zod";
import {
  ideaBlocksSchema,
  ideaFields,
  blocksText,
  blockText,
  blocksMarkdown,
  blockMirrors,
  textBlock,
  flatBlocks,
  legacyImageScheme,
  maxIdeaDocumentBytes,
  type IdeaBlock,
} from "./ideaBlocks";
export { ideaFields } from "./ideaBlocks";

export const referenceSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(180),
    caption: z.string().max(1000),
  })
  .strict();
export const referencesSchema = z
  .array(referenceSchema)
  .max(8)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Each image can appear once.",
  );
export type ImageReference = z.infer<typeof referenceSchema>;
export type IdeaField = (typeof ideaFields)[number];
export const ideaWritingPrompts: Record<IdeaField, string> = {
  purpose: "What could it make possible?",
  audience: "Who might it be for?",
  experience: "What could someone do first?",
  context: "What matters in your situation?",
  constraints: "What should it avoid?",
  possibilities: "What would you like to keep open?",
};
const legacyIdeaDocumentSchema = z
  .object({
    version: z.literal(1),
    title: z.string().max(120),
    answers: z
      .object({
        purpose: z.string().max(2000),
        audience: z.string().max(2000),
        experience: z.string().max(2000),
        context: z.string().max(2000),
        constraints: z.string().max(2000),
        possibilities: z.string().max(2000),
      })
      .strict(),
    covered: z.array(z.enum(ideaFields)).max(6),
    later: z.array(z.enum(ideaFields)).max(6),
    questions: z
      .array(
        z
          .object({
            id: z.uuid(),
            text: z.string().trim().min(1).max(200),
            important: z.boolean(),
          })
          .strict(),
      )
      .max(12),
    references: referencesSchema,
  })
  .strict();
export const ideaDocumentSchema = z.discriminatedUnion("version", [
  legacyIdeaDocumentSchema,
  legacyIdeaDocumentSchema
    .extend({
      version: z.literal(2),
      blocks: ideaBlocksSchema,
      attachments: z.array(z.uuid()).max(40),
    })
    .superRefine((doc, context) => {
      const expected = blockMirrors(doc.blocks);
      if (
        JSON.stringify(expected.answers) !== JSON.stringify(doc.answers) ||
        JSON.stringify(expected.questions) !== JSON.stringify(doc.questions) ||
        JSON.stringify(expected.references) !==
          JSON.stringify(doc.references) ||
        JSON.stringify(expected.attachments) !== JSON.stringify(doc.attachments)
      )
        context.addIssue({
          code: "custom",
          message: "Document metadata must match its blocks.",
        });
      if (
        new TextEncoder().encode(JSON.stringify(doc)).length >
        maxIdeaDocumentBytes
      )
        context.addIssue({
          code: "custom",
          message: "This document has reached its size limit.",
        });
    }),
]);
export type IdeaDocument = z.infer<typeof ideaDocumentSchema>;
export const emptyIdeaDocument = (): IdeaDocument => ({
  version: 1,
  title: "",
  answers: {
    purpose: "",
    audience: "",
    experience: "",
    context: "",
    constraints: "",
    possibilities: "",
  },
  covered: [],
  later: [],
  questions: [],
  references: [],
});
export type BlockIdeaDocument = Extract<IdeaDocument, { version: 2 }>;
export function withIdeaBlocks(
  doc: IdeaDocument,
  blocks: IdeaBlock[],
): BlockIdeaDocument {
  return { ...doc, version: 2, blocks, ...blockMirrors(blocks) };
}
export function materializeIdea(
  body: string,
  doc: IdeaDocument,
): { body: string; document: BlockIdeaDocument } {
  if (doc.version === 2) return { body: blocksText(doc.blocks), document: doc };
  const blocks: IdeaBlock[] = [];
  // Preserve exact plain text rather than interpreting existing Markdown as commands.
  if (body) blocks.push(textBlock("original-writing", body));
  for (const field of ideaFields) {
    const answer = doc.answers[field];
    if (!answer) continue;
    const labelled = answer.match(
      /^Guidance question: ([\s\S]*?)\nYour answer:\n([\s\S]*)$/,
    );
    blocks.push(
      textBlock(
        `answer-${field}`,
        labelled ? labelled[2] : answer,
        "ideaAnswer",
        { field, prompt: labelled?.[1] || "" },
      ),
    );
  }
  for (const reference of doc.references)
    blocks.push({
      id: `image-${reference.id}`,
      type: "image",
      children: [],
      props: {
        backgroundColor: "default",
        textAlignment: "left",
        name: reference.name,
        caption: reference.caption,
        url: legacyImageScheme + reference.id,
        showPreview: true,
      },
    });
  for (const question of doc.questions)
    blocks.push(
      textBlock(question.id, question.text, "openQuestion", {
        important: question.important,
      }),
    );
  if (!blocks.length) blocks.push(textBlock("initial-paragraph", ""));
  const next = withIdeaBlocks(doc, blocks);
  return { body: blocksText(blocks), document: next };
}
const questionsTitle = "Questions & answers";
const isQuestionBlock = (block: IdeaBlock) =>
  ["ideaAnswer", "reviewAnswer", "openQuestion"].includes(block.type);

// A heading belongs to the contiguous question group immediately below it.
// Keep it when questions are moved, and remove it only after the last is deleted.
export type QuestionGroupBlock = {
  id: string;
  type: string;
  children?: QuestionGroupBlock[];
};
export function emptiedQuestionHeadings(
  before: QuestionGroupBlock[],
  after: QuestionGroupBlock[],
): string[] {
  const remaining = new Set<string>();
  const collect = (blocks: typeof after) =>
    blocks.forEach((block) => {
      remaining.add(block.id);
      collect(block.children || []);
    });
  collect(after);
  const removed: string[] = [];
  const visit = (blocks: typeof before) =>
    blocks.forEach((block, index) => {
      if (
        block.type === "heading" &&
        remaining.has(block.id) &&
        !block.children?.length
      ) {
        const questions = [];
        for (
          let next = index + 1;
          next < blocks.length &&
          ["ideaAnswer", "reviewAnswer", "openQuestion"].includes(
            blocks[next].type,
          );
          next++
        ) {
          questions.push(blocks[next]);
        }
        if (
          questions.length &&
          questions.every((question) => !remaining.has(question.id))
        )
          removed.push(block.id);
      }
      visit(block.children || []);
    });
  visit(before);
  return removed;
}

export function availableIdeaWritingPrompts(
  body: string,
  doc: IdeaDocument,
): IdeaField[] {
  const existing = new Set(
    flatBlocks(materializeIdea(body, doc).document.blocks)
      .filter((block) => block.type === "ideaAnswer")
      .map((block) => block.props.field),
  );
  return ideaFields.filter((field) => !existing.has(field));
}

// Reuse an author's heading and keep new questions beside the existing group.
// Do not move questions the author has deliberately placed elsewhere.
export function insertIdeaQuestionBlock(
  blocks: IdeaBlock[],
  question: IdeaBlock,
): IdeaBlock[] {
  const first = blocks.findIndex(isQuestionBlock);
  const title = blocks.findIndex(
    (block) =>
      block.type === "heading" &&
      (block.id.startsWith("questions-") ||
        /^questions\s*(?:&|and)\s*answers$/i.test(blockText(block).trim())),
  );
  const start = first >= 0 ? first : title >= 0 ? title + 1 : blocks.length;
  let end = start;
  while (end < blocks.length && isQuestionBlock(blocks[end])) end++;
  const hasHeading = start > 0 && blocks[start - 1].type === "heading";
  return [
    ...blocks.slice(0, start),
    ...(!hasHeading
      ? [
          textBlock(`questions-${question.id}`, questionsTitle, "heading", {
            level: 2,
          }),
        ]
      : []),
    ...blocks.slice(start, end),
    question,
    ...blocks.slice(end),
  ];
}

// Reuse the saved answer wherever the author has moved it in the document.
export function openIdeaWritingPrompt(
  body: string,
  doc: IdeaDocument,
  field: IdeaField,
  newId: string,
): { document: BlockIdeaDocument; blockId: string; created: boolean } {
  const current = materializeIdea(body, doc).document;
  const existing = flatBlocks(current.blocks).find(
    (block) => block.type === "ideaAnswer" && block.props.field === field,
  );
  if (existing)
    return { document: current, blockId: existing.id, created: false };
  return {
    document: withIdeaBlocks(
      current,
      insertIdeaQuestionBlock(
        current.blocks,
        textBlock(newId, "", "ideaAnswer", {
          field,
          prompt: ideaWritingPrompts[field],
        }),
      ),
    ),
    blockId: newId,
    created: true,
  };
}

// Legacy form edits still update the canonical blocks during migration/recovery.
export function updateIdeaContext(
  current: BlockIdeaDocument,
  next: IdeaDocument,
): BlockIdeaDocument {
  let blocks = current.blocks;
  for (const field of ideaFields) {
    if (current.answers[field] === next.answers[field]) continue;
    const value = next.answers[field];
    const labelled = value.match(
      /^Guidance question: ([\s\S]*?)\nYour answer:\n([\s\S]*)$/,
    );
    let found = false;
    const replace = (nodes: IdeaBlock[]): IdeaBlock[] =>
      nodes.map((node) => {
        if (node.type === "ideaAnswer" && node.props.field === field) {
          found = true;
          return {
            ...textBlock(
              node.id,
              labelled ? labelled[2] : value,
              "ideaAnswer",
              { field, prompt: labelled?.[1] || "" },
            ),
            children: node.children,
          };
        }
        return { ...node, children: replace(node.children) };
      });
    blocks = replace(blocks);
    if (!found && value)
      blocks = [
        ...blocks,
        textBlock(
          `answer-${field}`,
          labelled ? labelled[2] : value,
          "ideaAnswer",
          { field, prompt: labelled?.[1] || "" },
        ),
      ];
  }
  if (JSON.stringify(current.questions) !== JSON.stringify(next.questions)) {
    const seen = new Set<string>();
    const replace = (nodes: IdeaBlock[]): IdeaBlock[] =>
      nodes.flatMap((node) => {
        if (node.type === "openQuestion") {
          const question = next.questions.find((q) => q.id === node.id);
          if (!question) return node.children;
          seen.add(node.id);
          return [
            {
              ...textBlock(node.id, question.text, "openQuestion", {
                important: question.important,
              }),
              children: replace(node.children),
            },
          ];
        }
        return [{ ...node, children: replace(node.children) }];
      });
    blocks = replace(blocks);
    for (const q of next.questions)
      if (!seen.has(q.id))
        blocks = [
          ...blocks,
          textBlock(q.id, q.text, "openQuestion", { important: q.important }),
        ];
  }
  return withIdeaBlocks(
    { ...next, version: 2, blocks, attachments: current.attachments },
    blocks,
  );
}
export const fieldLabels: Record<IdeaField, string> = {
  purpose: "Purpose",
  audience: "Who it is for",
  experience: "The first experience",
  context: "Personal context",
  constraints: "Boundaries",
  possibilities: "Possibilities",
};
export function hasIdeaContent(body: string, doc: IdeaDocument) {
  const withoutSectionLabel = (blocks: IdeaBlock[]): IdeaBlock[] =>
    blocks.flatMap((block) => {
      const children = withoutSectionLabel(block.children);
      return block.type === "heading" &&
        block.id.startsWith("questions-") &&
        blockText(block) === questionsTitle
        ? children
        : [{ ...block, children }];
    });
  return (
    !!(
      doc.version === 2 ? blocksText(withoutSectionLabel(doc.blocks)) : body
    ).trim() ||
    (doc.version === 1 &&
      ideaFields.some((field) => !!doc.answers[field].trim())) ||
    doc.references.length > 0 ||
    (doc.version === 2 && doc.attachments.length > 0) ||
    doc.questions.length > 0
  );
}
export function pendingIdeaQuestions(_body: string, doc: IdeaDocument) {
  // A missing legacy category does not establish an unresolved author question.
  return doc.questions.map((q) => ({
    key: q.id,
    text: q.text,
    why: "An open question you kept with this idea.",
    important: q.important,
  }));
}
export function buildIdeaBrief(body: string, doc: IdeaDocument): string {
  const sections = [body.trim()];
  // Rich-document export retains contextual questions next to short answers.
  // Open-question blocks already appear in this projection; do not append them twice.
  if (doc.version === 2) return blocksMarkdown(doc.blocks);
  for (const field of ideaFields) {
    if (doc.answers[field].trim())
      sections.push(
        `${fieldLabels[field]}${field === "possibilities" ? " — not commitments" : ""}\n${doc.answers[field].trim()}`,
      );
  }
  if (doc.references.length)
    sections.push(
      "Visual references\n" +
        doc.references
          .map((r) => `${r.name}${r.caption ? ` — ${r.caption}` : ""}`)
          .join("\n"),
    );
  const questions = pendingIdeaQuestions(body, doc);
  if (questions.length)
    sections.push(
      "Still open\n" + questions.map((q) => `• ${q.text}`).join("\n"),
    );
  return sections.filter(Boolean).join("\n\n");
}

/** The project overview is bounded; conversion also preserves the entire source document. */
export function buildProjectBrief(body: string, doc: IdeaDocument): string {
  const brief = buildIdeaBrief(body, doc);
  if (brief.length <= 12000) return brief;
  const suffix =
    "\n\n[Continued in Original idea, where the complete document is preserved.]";
  const excerpt = brief.slice(0, 12000 - suffix.length);
  const paragraph = excerpt.lastIndexOf("\n\n");
  // Prefer a complete paragraph, without reducing a long first paragraph to nothing.
  const end =
    paragraph > excerpt.length / 2 ? paragraph : excerpt.lastIndexOf(" ");
  return (
    excerpt
      .slice(0, end > 0 ? end : excerpt.length)
      .trimEnd()
      .replace(/[\uD800-\uDBFF]$/, "") + suffix
  );
}

export const uploadImageSchema = z
  .object({
    id: z.uuid(),
    dataUrl: z
      .string()
      .max(450000)
      .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
