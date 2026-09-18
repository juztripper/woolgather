import type { PlanningLiveEvent } from "../../../packages/domain/src/planningStream";
import { projectDeletionError } from "./projectDeletionError";
import { accountPlan, planAction, type PlanEnv } from "./plans";
import {
  actionCreditLimit,
  planRoute,
  type PlanSnapshot,
} from "../../../packages/domain/src/plans";
import { planningFailure, type PlanningStage } from "./planningFailure";
import { stableJson } from "../../../packages/domain/src/stableJson";
import {
  agentTranscript,
  type AgentResponse,
} from "../../../packages/domain/src/agentConversation";
import {
  acceptGroupResponse,
  groupParticipantRequest,
} from "./groupConversation";
import {
  composerSchema,
  defaultComposer,
  resolveReasoning,
  planningModes,
  type ComposerOptions,
} from "../../../packages/domain/src/planningComposer";
import {
  ownedAttachments,
  appendPlanningAttachments,
  multimodalReservation,
  type AttachmentLoader,
} from "./planningAttachments";
import { z } from "zod";
import type { Project } from "../../../packages/domain/src";
import {
  activeProjectSources,
  projectSourceCommandSchema,
  type ProjectSource,
} from "../../../packages/domain/src/projectSources";
import {
  projectOpeningText,
  preparePlanningResult,
  planningChangeSummary,
  retainPlanningUndo,
  PlanningUpdateError,
  thinkingOf,
  planningToolSchema,
} from "../../../packages/domain/src/projectPlanning";
import { fetchPlanningTool, planningRequest } from "./openaiPlanning";
import { parseProjectScope, projectScopeRequest } from "./projectScope";
import { normalizeProjectVoiceHistory } from "./projectVoice";
import {
  projectConversationCommandSchema,
  conversationsOf,
  agentsOf,
  type PlanningWork,
} from "../../../packages/domain/src/projectConversations";
import {
  enablePlanningTools,
  consultationAgents,
  consultationSchema,
  adviceRequest,
  adviceSchema,
  appendToolResult,
  readConversation,
  referencedSource,
  searchProjectSources,
  sourceById,
  enforceAgentScope,
  agentConversationSchema,
  type AgentReport,
} from "./planningAgents";
import {
  GuidanceFailure,
  reservationMicrousd,
  type GuidanceUsage,
} from "./openaiGuidance";
import {
  hashGuidance,
  repeatGuidanceRpc,
  type GuidanceRpc,
} from "./ideaGuidance";

export type PlanningEnv = PlanEnv & {
  PROJECT_PLANNING_ENABLED?: string;
  PROJECT_PLANNING_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  ACCOUNT_ACTION_SECRET?: string;
};
const composerIdentity = (c: ReturnType<typeof defaultComposer>) =>
  stableJson({
    ...composerSchema.parse(c),
    attachments: c.attachments.map((a) => a.id),
  });
const legacyComposer = () => ({
  ...defaultComposer(),
  reasoning: "thoughtful" as const,
});
function sourceAttachmentOptions(
  options: ComposerOptions,
  project: Project,
): ComposerOptions {
  const selected = activeProjectSources(project).filter((source) =>
    options.sourceIds.includes(source.id),
  );
  if (selected.length !== options.sourceIds.length)
    throw new Error(
      "A selected project source is unavailable. Remove it or restore the source.",
    );
  const attachments = [
    ...options.attachments,
    ...selected.map((source) => ({
      id: source.attachmentId,
      name: source.name,
      mime: source.mime,
      size: source.size,
    })),
  ];
  if (new Set(attachments.map((attachment) => attachment.id)).size > 6)
    throw new Error("Select up to six files for one discussion.");
  const seen = new Set<string>();
  return {
    ...options,
    attachments: attachments.filter((attachment) => {
      if (seen.has(attachment.id)) return false;
      seen.add(attachment.id);
      return true;
    }),
  };
}
export const planningEnabled = (env: PlanningEnv) =>
  env.PROJECT_PLANNING_ENABLED === "true" &&
  !!env.OPENAI_API_KEY &&
  !!env.ACCOUNT_ACTION_SECRET;
const requestSchema = z
  .object({
    action: z.enum([
      "start",
      "send",
      "retry",
      "status",
      "cancel",
      "adopt",
      "dismiss",
      "undo",
      "connect",
      "disconnect",
    ]),
    id: z.uuid(),
    projectId: z.uuid(),
    revision: z.number().int().nonnegative(),
    turnId: z.uuid().optional(),
    conversationId: z.string().min(1).max(80).optional(),
    text: z.string().trim().min(1).max(12000).optional(),
    mode: z.enum(["assist", "note"]).optional(),
    focusId: z.uuid().nullable().optional(),
    composer: composerSchema.optional(),
    maxCredits: z.number().int().min(1).max(500).optional(),
    proposalId: z.uuid().optional(),
    relationId: z.string().max(200).optional(),
    from: z.uuid().optional(),
    to: z.uuid().optional(),
    kind: z
      .enum([
        "part_of",
        "requires",
        "enables",
        "affects",
        "alternative_to",
        "sequence",
      ])
      .optional(),
    reason: z.string().max(1000).optional(),
  })
  .strict();
const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export const signPlanning = (secret: string, owner: string, payload: string) =>
  sign(secret, `woolgather.planning.v1:${owner}:${payload}`);
export const signPlanningSettlement = (secret: string, payload: string) =>
  sign(secret, `woolgather.planning.settle.v1:${payload}`);
const messageFor = (code?: string) =>
  code === "PT429"
    ? "Your planning allowance has been reached. You can keep adding and editing thoughts."
    : code === "PT425"
      ? "A previous reply is still being checked. Your thought is saved."
      : code === "PT409"
        ? "The project changed. Reload the saved project before continuing."
        : code === "42501"
          ? "Discussion is unavailable for this account. You can keep adding and editing thoughts."
          : "The reply could not be confirmed. Your writing is saved; check the saved conversation before trying again.";

export async function projectPlanning(
  rpc: GuidanceRpc,
  settleRpc: GuidanceRpc,
  env: PlanningEnv,
  owner: string,
  raw: unknown,
  send: typeof fetch = fetch,
  loadAttachment?: AttachmentLoader,
  onProgress?: (event: PlanningLiveEvent) => void,
) {
  const sourceCommand = projectSourceCommandSchema.safeParse(raw);
  const metadata = projectConversationCommandSchema.safeParse(raw);
  const parsed = sourceCommand.success
    ? sourceCommand
    : metadata.success && metadata.data.action !== "work"
      ? metadata
      : requestSchema.safeParse(raw);
  if (!parsed.success)
    return reply({ error: "This planning request is incomplete." }, 422);
  if (sourceCommand.success) {
    const result = await repeatGuidanceRpc(rpc, "project_source_command", {
      command: sourceCommand.data,
    });
    if (result.error && sourceCommand.data.action === "delete_source") {
      const failure = projectDeletionError(result.error, "source");
      return reply({ error: failure.error }, failure.status);
    }
    if (result.error)
      return reply(
        { error: messageFor(result.error.code) },
        result.error.code === "PT409"
          ? 409
          : result.error.code === "P0002"
            ? 404
            : 422,
      );
    return reply({ project: result.data, enabled: planningEnabled(env) });
  }
  if (metadata.success && metadata.data.action !== "work") {
    if (
      "agentIds" in metadata.data &&
      (metadata.data.agentIds?.length || 0) > 2
    )
      return reply(
        { error: "Choose up to two agents for a conversation." },
        422,
      );
    const result = await repeatGuidanceRpc(rpc, "project_planning_command", {
      command: metadata.data,
    });
    if (result.error && metadata.data.action === "delete_conversation") {
      const failure = projectDeletionError(result.error, "chat");
      return reply({ error: failure.error }, failure.status);
    }
    if (result.error)
      return reply(
        { error: messageFor(result.error.code) },
        result.error.code === "PT409"
          ? 409
          : result.error.code === "P0002"
            ? 404
            : 422,
      );
    return reply({ project: result.data, enabled: planningEnabled(env) });
  }
  const input = requestSchema.parse(raw);
  const fetchProject = async () => {
    const value = await rpc("project_snapshot", {
      project_id: input.projectId,
    });
    if (value.error || !value.data) throw new Error("Project unavailable.");
    return value.data as Project;
  };
  const command = async (value: Record<string, unknown>) =>
    repeatGuidanceRpc(rpc, "project_planning_command", { command: value });
  const budget = async (value: Record<string, unknown>) => {
    const payload = JSON.stringify(value);
    return repeatGuidanceRpc(rpc, "project_planning_budget", {
      payload,
      signature: await signPlanning(env.ACCOUNT_ACTION_SECRET!, owner, payload),
    });
  };
  let project: Project;
  try {
    project = await fetchProject();
  } catch {
    return reply({ error: "This project is unavailable." }, 404);
  }
  if (input.action === "status") {
    // Reconcile an interrupted request without ever starting more paid work.
    const pending = thinkingOf(project).turns.find(
      (t) => t.status === "pending",
    );
    if (
      pending &&
      env.ACCOUNT_ACTION_SECRET &&
      Date.now() - Date.parse(pending.createdAt) > 210_000
    ) {
      const checked = await budget({
        action: "status",
        projectId: project.id,
        turnId: pending.id,
      });
      const status = (checked.data as { status?: string })?.status;
      if (
        !checked.error &&
        status &&
        !["reserved", "running"].includes(status)
      ) {
        const failed = await command({
          id: crypto.randomUUID(),
          projectId: project.id,
          revision: project.revision,
          action: "fail",
          turnId: pending.id,
        });
        if (!failed.error) project = failed.data as Project;
      }
    }
    return reply({ project, enabled: planningEnabled(env) });
  }
  if (!["start", "send", "retry"].includes(input.action)) {
    const result = await command({ ...input, action: input.action });
    if (result.error)
      return reply(
        { error: messageFor(result.error.code) },
        result.error.code === "PT409" ? 409 : 422,
      );
    return reply({ project: result.data, enabled: planningEnabled(env) });
  }
  // The opening belongs to the project, not a browser request. A second create
  // acknowledgement or a remount can only recover this same exchange.
  const turnId =
    input.action === "start" ? project.id : input.turnId || input.id;
  const existing = thinkingOf(project).turns.find((t) => t.id === turnId);
  if (input.action === "start") {
    if (thinkingOf(project).turns.length)
      return reply({
        project,
        enabled: planningEnabled(env),
        pending: existing?.status === "pending",
      });
    input.text = projectOpeningText(project);
    input.mode =
      input.mode === "note" || !planningEnabled(env) ? "note" : "assist";
    input.focusId = null;
    input.conversationId = "main";
  }
  if (input.action === "retry") {
    if (!existing)
      return reply({ error: "This saved thought is unavailable." }, 404);
    input.text = existing.text;
    input.composer = existing.composer;
    input.focusId = existing.focusId;
    input.conversationId = existing.conversationId || "main";
    input.mode = "assist";
    if (existing.status === "pending" || existing.status === "complete")
      return reply({
        project,
        enabled: planningEnabled(env),
        pending: existing.status === "pending",
      });
    if (env.ACCOUNT_ACTION_SECRET) {
      const checked = await budget({
        action: "status",
        projectId: project.id,
        turnId,
      });
      if (
        checked.error ||
        ["reserved", "running", "unknown"].includes(
          (checked.data as { status?: string })?.status || "",
        )
      )
        return reply({
          project,
          enabled: planningEnabled(env),
          notice: messageFor("PT425"),
        });
    }
  } else if (existing) {
    if (
      (existing.conversationId || "main") !==
        (input.conversationId || "main") ||
      existing.text !== input.text ||
      composerIdentity(existing.composer || legacyComposer()) !==
        composerIdentity(input.composer || legacyComposer())
    )
      return reply({ error: "This retry contains different writing." }, 409);
    return reply({
      project,
      enabled: planningEnabled(env),
      pending: existing.status === "pending",
    });
  }
  const conversationId = input.conversationId || "main";
  const conversationExists = conversationsOf(project).some(
    (c) => c.id === conversationId && !c.archived,
  );
  const detachedPlanNote =
    input.action === "send" &&
    !conversationExists &&
    input.mode === "note" &&
    conversationId === "main";
  if (!conversationExists && !detachedPlanNote)
    return reply(
      {
        error:
          "This conversation is unavailable. Start another conversation before writing.",
      },
      422,
    );
  const activeConversation = conversationsOf(project).find(
    (c) => c.id === conversationId,
  ) || {
    agentIds: [] as string[],
    title: "",
  };
  // Decide before the turn command installs its immediate text-preview title.
  // Existing chats and deliberately named conversations keep their titles.
  const generateTitle =
    input.action !== "retry" &&
    conversationExists &&
    !thinkingOf(project).turns.some(
      (turn) => (turn.conversationId || "main") === conversationId,
    ) &&
    [
      "Main conversation",
      "New conversation",
      ...agentsOf(project)
        .filter(
          (agent) =>
            activeConversation.agentIds.length === 1 &&
            activeConversation.agentIds[0] === agent.id,
        )
        .map((agent) => agent.name),
    ].includes(activeConversation.title);
  if (
    activeConversation.agentIds.some(
      (id) => !agentsOf(project).some((a) => a.id === id && !a.archived),
    )
  )
    return reply(
      {
        error:
          "Restore this conversation's agent before continuing, or start another conversation.",
      },
      422,
    );
  if (!input.text) return reply({ error: "Write something first." }, 422);
  let options = input.composer || legacyComposer();
  try {
    options = await ownedAttachments(options, rpc);
    sourceAttachmentOptions(options, project);
    if (
      options.quotes.some(
        (q) =>
          !thinkingOf(project).turns.some(
            (t) =>
              t.id === q.turnId &&
              (t.text.includes(q.text) || t.reply.includes(q.text)),
          ),
      )
    )
      throw new Error(
        "A quoted passage is no longer available. Quote it again from the conversation.",
      );
    if (
      options.references.some(
        (id) => !project.items.some((i) => i.id === id && !i.removed),
      )
    )
      throw new Error(
        "A referenced thought is no longer available. Choose it again.",
      );
  } catch (e) {
    return reply({ error: (e as Error).message }, 422);
  }
  const level = resolveReasoning(options, input.text);
  let plan: PlanSnapshot | undefined;
  if (env.PLAN_ALLOWANCES_ENABLED === "true" && input.mode !== "note") {
    try {
      plan = await accountPlan(rpc);
    } catch (error) {
      return reply({ error: (error as Error).message }, 503);
    }
  }
  if (
    plan?.enabled &&
    input.action !== "start" &&
    input.maxCredits === undefined
  )
    return reply(
      {
        error:
          "Refresh your allowance to see this reply’s credit limit. Your draft is kept.",
      },
      409,
    );
  const selected = plan?.enabled
    ? planRoute(level, plan.tier, options.modelPreference)
    : options.modelPreference === "luna"
      ? planRoute(level, "paid", "luna")
      : planningModes[level];
  const creditCap = plan?.enabled
    ? Math.min(
        input.maxCredits ?? 500,
        actionCreditLimit(
          level,
          selected.model,
          plan.credits,
          activeConversation.agentIds.length > 1,
        ),
      )
    : undefined;
  if (creditCap === 0)
    return reply(
      {
        error:
          "Your credit allowance has been reached. Your draft is kept, and manual work remains available.",
      },
      429,
    );
  // A client sends the displayed ceiling. Legacy automatic openings receive
  // the same bounded server default; the conversion dialog discloses the cap.
  const creditActionId = input.id;
  const planBeforeSend = structuredClone({
    items: project.items,
    thinking: thinkingOf(project),
    revision: project.revision,
  });
  const started = await command({
    // A concurrent start must take the revision-conflict path, even when both
    // HTTP requests reuse a nonce. Only the winning writer reserves a reply.
    id: input.action === "start" ? crypto.randomUUID() : input.id,
    projectId: input.projectId,
    revision: input.revision,
    action: input.action === "retry" ? "retry" : "turn",
    turnId,
    text: input.text,
    conversationId,
    mode: input.mode || "assist",
    composer: options,
    routing: { level, model: selected.model, effort: selected.effort },
    focusId: input.focusId || null,
  });
  if (started.error && input.action === "start") {
    const saved = await fetchProject();
    if (thinkingOf(saved).turns.length)
      return reply({
        project: saved,
        enabled: planningEnabled(env),
        pending: thinkingOf(saved).turns.some(
          (t) => t.id === turnId && t.status === "pending",
        ),
      });
  }
  if (started.error)
    return reply(
      { error: messageFor(started.error.code) },
      started.error.code === "PT409" ? 409 : 422,
    );
  project = started.data as Project;
  if (input.mode === "note")
    return reply({ project, enabled: planningEnabled(env) });
  const fail = async (keptReply?: string, notice?: string) => {
    let fresh = await fetchProject();
    const turn = thinkingOf(fresh).turns.find((entry) => entry.id === turnId);
    // A cancellation or a completion whose acknowledgement was lost wins.
    if (!turn || turn.status !== "pending") return fresh;
    if (notice) {
      const recorded = await command({
        id: crypto.randomUUID(),
        projectId: fresh.id,
        revision: fresh.revision,
        action: "work",
        turnId,
        work: {
          ...turn.work,
          activity: [
            ...(turn.work?.activity || []).slice(-11),
            { label: "Reply stopped", detail: notice },
          ],
        },
      });
      fresh = recorded.error
        ? await fetchProject()
        : (recorded.data as Project);
      if (
        thinkingOf(fresh).turns.find((entry) => entry.id === turnId)?.status !==
        "pending"
      )
        return fresh;
    }
    const failed = await command({
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: fresh.revision,
      action: "fail",
      turnId,
      ...(keptReply ? { reply: keptReply } : {}),
    });
    return (failed.data as Project) || fresh;
  };
  if (!planningEnabled(env))
    return reply({
      project: await fail(),
      enabled: false,
      notice:
        "Discussion is not connected. Your thought is saved; you can add it to the map or continue writing.",
    });
  const workStartedAt = new Date().toISOString();
  const voiceContext = async (chatId: string) => {
    try {
      const result = await rpc("project_voice_history", {
        project_id: project.id,
        conversation_id: chatId,
      });
      if (result.error)
        return "Voice history is unavailable; do not assume its contents.";
      return normalizeProjectVoiceHistory(result.data)
        .flatMap((session) =>
          session.transcript.map(
            (fragment) =>
              `${fragment.speaker === "user" ? "Author" : "Assistant"}: ${fragment.text}`,
          ),
        )
        .join("\n")
        .slice(-12000);
    } catch {
      return "Voice history is unavailable; do not assume its contents.";
    }
  };
  const activity: PlanningWork["activity"] = [];
  const group =
    activeConversation.agentIds.length > 1
      ? activeConversation.agentIds.map((id) =>
          agentsOf(project).find((a) => a.id === id && !a.archived)!,
        )
      : [];
  const agentResponses: AgentResponse[] = [];
  const deadline = Date.now() + 165_000;
  let spent = 0;
  let generatedReply: string | undefined;
  let sourceToolRounds = 0;
  // Every model call has its own bounded reservation and settlement. A helper
  // cannot consume another model's reservation or leave an unmetered retry.
  let currentSummary = "";
  let currentCommentary = "";
  let livePhase: "working" | "answering" | undefined;
  let workCompletedAt: string | undefined;
  let stage: PlanningStage = "admission";
  const phase = (next: "working" | "answering") => {
    if (livePhase === next) return;
    livePhase = next;
    const at = new Date().toISOString();
    workCompletedAt = next === "answering" ? at : undefined;
    onProgress?.({ type: "phase", phase: next, at });
  };
  const directAgent =
    activeConversation.agentIds.length === 1
      ? agentsOf(project).find((a) => a.id === activeConversation.agentIds[0])
      : undefined;
  const execute = async (
    body: string,
    participant?: typeof directAgent,
    visible = true,
  ) => {
    if (Date.now() >= deadline)
      throw new Error("The conversation reached its work limit.");
    if (new TextEncoder().encode(body).length > 160000)
      throw new Error(
        "This discussion has too much context for one request. Your writing is saved.",
      );
    const request = JSON.parse(body);
    const multimodal = request.input.some((entry: { content?: unknown }) =>
      Array.isArray(entry.content),
    );
    const reservation = multimodal
      ? await multimodalReservation(
          body,
          env.OPENAI_API_KEY!,
          env.OPENAI_PROJECT_ID,
          send,
        )
      : reservationMicrousd(body);
    if (spent + reservation > 1500000)
      throw new Error(
        "This discussion reached its usage limit. Your writing is saved.",
      );
    const runId = crypto.randomUUID(),
      attemptId = crypto.randomUUID(),
      capability = crypto.randomUUID() + crypto.randomUUID();
    const reserved = await budget({
      action: "reserve",
      runId,
      projectId: project.id,
      turnId,
      revision: project.revision,
      fingerprint: await hashGuidance(body),
      model: request.model,
      maxOutputTokens: request.max_output_tokens,
      reserveMicrousd: reservation,
      ...(plan?.enabled ? { creditActionId } : {}),
      capabilityHash: await hashGuidance(capability),
    });
    if (reserved.error) throw new Error(messageFor(reserved.error.code));
    const claimed = await budget({ action: "claim", runId, attemptId });
    if (claimed.error || !(claimed.data as { claimed?: boolean })?.claimed)
      throw new Error(
        "Your writing is saved. The reply is still being checked.",
      );
    const settle = async (
      status: string,
      usage?: GuidanceUsage,
      errorCode?: string,
    ) => {
      const payload = JSON.stringify({
        runId,
        attemptId,
        capability,
        status,
        ...(usage ? { usage } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
      return repeatGuidanceRpc(settleRpc, "settle_project_planning", {
        payload,
        signature: await signPlanningSettlement(
          env.ACCOUNT_ACTION_SECRET!,
          payload,
        ),
      });
    };
    let usage: GuidanceUsage | undefined;
    currentSummary = "";
    currentCommentary = "";
    const speaker = participant || directAgent;
    const label = (
      participant ? `${participant.name} is thinking` : "Thinking"
    ).slice(0, 120);
    let summaryLength = 0,
      replyLength = 0;
    let replyStarted = false;
    try {
      const result = await fetchPlanningTool(
        body,
        env.OPENAI_API_KEY!,
        env.OPENAI_PROJECT_ID,
        send,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        onProgress && visible
          ? (event) => {
              if (
                event.kind === "commentary" &&
                !replyStarted &&
                (participant || !group.length) &&
                request.tools.some(
                  (tool: { name: string }) =>
                    tool.name === "develop_project" ||
                    tool.name === "respond_to_group",
                )
              ) {
                const delta = event.text.slice(
                  0,
                  Math.max(0, 6000 - currentCommentary.length),
                );
                currentCommentary += delta;
                if (delta) {
                  phase("working");
                  onProgress({
                    type: "activity",
                    id: `${runId}:commentary`,
                    label: (speaker
                      ? `${speaker.name} is working`
                      : "Working"
                    ).slice(0, 120),
                    detail: delta,
                  });
                }
              }
              if (event.kind === "summary" && !replyStarted) {
                const delta = event.text.slice(
                  0,
                  Math.max(0, 6000 - summaryLength),
                );
                summaryLength += delta.length;
                currentSummary += delta;
                if (delta) {
                  phase("working");
                  onProgress({
                    type: "activity",
                    id: runId,
                    label,
                    detail: delta,
                  });
                }
              }
              if (event.kind === "tool") {
                const tools: Record<string, string> = {
                  search_project_sources: "Searching project sources",
                  read_project_source: "Reading a project source",
                  reference_project_source: "Referencing a project source",
                  read_conversation: "Reading conversation history",
                  consult_agents: "Consulting agents",
                  create_agent_conversation: "Creating an agent conversation",
                };
                if (tools[event.tool || ""]) {
                  phase("working");
                  onProgress({
                    type: "activity",
                    id: `${runId}:tool`,
                    label: tools[event.tool!].slice(0, 120),
                    detail: "",
                  });
                }
              }
              if (event.kind === "text" && (participant || !group.length)) {
                const delta = event.text.slice(
                  0,
                  Math.max(0, (participant ? 3500 : 12000) - replyLength),
                );
                replyLength += delta.length;
                if (delta) {
                  replyStarted = true;
                  phase("answering");
                  onProgress({
                    type: "text",
                    id: runId,
                    index: participant ? agentResponses.length : 0,
                    text: delta,
                    ...(speaker
                      ? {
                          speaker: {
                            id: speaker.id,
                            name: speaker.name,
                            avatar: speaker.avatar,
                          },
                        }
                      : {}),
                  });
                }
              }
            }
          : undefined,
      );
      usage = result.usage;
      const settled = await settle("completed", usage);
      if (settled.error)
        throw new Error(
          "The reply's usage could not be confirmed. Reopen the conversation before trying again.",
        );
      spent += usage.costMicrousd;
      return result;
    } catch (error) {
      const known =
        usage || (error instanceof GuidanceFailure ? error.usage : undefined);
      if (!usage)
        await settle(
          known ? "failed" : "unknown",
          known,
          error instanceof GuidanceFailure
            ? error.code
            : "planning_interrupted",
        );
      // Transport/abort errors are not always GuidanceFailure instances, but
      // a claimed call without usage still has an unknown paid outcome.
      if (!known && !(error instanceof GuidanceFailure))
        throw new GuidanceFailure("planning_interrupted");
      throw error;
    }
  };
  const record = async (label: string, startedAt: number, detail?: string) => {
    activity.push({
      label: label.slice(0, 120),
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(detail || currentSummary.trim() || currentCommentary.trim()
        ? {
            detail: [currentCommentary.trim(), currentSummary.trim(), detail]
              .filter(Boolean)
              .join("\n\n")
              .slice(0, 6000),
          }
        : {}),
    });
    const saved = await command({
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "work",
      turnId,
      work: {
        startedAt: workStartedAt,
        activity,
        ...(workCompletedAt ? { completedAt: workCompletedAt } : {}),
      },
      ...(agentResponses.length ? { agentResponses } : {}),
    });
    if (saved.error)
      throw new Error(
        "The project changed while working. Reopen the conversation to continue.",
      );
    project = saved.data as Project;
  };
  try {
    if (plan?.enabled) {
      const reserved = await planAction(
        rpc,
        env.ACCOUNT_ACTION_SECRET!,
        owner,
        {
          action: "reserve",
          id: creditActionId,
          projectId: project.id,
          turnId,
          fingerprint: await hashGuidance(
            stableJson({
              turnId,
              text: input.text,
              composer: options,
              model: selected.model,
              maxCredits: creditCap,
            }),
          ),
          model: selected.model,
          maxCredits: creditCap,
        },
      );
      if (reserved.error)
        throw new Error(
          reserved.error.message ||
            "Your credits could not be reserved. Your writing is saved.",
        );
    }
    if (input.action === "retry") {
      const resetWork = await command({
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "work",
        turnId,
        work: { startedAt: workStartedAt, activity: [] },
      });
      if (resetWork.error)
        throw new Error(
          "The project changed while working. Reopen the conversation to continue.",
        );
      project = resetWork.data as Project;
    }
    // Admission uses the cheapest bounded route before attachments, selected
    // reasoning or specialist fan-out. Invalid/unknown checks never fail open.
    const admission = await execute(
      projectScopeRequest(project, turnId, generateTitle),
      undefined,
      false,
    );
    if (admission.name !== "check_project_scope")
      throw new Error(
        "The message check was incomplete. Your writing is saved.",
      );
    const scope = parseProjectScope(admission.value);
    if (scope.decision === "allow" && plan?.enabled) {
      const allowed = await planAction(rpc, env.ACCOUNT_ACTION_SECRET!, owner, {
        action: "allow",
        id: creditActionId,
      });
      if (allowed.error)
        throw new Error(
          "Your allowance could not be confirmed. Your writing is saved.",
        );
    }
    if (generateTitle && scope.title) {
      const named = await command({
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "update_conversation",
        conversationId,
        title: scope.title,
      });
      // A conflicting rename is never overwritten. Normal reply recovery
      // handles concurrent project edits using the same revision boundary.
      if (!named.error && named.data) project = named.data as Project;
    }
    if (scope.decision !== "allow") {
      generatedReply = scope.reply;
      const prepared = preparePlanningResult(project, turnId, {
        reply: scope.reply,
        concepts: [],
        remove: [],
        relations: [],
        removeRelations: [],
        dismissProposals: [],
        sourceReferences: [],
        sourceUpdates: [],
        focus: thinkingOf(project).focusId,
        view: thinkingOf(project).view,
      });
      // A brief reply, with no invented work, agent responses or plan changes.
      const completed = await command({
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "complete",
        turnId,
        items: prepared.items,
        thinking: prepared.thinking,
        reply: prepared.reply,
      });
      if (completed.error)
        throw new Error(
          "The project changed. Your reply is kept; reopen the conversation.",
        );
      const savedTurn = thinkingOf(completed.data as Project).turns.find(
        (turn) => turn.id === turnId,
      );
      if (savedTurn?.status === "complete" && savedTurn.reply === scope.reply) {
        phase("answering");
        onProgress?.({
          type: "text",
          id: `scope:${turnId}`,
          index: 0,
          text: scope.reply,
        });
      }
      return reply({ project: completed.data, enabled: true });
    }
    stage = "planning";
    const providerOptions = sourceAttachmentOptions(options, project);
    let body = enablePlanningTools(
      planningRequest(
        project,
        selected.model,
        selected.effort,
        selected.output,
        await voiceContext(conversationId),
        scope.planning,
      ),
      project,
    );
    if (providerOptions.attachments.length) {
      if (!loadAttachment)
        throw new Error(
          "Attachment reading is unavailable. Your files are saved.",
        );
      body = await appendPlanningAttachments(
        body,
        providerOptions,
        loadAttachment,
      );
    }
    let began = Date.now();
    let generated = await execute(body);
    await record("Reviewed project context", began);
    if (generated.name === "create_agent_conversation") {
      stage = "create_conversation";
      const requested = agentConversationSchema.parse(generated.value);
      const newId = crypto.randomUUID();
      const created = await command({
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "create_conversation",
        conversationId: newId,
        title: requested.title,
        agentIds: requested.agentIds,
        branch: null,
      });
      if (created.error)
        throw new Error("The new agent conversation could not be saved.");
      project = created.data as Project;
      body = appendToolResult(
        body,
        generated.name,
        generated.value,
        { conversationId: newId, title: requested.title },
        true,
        generated.output,
      );
      began = Date.now();
      stage = "planning";
      generated = await execute(body);
      await record(`Created ${requested.title}`, began);
    }
    while (
      [
        "search_project_sources",
        "read_project_source",
        "reference_project_source",
      ].includes(generated.name)
    ) {
      stage = "source_lookup";
      const sourceToolName = generated.name;
      const canSearchThenRead =
        sourceToolRounds === 0 && sourceToolName === "search_project_sources";
      const isSecondSourceRound = sourceToolRounds === 1;
      if (
        sourceToolRounds >= 2 ||
        (isSecondSourceRound &&
          !["read_project_source", "reference_project_source"].includes(
            sourceToolName,
          ))
      )
        throw new Error("The project source lookup limit was reached.");
      sourceToolRounds += 1;
      let sourceValue: ProjectSource | undefined;
      let sourceToolResult: unknown;
      if (sourceToolName === "search_project_sources") {
        sourceToolResult = searchProjectSources(project, generated.value);
      } else if (sourceToolName === "read_project_source") {
        sourceValue = sourceById(project, generated.value);
        sourceToolResult = {
          id: sourceValue.id,
          name: sourceValue.name,
          mime: sourceValue.mime,
          size: sourceValue.size,
          note: sourceValue.note,
          meaning: sourceValue.meaning,
          content: "The selected source is attached to this next request.",
        };
      } else {
        sourceToolResult = referencedSource(project, generated.value);
      }
      body = appendToolResult(
        body,
        sourceToolName,
        generated.value,
        sourceToolResult,
        false,
        generated.output,
      );
      if (sourceValue) {
        if (!loadAttachment)
          throw new Error(
            "Project source reading is unavailable. Your writing is saved.",
          );
        body = await appendPlanningAttachments(
          body,
          {
            ...defaultComposer(),
            attachments: [
              {
                id: sourceValue.attachmentId,
                name: sourceValue.name,
                mime: sourceValue.mime,
                size: sourceValue.size,
              },
            ],
          },
          loadAttachment,
        );
      }
      const afterSource = JSON.parse(body);
      if (canSearchThenRead) {
        afterSource.tools = afterSource.tools.filter((tool: { name: string }) =>
          [
            "develop_project",
            "consult_agents",
            "read_project_source",
            "reference_project_source",
          ].includes(tool.name),
        );
        afterSource.tool_choice = "auto";
      } else {
        afterSource.tools = afterSource.tools.filter((tool: { name: string }) =>
          ["develop_project", "consult_agents"].includes(tool.name),
        );
        afterSource.tool_choice = afterSource.tools.some(
          (tool: { name: string }) => tool.name === "consult_agents",
        )
          ? "auto"
          : { type: "function", name: "develop_project" };
      }
      body = JSON.stringify(afterSource);
      began = Date.now();
      stage = "planning";
      generated = await execute(body);
      await record(
        generated.name === "develop_project"
          ? "Reviewed a project source"
          : "Looked up a project source",
        began,
      );
    }
    // One history read and one specialist round are the entire delegation budget.
    // The final call is forced to the atomic project tool, preventing agent loops.
    if (generated.name === "read_conversation") {
      stage = "history_lookup";
      const history = readConversation(project, generated.value);
      const savedVoiceContext = await voiceContext(history.conversationId);
      body = appendToolResult(
        body,
        generated.name,
        generated.value,
        { ...history, ...(savedVoiceContext ? { savedVoiceContext } : {}) },
        false,
        generated.output,
      );
      const afterHistory = JSON.parse(body);
      afterHistory.tools = afterHistory.tools.filter((tool: { name: string }) =>
        ["develop_project", "consult_agents"].includes(tool.name),
      );
      body = JSON.stringify(afterHistory);
      began = Date.now();
      stage = "planning";
      generated = await execute(body);
      await record("Read conversation history", began);
    }
    if (generated.name === "consult_agents") {
      stage = "consultation";
      const tasks = consultationSchema.parse(generated.value).tasks;
      const eligible = consultationAgents(project);
      if (
        new Set(tasks.map((t) => t.agentId)).size !== tasks.length ||
        tasks.some((t) => !eligible.some((a) => a.id === t.agentId))
      )
        throw new Error("The requested specialist is unavailable.");
      const reports: AgentReport[] = [];
      for (const task of tasks) {
        stage = "specialist";
        began = Date.now();
        const result = await execute(
          adviceRequest(
            project,
            task.agentId,
            task.task,
            reports,
            scope.planning?.language,
          ),
        );
        if (result.name !== "report_advice")
          throw new Error("The specialist returned an unsupported response.");
        const advice = adviceSchema.parse(result.value).advice;
        const name = eligible.find((a) => a.id === task.agentId)!.name;
        reports.push({ ...task, name, advice, durationMs: Date.now() - began });
        await record(`Consulted ${name}`, began, advice);
      }
      body = appendToolResult(
        body,
        generated.name,
        generated.value,
        { reports },
        true,
        generated.output,
      );
      began = Date.now();
      stage = "planning";
      generated = await execute(body);
      await record("Brought the findings together", began);
    }
    if (generated.name !== "develop_project")
      throw new Error(
        "The conversation reached its work limit. Your writing is saved.",
      );
    stage = "plan_validation";
    const output = planningToolSchema.parse(generated.value);
    if (!group.length) generatedReply = output.reply;
    if (
      group.length &&
      output.concepts.some((concept) => concept.origin !== "author")
    )
      throw new Error(
        "The group update included an unrequested suggestion. Your writing is saved.",
      );
    enforceAgentScope(project, output);
    // Validate authored changes before asking participants to speak. A group
    // uses this call for context/tools and planning, never as its public speaker.
    if (group.length) {
      preparePlanningResult(project, turnId, output);
      // Bound mentions choose who gets the first opportunity; display names
      // and text that looks like a mention are not routing authority.
      const order = [...group].sort(
        (a, b) =>
          Number(options.agentIds.includes(b.id)) -
          Number(options.agentIds.includes(a.id)),
      );
      for (let index = 0; index < order.length; index++) {
        stage = "group_reply";
        const agent = order[index];
        began = Date.now();
        const result = await execute(
          groupParticipantRequest(
            body,
            agent,
            group,
            agentResponses,
            index === 2,
          ),
          agent,
        );
        if (result.name !== "respond_to_group")
          throw new Error("The agent returned an unsupported group response.");
        const accepted = acceptGroupResponse(
          result.value,
          agent,
          group,
          agentResponses,
        );
        agentResponses.push(accepted.response);
        generatedReply = agentTranscript(agentResponses);
        await record(
          accepted.response.text
            ? `${agent.name} replied`
            : `${agent.name} read the conversation`,
          began,
        );
        // Each participant reads once. A direct question from the second can
        // bring the first back once, within the same deadline and wallet.
        if (index === 1 && accepted.inviteAgentId === order[0].id)
          order.push(order[0]);
      }
      output.reply = agentTranscript(agentResponses);
    }
    generatedReply = output.reply;
    stage = "plan_validation";
    const prepared = preparePlanningResult(project, turnId, output);
    prepared.thinking.undo = retainPlanningUndo(
      planBeforeSend,
      prepared.items,
      prepared.thinking,
      project.revision + 1,
    );
    const completedTurn = prepared.thinking.turns.find((t) => t.id === turnId)!;
    if (agentResponses.length) completedTurn.agentResponses = agentResponses;
    const saveDetail = planningChangeSummary(
      thinkingOf(project),
      prepared.thinking,
      turnId,
    );
    const savedLabel = saveDetail ? "Updated the plan" : "Saved the reply";
    completedTurn.work = {
      startedAt: workStartedAt,
      activity: [
        ...activity,
        { label: savedLabel, ...(saveDetail ? { detail: saveDetail } : {}) },
      ].slice(-12),
      completedAt: workCompletedAt || new Date().toISOString(),
    };
    stage = "plan_save";
    const completed = await command({
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "complete",
      turnId,
      items: prepared.items,
      thinking: prepared.thinking,
      reply: prepared.reply,
      ...(prepared.sourceUpdates.length
        ? { sourceUpdates: prepared.sourceUpdates }
        : {}),
    });
    if (completed.error) {
      console.warn("planning_operation_failed", {
        turnId,
        stage,
        code:
          completed.error.code === "PT409"
            ? "plan_save_conflict"
            : "plan_save_rejected",
      });
      const notice =
        completed.error.code === "PT409"
          ? "The reply is saved, but the project changed while working. Its plan changes were not applied."
          : "The reply is saved, but its Plan update could not be saved. Reopen the conversation before trying again.";
      return reply({
        project: await fail(generatedReply, notice),
        enabled: true,
        notice,
      });
    }
    return reply({ project: completed.data, enabled: true });
  } catch (error) {
    const failure = planningFailure(error, stage);
    // Safe, correlated diagnostics even when no final reply was generated.
    // Never include raw tool arguments, provider errors or authored text.
    console.warn("planning_operation_failed", {
      turnId,
      stage,
      code: failure.code,
    });
    const notice = generatedReply
      ? error instanceof PlanningUpdateError
        ? `The reply is saved. Its proposed Plan update was not applied: ${failure.message}`
        : "The reply is saved, but its proposed Plan update could not be confirmed."
      : failure.message;
    return reply({
      project: await fail(generatedReply, notice),
      enabled: true,
      notice,
    });
  } finally {
    if (plan?.enabled) {
      try {
        await planAction(rpc, env.ACCOUNT_ACTION_SECRET!, owner, {
          action: "settle",
          id: creditActionId,
        });
      } catch {
        // The reservation is durable. Account/status reads reconcile a lost
        // acknowledgement without creating another generation or debit.
      }
    }
  }
}
