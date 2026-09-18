import type { z } from "zod";
import type { itemInput, commandSchema } from "./commands";
import {
  fieldLabels,
  ideaFields,
  type IdeaDocument,
  type ImageReference,
} from "./ideaDocument";
import type { ProjectSource } from "./projectSources";

export const categories = [
  "purpose",
  "feature",
  "constraint",
  "decision",
  "question",
  "gap",
  "note",
] as const;
export const certainty = ["stated", "tentative", "confirmed"] as const;
export const statuses = [
  "open",
  "answered",
  "deferred",
  "resolved",
  "recheck",
] as const;
export type ItemInput = z.infer<typeof itemInput>;
export type Command = z.infer<typeof commandSchema>;
export type Action = Command["action"];
export type Item = ItemInput & {
  id: string;
  removed: boolean;
  source: string;
  promotedFrom: string | null;
  evidence?: { turnId: string; quote: string } | null;
};
export type Project = {
  id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  folderId?: string | null;
  lifecycle?: "active" | "archived" | "trashed";
  originalIdea?: string | null;
  ideaDocument?: IdeaDocument | null;
  ideaQuestions?: string[];
  references?: ImageReference[];
  /** Project-owned catalog entries backed by private attachment storage. */
  sources?: ProjectSource[];
  items: Item[];
  thinking?: import("./projectPlanning").ThinkingState;
};
export type ProjectSummary = Omit<Project, "items"> & { itemCount: number };
export type History = {
  revision: number;
  action: string;
  at: string;
  before: Item | null;
  after: Item | null;
};
export function exportMarkdown(
  project: Project,
  images: Record<string, string> = {},
): string {
  const line = (value: string) =>
    value.replace(/[\r\n]+/g, " ").replace(/([\\`*_{}\[\]<>#])/g, "\\$1");
  const sections = categories
    .map((category) => {
      const items = project.items.filter(
        (i) => i.category === category && !i.removed,
      );
      return items.length
        ? `## ${category[0].toUpperCase() + category.slice(1)}\n\n` +
            items
              .map(
                (i) =>
                  `### ${line(i.title)}\n\n${i.body}\n\nCertainty: ${i.certainty} · Status: ${i.status}\n${i.answer ? `\nAnswer: ${i.answer}\n` : ""}${i.links.length ? `\nLinked items: ${i.links.join(", ")}\n` : ""}\nSource: ${i.source}\nItem ID: ${i.id}\n${i.promotedFrom ? `Source question ID: ${i.promotedFrom}\n` : ""}`,
              )
              .join("\n")
        : "";
    })
    .filter(Boolean);
  const doc = project.ideaDocument;
  const sourceDetails = doc
    ? ideaFields
        .filter((key) => doc.answers[key].trim())
        .map(
          (key) =>
            `### ${fieldLabels[key]}${key === "possibilities" ? " (not commitments)" : ""}\n\n${doc.answers[key]}`,
        )
        .join("\n\n")
    : "";
  const sourceQuestions =
    project.ideaQuestions || doc?.questions.map((q) => q.text) || [];
  const source = [
    sourceDetails,
    doc?.references.length
      ? `### Visual context at creation\n\n${doc.references.map((r) => `- ${line(r.name)}${r.caption ? `: ${r.caption}` : ""}`).join("\n")}`
      : "",
    sourceQuestions.length
      ? `### Open questions at creation\n\n${sourceQuestions.map((q) => `- ${line(q)}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const refs = [
    ...(project.references || []),
    ...(doc?.references || []).filter(
      (r) => !project.references?.some((p) => p.id === r.id),
    ),
  ];
  const visuals = refs.length
    ? "## Visual references\n\n" +
      refs
        .map(
          (r) =>
            `### ${line(r.name)}\n\n${r.caption}\n\n${images[r.id] ? `![${line(r.caption || r.name)}](${images[r.id]})` : `Image reference: ${r.id}`}`,
        )
        .join("\n\n")
    : "";
  const thinking = project.thinking;
  const titleFor = (id: string) =>
    project.items.find((i) => i.id === id)?.title ||
    thinking?.proposals.find((p) => p.itemId === id)?.item.title ||
    "Removed concept";
  const connections = thinking?.relations.length
    ? `\n\n## Connections\n\n${thinking.relations.map((r) => `- ${line(titleFor(r.from))} — ${r.kind.replaceAll("_", " ")} — ${line(titleFor(r.to))}: ${r.reason}`).join("\n")}`
    : "";
  const proposals = thinking?.proposals.length
    ? `\n\n## Suggestions still open\n\n${thinking.proposals.map((p) => `### ${line(p.item.title)}\n\n${p.item.body}\n\nSuggestion, not an adopted decision. ${p.reason}`).join("\n\n")}`
    : "";
  const sourceLibrary = project.sources?.length
    ? `\n\n## Project sources\n\n${project.sources
        .map(
          (source) =>
            `- ${line(source.name)} (${source.id}; ${source.mime}; ${source.size} bytes) · ${source.meaning}${source.archived ? " · archived" : ""}${source.note ? `\n  ${line(source.note)}` : ""}`,
        )
        .join("\n")}`
    : "";
  const turnContext = (t: import("./projectPlanning").PlanningTurn) => {
    const files =
      t.composer?.attachments
        .map(
          (f) =>
            `- Attachment: ${line(f.name)} (${f.id}; see attachments.json in the ZIP)`,
        )
        .join("\n") || "";
    const sources =
      t.composer?.sourceIds
        ?.map((id) => {
          const source = project.sources?.find((entry) => entry.id === id);
          return source
            ? `- Project source: ${line(source.name)} (${source.id}; see the private source in the project)`
            : `- Project source: ${id}`;
        })
        .join("\n") || "";
    const references =
      t.composer?.references
        .map((id) => `- Referenced thought: ${line(titleFor(id))}`)
        .join("\n") || "";
    const quotes =
      t.composer?.quotes
        ?.map((q) =>
          q.text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        )
        .join("\n\n") || "";
    const route = t.routing
      ? `Reasoning: ${t.composer?.reasoning || t.routing.level} / ${t.routing.level} / ${t.routing.model}`
      : "";
    return [files, sources, references, quotes, route]
      .filter(Boolean)
      .join("\n\n");
  };
  const discussion = thinking?.turns.length
    ? `\n\n## Project conversation\n\n${thinking.turns.map((t) => `### You\n\n${t.text}\n\n${turnContext(t)}\n\n${t.reply ? `### woolgather\n\n${t.reply}\n\n` : ""}${t.status === "stale" ? "Project changes from this reply were not applied because the project changed.\n" : t.status === "failed" || t.status === "cancelled" ? `Reply ${t.status}; your thought is preserved.\n` : ""}`).join("\n")}`
    : "";
  return `# ${line(project.name)}\n\n${project.description}\n\n${project.originalIdea || doc ? `## Original idea${doc?.title ? `: ${line(doc.title)}` : ""}\n\n${project.originalIdea || ""}\n\n${source}\n\n` : ""}${visuals}${sourceLibrary}\n\nRevision: ${project.revision}\n\n${sections.join("\n")}${connections}${proposals}${discussion}`;
}

export {
  agentsOf,
  conversationTurns,
  conversationsOf,
  mainConversationId,
  normalizeThinking,
  purgeConversation,
  purgeSourceReferences,
  planningAgentSchema,
  planningConversationSchema,
  planningReactionSchema,
  planningWorkActivitySchema,
  planningWorkSchema,
  projectConversationCommandSchema,
  turnConversationId,
} from "./projectConversations";
export type {
  ConversationBranch,
  PlanningAgent,
  PlanningConversation,
  PlanningReaction,
  PlanningWork,
  ProjectConversationCommand,
} from "./projectConversations";
export {
  activeProjectSources,
  projectSourceCommandSchema,
  projectSourceMeanings,
  projectSourceSchema,
  projectSourcesOf,
  sourceReferenceSchema,
  sourceUpdateSchema,
} from "./projectSources";
export type {
  ProjectSource,
  ProjectSourceCommand,
  ProjectSourceMeaning,
  SourceReference,
  SourceUpdate,
} from "./projectSources";
