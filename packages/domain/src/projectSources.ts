import { z } from "zod";

export const projectSourceMeanings = ["use", "avoid", "undecided"] as const;
export type ProjectSourceMeaning = (typeof projectSourceMeanings)[number];

/** A project-owned view of an uploaded private attachment. */
export const projectSourceSchema = z
  .object({
    id: z.uuid(),
    attachmentId: z.uuid(),
    name: z.string().min(1).max(180),
    mime: z.string().min(1).max(120),
    size: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    note: z.string().max(4000),
    meaning: z.enum(projectSourceMeanings),
    archived: z.boolean(),
    createdAt: z.string().min(1).max(80),
    updatedAt: z.string().min(1).max(80),
  })
  .strict();
export type ProjectSource = z.infer<typeof projectSourceSchema>;

export const sourceReferenceSchema = z
  .object({
    sourceId: z.uuid(),
    quote: z.string().max(2000).optional(),
  })
  .strict();
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

/** A grounded author statement that changes the durable source meaning/note. */
export const sourceUpdateSchema = z
  .object({
    sourceId: z.uuid(),
    note: z.string().max(4000).optional(),
    meaning: z.enum(projectSourceMeanings).optional(),
    sourceTurn: z.string().min(1).max(100),
    quote: z.string().min(3).max(6000),
    origin: z.literal("author"),
  })
  .strict()
  .refine((value) => value.note !== undefined || value.meaning !== undefined, {
    message: "A source update needs a note or meaning.",
  });
export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;

export const projectSourceCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("register_source"),
      sourceId: z.uuid(),
      attachmentId: z.uuid(),
      note: z.string().max(4000).default(""),
      meaning: z.enum(projectSourceMeanings).default("undecided"),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("update_source"),
      sourceId: z.uuid(),
      note: z.string().max(4000).optional(),
      meaning: z.enum(projectSourceMeanings).optional(),
    })
    .strict()
    .refine(
      (value) => value.note !== undefined || value.meaning !== undefined,
      {
        message: "No source changes",
      },
    ),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("archive_source"),
      sourceId: z.uuid(),
      archived: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("delete_source"),
      sourceId: z.uuid(),
    })
    .strict(),
]);
export type ProjectSourceCommand = z.infer<typeof projectSourceCommandSchema>;

export function projectSourcesOf(project: {
  sources?: unknown;
}): ProjectSource[] {
  if (!Array.isArray(project.sources)) return [];
  return project.sources.flatMap((value) => {
    const parsed = projectSourceSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function activeProjectSources(project: { sources?: unknown }) {
  return projectSourcesOf(project).filter((source) => !source.archived);
}
