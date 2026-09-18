import { z } from "zod";
import { categories, certainty, statuses } from "./index";
import { referencesSchema } from "./ideaDocument";
export const itemInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(12000).default(""),
    category: z.enum(categories),
    certainty: z.enum(certainty).default("stated"),
    status: z.enum(statuses).default("open"),
    answer: z.string().max(12000).default(""),
    links: z.array(z.uuid()).max(100).default([]),
  })
  .strict();
export const commandSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    expectedRevision: z.number().int().min(0),
    action: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("update_references"),
          references: referencesSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("update_project"),
          name: z.string().trim().min(1).max(120),
          description: z.string().max(12000),
          folderId: z.uuid().nullable(),
        })
        .strict(),
      z
        .object({
          type: z.literal("set_project_lifecycle"),
          lifecycle: z.enum(["active", "archived", "trashed"]),
        })
        .strict(),
      z
        .object({
          type: z.literal("create_project"),
          folderId: z.uuid().nullable().optional(),
          name: z.string().trim().max(120),
          description: z.string().max(12000),
        })
        .strict(),
      z
        .object({
          type: z.literal("rename_project"),
          name: z.string().trim().min(1).max(120),
        })
        .strict(),
      z
        .object({
          type: z.literal("add_item"),
          itemId: z.uuid(),
          item: itemInput,
        })
        .strict(),
      z
        .object({
          type: z.literal("edit_item"),
          itemId: z.uuid(),
          item: itemInput,
        })
        .strict(),
      z.object({ type: z.literal("remove_item"), itemId: z.uuid() }).strict(),
      z.object({ type: z.literal("restore_item"), itemId: z.uuid() }).strict(),
      z
        .object({
          type: z.literal("promote_answer"),
          itemId: z.uuid(),
          decisionId: z.uuid(),
        })
        .strict(),
    ]),
  })
  .strict();
