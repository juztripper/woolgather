import { z } from "zod";

export const agentAvatars = [
  "sprout",
  "orbit",
  "moss",
  "spark",
  "pebble",
  "ripple",
] as const;
export const agentAvatarSchema = z.enum(agentAvatars);
export type AgentAvatarId = z.infer<typeof agentAvatarSchema>;

/** Existing agents get a stable identity without rewriting their saved data. */
export function agentAvatar(id: string, avatar?: string): AgentAvatarId {
  if (agentAvatarSchema.safeParse(avatar).success)
    return avatar as AgentAvatarId;
  let hash = 0;
  for (const character of id)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return agentAvatars[hash % agentAvatars.length];
}
