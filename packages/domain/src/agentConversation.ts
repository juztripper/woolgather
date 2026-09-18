import { z } from "zod";
import { agentAvatarSchema } from "./agentIdentity";

const agentId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

// Null text is an actual participant choosing to listen, never an inferred read.
export const agentResponseSchema = z
  .object({
    agentId,
    name: z.string().min(1).max(120),
    avatar: agentAvatarSchema.optional(),
    text: z.string().trim().min(1).max(3500).nullable(),
    replyToAgentId: agentId.nullable(),
    createdAt: z.string().min(1).max(80),
  })
  .strict();
export const agentResponsesSchema = z.array(agentResponseSchema).max(3);
export type AgentResponse = z.infer<typeof agentResponseSchema>;

/** Text fallback for exports, old clients, search, quotes and model history. */
export function agentTranscript(responses: AgentResponse[]): string {
  return (
    responses
      .filter((r) => r.text)
      .map((r) => `${r.name}: ${r.text}`)
      .join("\n\n") ||
    `Read by ${[...new Set(responses.map((r) => r.name))].join(", ")}.`
  );
}
