import { z } from "zod";
import { blocksText, maxIdeaText } from "./ideaBlocks";
import type { ProjectSummary } from "./index";
import { ideaDocumentSchema, type IdeaDocument } from "./ideaDocument";
export type Folder = { id: string; name: string; revision: number };
export type Idea = {
  id: string;
  body: string;
  document?: IdeaDocument | null;
  revision: number;
  updatedAt: string;
  projectId: string | null;
  trashed: boolean;
  archived?: boolean;
  folderId?: string | null;
};
export type Library = { folders: Folder[]; ideas: Idea[] };
const base = {
  id: z.uuid(),
  targetId: z.uuid(),
  expectedRevision: z.number().int().min(0),
};
export const libraryCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("delete_folder") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("save_folder"),
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("save_idea"),
      folderId: z.uuid().nullable().optional(),
      body: z.string().max(maxIdeaText),
      document: ideaDocumentSchema.optional(),
    })
    .strict()
    .refine(
      (command) =>
        command.document?.version !== 2 ||
        command.body === blocksText(command.document.blocks),
      "Writing must match the document blocks.",
    ),
  z
    .object({
      ...base,
      type: z.literal("move_idea"),
      folderId: z.uuid().nullable(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("archive_idea") }).strict(),
  z.object({ ...base, type: z.literal("trash_idea") }).strict(),
  z.object({ ...base, type: z.literal("restore_idea") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("convert_idea"),
      projectId: z.uuid(),
      name: z.string().trim().max(120),
      folderId: z.uuid().nullable(),
      brief: z.string().max(12000).optional(),
      questions: z.array(z.string().trim().min(1).max(200)).max(15).optional(),
    })
    .strict(),
]);
export type LibraryCommand = z.infer<typeof libraryCommandSchema>;
export const ideaTitle = (body: string) =>
  body
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 120) || "Untitled idea";

const trashEntry = z
  .object({ id: z.uuid(), revision: z.number().int().min(1) })
  .strict();
export const deleteTrashSchema = z
  .object({
    id: z.uuid(),
    projects: z.array(trashEntry).max(1000),
    ideas: z.array(trashEntry).max(1000),
  })
  .strict()
  .refine((v) => v.projects.length + v.ideas.length > 0);
export type DeleteTrash = z.infer<typeof deleteTrashSchema>;

export type LibraryView =
  | "workspace"
  | "projects"
  | "ideas"
  | "recent"
  | "archive"
  | "trash"
  | `folder:${string}`;
export type LibraryEntry =
  { kind: "project"; item: ProjectSummary } | { kind: "idea"; item: Idea };
export const entryName = (entry: LibraryEntry) =>
  entry.kind === "project"
    ? entry.item.name
    : entry.item.document?.title.trim() || ideaTitle(entry.item.body);
export const entryLifecycle = (entry: LibraryEntry) =>
  entry.kind === "project"
    ? entry.item.lifecycle || "active"
    : entry.item.trashed
      ? "trashed"
      : entry.item.archived
        ? "archived"
        : "active";
export function libraryEntries(
  view: LibraryView,
  projects: ProjectSummary[],
  ideas: Idea[],
  recent: string[],
  query = "",
  sort = "modified",
): LibraryEntry[] {
  const entries: LibraryEntry[] = [
    ...projects.map((item) => ({ kind: "project" as const, item })),
    ...ideas.map((item) => ({ kind: "idea" as const, item })),
  ];
  const state =
    view === "trash" ? "trashed" : view === "archive" ? "archived" : "active";
  return entries
    .filter((entry) => {
      if (entryLifecycle(entry) !== state) return false;
      if (view === "projects" && entry.kind !== "project") return false;
      if (view === "ideas" && entry.kind !== "idea") return false;
      if (view === "workspace" && entry.item.folderId) return false;
      if (view.startsWith("folder:") && entry.item.folderId !== view.slice(7))
        return false;
      if (view === "recent" && !recent.includes(entry.item.id)) return false;
      const text =
        entryName(entry) +
        " " +
        (entry.kind === "project" ? entry.item.description : entry.item.body);
      return text.toLowerCase().includes(query.toLowerCase());
    })
    .sort((a, b) =>
      view === "recent"
        ? recent.indexOf(a.item.id) - recent.indexOf(b.item.id)
        : sort === "name"
          ? entryName(a).localeCompare(entryName(b))
          : Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt),
    );
}
