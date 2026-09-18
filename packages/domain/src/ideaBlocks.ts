import { z } from "zod";

// The editor's JSON is the document. Text/Markdown are projections, never a
// format used to reload a rich document. Keep this schema independent of DOM code.
export const ideaFields = [
  "purpose",
  "audience",
  "experience",
  "context",
  "constraints",
  "possibilities",
] as const;
export const maxIdeaText = 100_000;
export const maxIdeaDocumentBytes = 1_000_000;
export const attachmentLimit = 20 * 1024 * 1024;
export const attachmentScheme = "woolgather:file:";
export const legacyImageScheme = "woolgather:image:";
const uuid = z.uuid();
const color = z
  .string()
  .max(60)
  .regex(/^[#a-zA-Z0-9(),.%\s-]+$/);
const alignment = z.enum(["left", "center", "right", "justify"]);
const styles = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    code: z.boolean().optional(),
    textColor: color.optional(),
    backgroundColor: color.optional(),
  })
  .strict();
const text = z
  .object({
    type: z.literal("text"),
    text: z.string().max(maxIdeaText),
    styles,
  })
  .strict();
export const safeLink = z
  .string()
  .max(2048)
  .refine((href) => {
    if (/[\u0000-\u0020\u007f]/.test(href)) return false;
    try {
      return ["https:", "http:", "mailto:", "tel:"].includes(
        new URL(href).protocol,
      );
    } catch {
      return false;
    }
  }, "Use an http, https, email or telephone link.");
const inline = z.discriminatedUnion("type", [
  text,
  z
    .object({
      type: z.literal("link"),
      href: safeLink,
      content: z.array(text).max(2000),
    })
    .strict(),
]);
export type IdeaInline = z.infer<typeof inline>;
const cell = z
  .object({
    type: z.literal("tableCell"),
    props: z
      .object({
        backgroundColor: color,
        textColor: color,
        textAlignment: alignment,
        colspan: z.number().int().min(1).max(20).optional(),
        rowspan: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    content: z.array(inline).max(2000),
  })
  .strict();
const table = z
  .object({
    type: z.literal("tableContent"),
    columnWidths: z.array(z.number().min(0).max(4000).nullish()).min(1).max(20),
    headerRows: z.number().int().min(0).max(100).optional(),
    headerCols: z.number().int().min(0).max(20).optional(),
    rows: z
      .array(
        z
          .object({
            cells: z
              .array(z.union([z.array(inline).max(2000), cell]))
              .min(1)
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type IdeaTable = z.infer<typeof table>;
export const blockTypes = [
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "divider",
  "codeBlock",
  "table",
  "image",
  "file",
  "ideaAnswer",
  "reviewAnswer",
  "openQuestion",
] as const;
export type IdeaBlock = {
  id: string;
  type: (typeof blockTypes)[number];
  props: Record<string, string | number | boolean | undefined>;
  content?: IdeaInline[] | IdeaTable;
  children: IdeaBlock[];
};
const common = {
  backgroundColor: color.optional(),
  textColor: color.optional(),
  textAlignment: alignment.optional(),
};
const media = {
  backgroundColor: color.optional(),
  name: z.string().max(180),
  url: z.string().refine((url) => !url || attachmentId(url) !== null),
  caption: z.string().max(1000),
};
const propsByType = {
  paragraph: z.object(common).strict(),
  heading: z
    .object({
      ...common,
      level: z.number().int().min(1).max(3),
      isToggleable: z.boolean().optional(),
    })
    .strict(),
  bulletListItem: z.object(common).strict(),
  numberedListItem: z
    .object({
      ...common,
      start: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict(),
  checkListItem: z.object({ ...common, checked: z.boolean() }).strict(),
  toggleListItem: z.object(common).strict(),
  quote: z.object(common).strict(),
  divider: z.object({}).strict(),
  codeBlock: z.object({ language: z.string().max(40) }).strict(),
  table: z.object({ textColor: color.optional() }).strict(),
  image: z
    .object({
      ...media,
      textAlignment: alignment.optional(),
      showPreview: z.boolean(),
      previewWidth: z.number().min(32).max(4000).optional(),
    })
    .strict(),
  file: z.object(media).strict(),
  ideaAnswer: z
    .object({
      ...common,
      field: z.enum(ideaFields),
      prompt: z.string().max(200),
    })
    .strict(),
  openQuestion: z.object({ ...common, important: z.boolean() }).strict(),
  reviewAnswer: z
    .object({ ...common, prompt: z.string().min(1).max(200) })
    .strict(),
};
const block: z.ZodType<IdeaBlock> = z.lazy(() =>
  z
    .object({
      id: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[a-zA-Z0-9_-]+$/),
      type: z.enum(blockTypes),
      props: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.undefined()]),
      ),
      content: z.union([z.array(inline).max(2000), table]).optional(),
      children: z.array(block).max(1000),
    })
    .strict()
    .superRefine((value, context) => {
      if (!propsByType[value.type].safeParse(value.props).success)
        context.addIssue({
          code: "custom",
          message: "Invalid block properties.",
        });
      if (["file", "image", "divider"].includes(value.type)) {
        if (value.content !== undefined || value.children.length)
          context.addIssue({
            code: "custom",
            message:
              "Attachments and dividers cannot contain text or children.",
          });
      } else if (value.type === "table") {
        if (!value.content || Array.isArray(value.content))
          context.addIssue({
            code: "custom",
            message: "Invalid table content.",
          });
      } else if (!Array.isArray(value.content)) {
        context.addIssue({
          code: "custom",
          message: "Text blocks require inline content.",
        });
      }
      if (
        value.type === "openQuestion" &&
        (!uuid.safeParse(value.id).success || blockText(value).length > 200)
      )
        context.addIssue({
          code: "custom",
          message: "Questions support up to 200 characters.",
        });
      if (
        value.type === "ideaAnswer" &&
        blockText(value).length +
          (value.props.prompt ? String(value.props.prompt).length + 34 : 0) >
          2000
      )
        context.addIssue({
          code: "custom",
          message: "A guided answer supports up to 2,000 characters.",
        });
    }),
);
const boundedTree = z.unknown().superRefine((input, context) => {
  const queue: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let count = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (!Array.isArray(value)) continue;
    count += value.length;
    if (depth > 8 || count > 1000) {
      context.addIssue({
        code: "custom",
        message: "Document nesting or block limit exceeded.",
        fatal: true,
      });
      return;
    }
    for (const node of value)
      if (node && typeof node === "object" && "children" in node)
        queue.push({ value: node.children, depth: depth + 1 });
  }
});
export const ideaBlocksSchema = boundedTree.pipe(
  z
    .array(block)
    .min(1)
    .max(1000)
    .superRefine((blocks, context) => {
      const seen = new Set<string>();
      let count = 0;
      const visit = (nodes: IdeaBlock[], depth: number) => {
        if (depth > 8) {
          context.addIssue({
            code: "custom",
            message: "Use at most eight levels of nesting.",
          });
          return;
        }
        for (const node of nodes) {
          if (seen.has(node.id))
            context.addIssue({ code: "custom", message: "Repeated block ID." });
          seen.add(node.id);
          count++;
          visit(node.children, depth + 1);
        }
      };
      visit(blocks, 0);
      if (
        count > 1000 ||
        blocksText(blocks).length > maxIdeaText ||
        new TextEncoder().encode(JSON.stringify(blocks)).length >
          maxIdeaDocumentBytes
      )
        context.addIssue({
          code: "custom",
          message: "This document has reached its size limit.",
        });
      const answers = flatBlocks(blocks).filter((b) => b.type === "ideaAnswer");
      if (new Set(answers.map((b) => b.props.field)).size !== answers.length)
        context.addIssue({
          code: "custom",
          message: "Keep one guided answer for each topic.",
        });
      if (
        flatBlocks(blocks).filter((b) => b.type === "openQuestion").length > 12
      )
        context.addIssue({
          code: "custom",
          message: "Keep up to twelve open questions.",
        });
    }),
);
export function attachmentId(
  url: string,
): { id: string; legacy: boolean } | null {
  const legacy = url.startsWith(legacyImageScheme);
  if (!legacy && !url.startsWith(attachmentScheme)) return null;
  const id = url.slice((legacy ? legacyImageScheme : attachmentScheme).length);
  return uuid.safeParse(id).success ? { id, legacy } : null;
}
export function flatBlocks(blocks: IdeaBlock[]): IdeaBlock[] {
  return blocks.flatMap((b) => [b, ...flatBlocks(b.children)]);
}
export function inlineText(content: IdeaInline[]) {
  return content
    .map((c) =>
      c.type === "text" ? c.text : c.content.map((t) => t.text).join(""),
    )
    .join("");
}
export function blockText(block: IdeaBlock): string {
  if (!block.content) return String(block.props.caption || "");
  if (Array.isArray(block.content)) return inlineText(block.content);
  return block.content.rows
    .map((r) =>
      r.cells
        .map((c) => inlineText(Array.isArray(c) ? c : c.content))
        .join("\t"),
    )
    .join("\n");
}
export function blocksText(blocks: IdeaBlock[]) {
  return flatBlocks(blocks).map(blockText).join("\n\n");
}
export function textBlock(
  id: string,
  value: string,
  type: IdeaBlock["type"] = "paragraph",
  props: IdeaBlock["props"] = {},
): IdeaBlock {
  return {
    id,
    type,
    props: {
      ...([
        "paragraph",
        "heading",
        "ideaAnswer",
        "reviewAnswer",
        "openQuestion",
      ].includes(type)
        ? {
            backgroundColor: "default",
            textColor: "default",
            textAlignment: "left",
          }
        : {}),
      ...props,
    },
    content: [{ type: "text", text: value, styles: {} }],
    children: [],
  };
}
export function blockMirrors(blocks: IdeaBlock[]) {
  const answers = Object.fromEntries(ideaFields.map((f) => [f, ""])) as Record<
    (typeof ideaFields)[number],
    string
  >;
  const questions: { id: string; text: string; important: boolean }[] = [];
  const references: { id: string; name: string; caption: string }[] = [];
  const attachments: string[] = [];
  for (const b of flatBlocks(blocks)) {
    if (b.type === "ideaAnswer") {
      const field = b.props.field as (typeof ideaFields)[number];
      answers[field] =
        (b.props.prompt
          ? `Guidance question: ${b.props.prompt}\nYour answer:\n`
          : "") + blockText(b);
    }
    if (b.type === "openQuestion" && blockText(b).trim())
      questions.push({
        id: b.id,
        text: blockText(b).trim(),
        important: !!b.props.important,
      });
    if (b.type !== "image" && b.type !== "file") continue;
    const ref = attachmentId(String(b.props.url));
    if (!ref) continue;
    if (ref.legacy) {
      if (!references.some((r) => r.id === ref.id))
        references.push({
          id: ref.id,
          name: String(b.props.name || "Reference image"),
          caption: String(b.props.caption || ""),
        });
    } else if (!attachments.includes(ref.id)) attachments.push(ref.id);
  }
  return { answers, questions, references, attachments };
}
const escapeMarkdown = (value: string) =>
  value.replace(/([\\`*_{}\[\]<>#|])/g, "\\$1");
function inlineMarkdown(content: IdeaInline[]): string {
  return content
    .map((c): string => {
      if (c.type === "link")
        return `[${inlineMarkdown(c.content)}](${c.href.replace(/[()]/g, (m) => (m === "(" ? "%28" : "%29"))})`;
      let result = escapeMarkdown(c.text);
      if (c.styles.code) {
        const fence = "`".repeat(
          Math.max(
            1,
            ...[...c.text.matchAll(/`+/g)].map((m) => m[0].length + 1),
          ),
        );
        result = `${fence} ${c.text} ${fence}`;
      }
      if (c.styles.bold) result = `**${result}**`;
      if (c.styles.italic) result = `*${result}*`;
      if (c.styles.strike) result = `~~${result}~~`;
      return result;
    })
    .join("");
}
export function blocksMarkdown(
  blocks: IdeaBlock[],
  assets: Record<string, string> = {},
  depth = 0,
): string {
  return blocks
    .map((b) => {
      const content = b.content;
      let result = Array.isArray(content) ? inlineMarkdown(content) : "";
      if (b.type === "heading")
        result = `${"#".repeat(Number(b.props.level))} ${result}`;
      else if (b.type === "bulletListItem" || b.type === "toggleListItem")
        result = `- ${result}`;
      else if (b.type === "numberedListItem") result = `1. ${result}`;
      else if (b.type === "checkListItem")
        result = `- [${b.props.checked ? "x" : " "}] ${result}`;
      else if (b.type === "quote")
        result = result
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      else if (b.type === "divider") result = "---";
      else if (b.type === "codeBlock") {
        const source = blockText(b),
          fence = "`".repeat(
            Math.max(
              3,
              ...[...source.matchAll(/`+/g)].map((m) => m[0].length + 1),
            ),
          );
        result = `${fence}${String(b.props.language).replace(/[^\w+-]/g, "")}\n${source}\n${fence}`;
      } else if (b.type === "ideaAnswer")
        result = `### ${b.props.field}\n\n${b.props.prompt ? `Guidance question: ${escapeMarkdown(String(b.props.prompt))}\n\nYour answer:\n\n` : ""}${result}`;
      else if (b.type === "reviewAnswer")
        result = `### ${escapeMarkdown(String(b.props.prompt))}\n\n${result || "Not answered yet."}`;
      else if (b.type === "openQuestion")
        result = `> Open question${b.props.important ? " (could change direction)" : ""}: ${result}`;
      else if (b.type === "file" || b.type === "image") {
        const ref = attachmentId(String(b.props.url)),
          path = ref ? assets[ref.id] : null;
        const name = escapeMarkdown(String(b.props.name || "Attachment"));
        result = path
          ? `${b.type === "image" ? "!" : ""}[${name}](${path})`
          : `${name}${ref ? "" : " — not uploaded"}`;
        if (b.props.caption)
          result += `\n\n${escapeMarkdown(String(b.props.caption))}`;
      } else if (b.type === "table" && content && !Array.isArray(content)) {
        const rows = content.rows.map((r) =>
          r.cells.map((c) =>
            inlineMarkdown(Array.isArray(c) ? c : c.content).replace(
              /\n/g,
              " ",
            ),
          ),
        );
        const width = Math.max(...rows.map((r) => r.length));
        const row = (cells: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => cells[i] || "").join(" | ")} |`;
        result = [
          row(rows[0]),
          row(Array(width).fill("---")),
          ...rows.slice(1).map(row),
        ].join("\n");
      }
      return (
        result +
        (b.children.length
          ? "\n\n" +
            blocksMarkdown(b.children, assets, depth + 1)
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")
          : "")
      );
    })
    .join("\n\n");
}
