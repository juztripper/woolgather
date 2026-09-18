import { agentAvatarSchema } from "./agentIdentity";
import { agentResponsesSchema } from "./agentConversation";
import { z } from "zod";
import type { Project } from "./index";
import type { PlanningTurn, ThinkingState } from "./projectPlanning";

/** The stable conversation used by projects created before chat branches. */
export const mainConversationId = "main" as const;

const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const conversationBranchSchema = z
  .object({
    conversationId: identifier,
    turnId: z.uuid(),
    message: z.enum(["user", "assistant"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationBranch = z.infer<typeof conversationBranchSchema>;

export const planningConversationSchema = z
  .object({
    id: identifier,
    title: z.string().trim().min(1).max(120),
    // A conversation may have at most two specialists in one bounded run.
    agentIds: z.array(identifier).max(2),
    createdAt: z.string().min(1).max(80),
    updatedAt: z.string().min(1).max(80),
    archived: z.boolean(),
    branch: conversationBranchSchema.nullable(),
  })
  .strict();
export type PlanningConversation = z.infer<typeof planningConversationSchema>;

export const planningAgentSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(120),
    avatar: agentAvatarSchema.optional(),
    instructions: z.string().max(4000),
    scopeIds: z.array(z.uuid()).max(12),
    archived: z.boolean(),
    createdAt: z.string().min(1).max(80),
  })
  .strict();
export type PlanningAgent = z.infer<typeof planningAgentSchema>;

export const planningReactionSchema = z
  .object({
    user: z.enum(["like", "dislike"]).optional(),
    assistant: z.enum(["like", "dislike"]).optional(),
  })
  .strict()
  .refine((value) => value.user || value.assistant, "A reaction is required.");
export type PlanningReaction = z.infer<typeof planningReactionSchema>;

export const planningWorkActivitySchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    detail: z.string().max(6000).optional(),
    durationMs: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();
export const planningWorkSchema = z
  .object({
    startedAt: z.string().min(1).max(80).optional(),
    completedAt: z.string().min(1).max(80).optional(),
    activity: z.array(planningWorkActivitySchema).max(12),
  })
  .strict();
export type PlanningWork = z.infer<typeof planningWorkSchema>;

export const projectConversationCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("create_conversation"),
      conversationId: identifier,
      title: z.string().trim().min(1).max(120),
      agentIds: z.array(identifier).max(2),
      branch: conversationBranchSchema.nullable(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("update_conversation"),
      conversationId: identifier,
      title: z.string().trim().min(1).max(120).optional(),
      agentIds: z.array(identifier).max(2).optional(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("archive_conversation"),
      conversationId: identifier,
      archived: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("delete_conversation"),
      conversationId: identifier,
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("upsert_agent"),
      agentId: identifier,
      name: z.string().trim().min(1).max(120),
      avatar: agentAvatarSchema.optional(),
      instructions: z.string().max(4000),
      scopeIds: z.array(z.uuid()).max(12),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("archive_agent"),
      agentId: identifier,
      archived: z.boolean(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("react"),
      turnId: z.uuid(),
      message: z.enum(["user", "assistant"]),
      reaction: z.enum(["like", "dislike"]).nullable(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      action: z.literal("work"),
      turnId: z.uuid(),
      work: planningWorkSchema,
      agentResponses: agentResponsesSchema.optional(),
    })
    .strict(),
]);
export type ProjectConversationCommand = z.infer<
  typeof projectConversationCommandSchema
>;

const now = () => new Date().toISOString();

export function emptyMainConversation(at = now()): PlanningConversation {
  return {
    id: mainConversationId,
    title: "Main conversation",
    agentIds: [],
    createdAt: at,
    updatedAt: at,
    archived: false,
    branch: null,
  };
}

/**
 * Adds the additive chat fields to old project JSON in place. This keeps
 * callers that intentionally mutate `thinkingOf(project)` working while old
 * snapshots remain readable without a migration round trip.
 */
export function normalizeThinking(value: unknown): ThinkingState {
  const candidate = (value && typeof value === "object" ? value : {}) as {
    version?: unknown;
    turns?: unknown;
    relations?: unknown;
    proposals?: unknown;
    focusId?: unknown;
    view?: unknown;
    undo?: unknown;
    conversations?: unknown;
    agents?: unknown;
  };
  if (!Array.isArray(candidate.turns)) candidate.turns = [];
  if (!Array.isArray(candidate.relations)) candidate.relations = [];
  if (!Array.isArray(candidate.proposals)) candidate.proposals = [];
  if (!Array.isArray(candidate.agents)) candidate.agents = [];
  // A missing conversations field belongs to a pre-conversation project and
  // gets the implicit main slot. An explicit empty array is a durable state:
  // it is how a user deleting the main chat is represented. Do not silently
  // recreate that chat while reading the project.
  if (candidate.conversations === undefined)
    candidate.conversations = [emptyMainConversation()];
  else if (!Array.isArray(candidate.conversations))
    candidate.conversations = [];
  if (candidate.focusId === undefined) candidate.focusId = null;
  if (candidate.view === undefined) candidate.view = "map";
  if (candidate.undo === undefined) candidate.undo = null;
  if (candidate.version === undefined) candidate.version = 1;
  return candidate as unknown as ThinkingState;
}

export function conversationsOf(project: Project): PlanningConversation[] {
  return normalizeThinking(project.thinking).conversations;
}

export function agentsOf(project: Project): PlanningAgent[] {
  return normalizeThinking(project.thinking).agents;
}

export function turnConversationId(turn: PlanningTurn): string {
  return turn.conversationId || mainConversationId;
}

/**
 * Resolve a branch's ancestor prefix using the actual saved turn objects.
 * This intentionally returns references rather than cloned turns so source IDs
 * and later revision checks remain stable.
 */
export function conversationTurns(
  project: Project,
  conversationId: string = mainConversationId,
): PlanningTurn[] {
  const state = normalizeThinking(project.thinking);
  const conversations = new Map(
    state.conversations.map((conversation) => [conversation.id, conversation]),
  );
  const all = state.turns;
  const visit = (id: string, seen: Set<string>): PlanningTurn[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    const conversation = conversations.get(id);
    const own = all.filter((turn) => turnConversationId(turn) === id);
    if (!conversation?.branch) return own;
    const parentTurns = visit(conversation.branch.conversationId, seen);
    const cutoff = parentTurns.findIndex(
      (turn) => turn.id === conversation.branch!.turnId,
    );
    const prefix = cutoff < 0 ? parentTurns : parentTurns.slice(0, cutoff + 1);
    const cutoffTurn = cutoff >= 0 ? prefix[prefix.length - 1] : undefined;
    const completedAfterBranch =
      cutoffTurn?.work?.completedAt &&
      conversation.createdAt &&
      Date.parse(cutoffTurn.work.completedAt) >
        Date.parse(conversation.createdAt);
    if (
      cutoff >= 0 &&
      (conversation.branch.message === "user" || completedAfterBranch)
    ) {
      const last = prefix.length - 1;
      // A branch opened from the author message must not expose the ancestor
      // reply as if it had already been seen. Keep identity and authored text
      // for provenance while clearing response-only state in this view. The
      // same view applies to an assistant cutoff whose completion was recorded
      // after this conversation was created.
      prefix[last] = {
        ...prefix[last],
        reply: "",
        agentResponses: undefined,
        changedIds: [],
        work: undefined,
      };
    }
    return [...prefix, ...own];
  };
  return visit(conversationId, new Set());
}

function copyThinking(value: unknown): ThinkingState {
  const copied =
    value === undefined ? {} : (JSON.parse(JSON.stringify(value)) as unknown);
  return normalizeThinking(copied);
}

/**
 * Remove one durable conversation while retaining the project's independent
 * plan. Branches that depended on the removed conversation become standalone
 * conversations so an ancestor transcript cannot reappear through them.
 *
 * This helper mirrors the database purge and is also used by offline fixture
 * state. It returns a copy and never mutates the caller's thinking object.
 */
export function purgeConversation(
  value: ThinkingState,
  conversationId: string,
): ThinkingState {
  const state = copyThinking(value);
  const removedTurns = new Set(
    state.turns
      .filter((turn) => turnConversationId(turn) === conversationId)
      .map((turn) => turn.id),
  );
  const originalIndex = new Map(
    state.turns.map((turn, index) => [turn.id, index + 1]),
  );
  state.turns = state.turns.filter(
    (turn) => turnConversationId(turn) !== conversationId,
  );
  const retainedIndex = new Map(
    state.turns.map((turn, index) => [turn.id, index + 1]),
  );

  // A source update's tN identifier is the position in the full saved turn
  // list. Rebase surviving evidence or drop it when its authored turn was
  // deleted; otherwise tN could silently point at a different author message.
  state.turns = state.turns.map((turn) => {
    if (!turn.sourceUpdates?.length) {
      if (
        !turn.composer?.quotes?.some((quote) => removedTurns.has(quote.turnId))
      )
        return turn;
    }
    const next = { ...turn };
    if (next.composer?.quotes) {
      next.composer = {
        ...next.composer,
        quotes: next.composer.quotes.filter(
          (quote) => !removedTurns.has(quote.turnId),
        ),
      };
    }
    if (next.sourceUpdates) {
      next.sourceUpdates = next.sourceUpdates.flatMap((update) => {
        if (update.sourceTurn === "brief") return [update];
        const match = /^t([1-9][0-9]*)$/.exec(update.sourceTurn);
        if (!match) return [update];
        // `state.turns` has already been filtered, so use the original map to
        // resolve the source ordinal before deciding whether it survived.
        const oldId = [...originalIndex.entries()].find(
          ([, index]) => index === Number(match[1]),
        )?.[0];
        if (!oldId || removedTurns.has(oldId)) return [];
        const nextOrdinal = retainedIndex.get(oldId);
        return nextOrdinal
          ? [{ ...update, sourceTurn: `t${nextOrdinal}` }]
          : [];
      });
    }
    return next;
  });

  state.conversations = state.conversations
    .filter((conversation) => conversation.id !== conversationId)
    .map((conversation) =>
      conversation.branch &&
      (conversation.branch.conversationId === conversationId ||
        removedTurns.has(conversation.branch.turnId))
        ? { ...conversation, branch: null }
        : conversation,
    );
  const removedProposalItems = new Set(
    state.proposals
      .filter((proposal) => removedTurns.has(proposal.turnId))
      .map((proposal) => proposal.itemId),
  );
  state.proposals = state.proposals.filter(
    (proposal) => !removedTurns.has(proposal.turnId),
  );
  if (removedProposalItems.size)
    state.relations = state.relations.filter(
      (relation) =>
        !removedProposalItems.has(relation.from) &&
        !removedProposalItems.has(relation.to),
    );
  // Undo contains a copy of the latest plan state and its originating turn.
  // Once that turn is gone, retaining the copy would offer a resurrection path.
  state.undo = null;
  return state;
}

/**
 * Remove one project source from every saved turn context. Source bytes and
 * source metadata are owned by the database; this helper only handles the
 * JSON references that must not survive a source purge.
 */
export function purgeSourceReferences(
  value: ThinkingState,
  sourceId: string,
  attachmentId?: string,
): ThinkingState {
  const state = copyThinking(value);
  state.turns = state.turns.map((turn) => {
    const next = { ...turn };
    if (next.composer) {
      next.composer = {
        ...next.composer,
        sourceIds: (next.composer.sourceIds || []).filter(
          (id) => id !== sourceId,
        ),
        ...(attachmentId
          ? {
              attachments: (next.composer.attachments || []).filter(
                (attachment) => attachment.id !== attachmentId,
              ),
            }
          : {}),
      };
    }
    if (next.sourceReferences)
      next.sourceReferences = next.sourceReferences.filter(
        (reference) => reference.sourceId !== sourceId,
      );
    if (next.sourceUpdates)
      next.sourceUpdates = next.sourceUpdates.filter(
        (update) => update.sourceId !== sourceId,
      );
    return next;
  });
  state.undo = null;
  return state;
}
