import { z } from "zod";

export const reasoningLevels = ["quick", "thoughtful", "deep"] as const;
export const composerSchema = z
  .object({
    reasoning: z.enum(["auto", ...reasoningLevels]).default("auto"),
    modelPreference: z.enum(["auto", "luna"]).optional(),
    autoCeiling: z.enum(reasoningLevels).default("thoughtful"),
    tool: z
      .enum(["discuss", "alternatives", "compare", "challenge", "next_steps"])
      .default("discuss"),
    attachments: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: z.string().min(1).max(240),
            mime: z.string().max(120),
            size: z
              .number()
              .int()
              .min(1)
              .max(20 * 1024 * 1024),
          })
          .strict(),
      )
      .max(6)
      .default([]),
    // These are durable IDs selected by the composer. The visible @label is
    // authored text; routing never reparses a mutable name.
    agentIds: z
      .array(z.string().min(1).max(80))
      .max(2)
      .default([])
      .refine((values) => new Set(values).size === values.length),
    // Project source IDs resolve through the owned source catalog. Their
    // private attachment bytes are added through the existing input path.
    sourceIds: z
      .array(z.uuid())
      .max(6)
      .default([])
      .refine((values) => new Set(values).size === values.length),
    references: z.array(z.uuid()).max(8).default([]),
    quotes: z
      .array(
        z
          .object({ turnId: z.uuid(), text: z.string().min(1).max(2000) })
          .strict(),
      )
      .max(4)
      .default([]),
  })
  .strict();
export type ComposerOptions = z.infer<typeof composerSchema>;
export const defaultComposer = (): ComposerOptions => composerSchema.parse({});
export const planningModes = {
  quick: {
    label: "Quick",
    model: "gpt-5.6-luna",
    effort: "none",
    output: 3000,
    description: "Small questions and straightforward changes · lowest usage",
  },
  thoughtful: {
    label: "Thoughtful",
    model: "gpt-5.6-sol",
    effort: "low",
    output: 6000,
    description: "Develop ideas and weigh trade-offs · standard usage",
  },
  deep: {
    label: "Deep",
    model: "gpt-5.6-sol",
    effort: "medium",
    output: 8000,
    description: "Work through difficult decisions · higher usage",
  },
} as const;
export const planningTools = {
  discuss: {
    label: "Discuss",
    instruction: "Continue the author's discussion naturally.",
  },
  alternatives: {
    label: "Explore alternatives",
    instruction:
      "Explore meaningfully different approaches. Explain trade-offs and what would make each worth choosing. Keep them as suggestions, not accepted decisions.",
  },
  compare: {
    label: "Compare approaches",
    instruction:
      "Compare the approaches against the author's goals, constraints and uncertainties. Identify missing evidence. Do not invent a winner or silently commit an option.",
  },
  challenge: {
    label: "Challenge assumptions",
    instruction:
      "Examine important assumptions and failure cases constructively. Distinguish known constraints from hypotheses and suggest ways to test them.",
  },
  next_steps: {
    label: "Identify next steps",
    instruction:
      "Suggest a small, ordered set of actionable next steps based on the current project. Keep new commitments as proposals.",
  },
} as const;
export function resolveReasoning(options: ComposerOptions, text: string) {
  if (options.reasoning !== "auto") return options.reasoning;
  // Auto selects the full available range without a separate user ceiling.
  // autoCeiling remains accepted only for saved-message compatibility.
  const desired =
    options.tool === "compare" ||
    options.tool === "challenge" ||
    text.length > 4000
      ? "deep"
      : options.tool !== "discuss" ||
          options.attachments.length ||
          options.references.length ||
          options.quotes.length ||
          text.length > 240
        ? "thoughtful"
        : "quick";
  return desired;
}
export function attachmentReading(name: string, mime: string) {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime))
    return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (
    /\.(txt|md|markdown|csv|json|yaml|yml|xml|html|css|js|ts|tsx|jsx|py|sql|log)$/i.test(
      name,
    )
  )
    return "text";
  return "reference";
}
