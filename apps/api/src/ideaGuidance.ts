import {
  providerRequest,
  fetchGuidance,
  reservationMicrousd,
  defaultGuidanceModel,
  isOpenAIModel,
  GuidanceFailure,
  guidancePriceVersion,
  guidanceConfigVersion,
} from "./openaiGuidance";
import { z } from "zod";
import {
  ideaReadinessBasis,
  preservesIdeaReadiness,
} from "../../../packages/domain/src/ideaReadiness";
import { stableJson } from "../../../packages/domain/src/stableJson";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  emptyIdeaDocument,
  ideaDocumentSchema,
} from "../../../packages/domain/src/ideaDocument";
import {
  guidanceSchema,
  guidancePromptRevision,
  guidanceSourceKey,
  guidanceFollowUp,
  validateGuidance,
} from "../../../packages/domain/src/ideaGuidance";

export type GuidanceEnv = {
  IDEA_GUIDANCE_ENABLED?: string;
  IDEA_GUIDANCE_MODEL?: string;
  IDEA_GUIDANCE_EFFORT?: string;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  ACCOUNT_ACTION_SECRET?: string;
};
export const guidanceEnabled = (env: GuidanceEnv) =>
  env.IDEA_GUIDANCE_ENABLED === "true" &&
  isOpenAIModel(env.IDEA_GUIDANCE_MODEL || defaultGuidanceModel) &&
  !!env.OPENAI_API_KEY &&
  !!env.ACCOUNT_ACTION_SECRET;
const requestSchema = z
  .object({
    action: z.enum(["review", "status", "feedback"]).default("review"),
    ideaId: z.uuid(),
    revision: z.number().int().nonnegative(),
    runId: z.uuid().optional(),
    retryRunId: z.uuid().optional(),
    continuationBlockId: z.string().min(1).max(120).optional(),
    disposition: z.enum(["dismissed", "kept", "answered"]).optional(),
  })
  .strict();
const ideaSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  revision: z.number().int(),
  document: ideaDocumentSchema.nullable().optional(),
  updatedAt: z.string(),
  projectId: z.string().nullable(),
  trashed: z.boolean(),
  archived: z.boolean().optional(),
});
const runSchema = z.object({
  sourceSnapshot: z
    .object({
      body: z.string(),
      document: ideaDocumentSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  runId: z.uuid().optional(),
  status: z.enum([
    "idle",
    "reserved",
    "running",
    "completed",
    "failed",
    "unknown",
    "cancelled",
  ]),
  revision: z.number().int().optional(),
  sourceKey: z.string().nullable().optional(),
  result: z.unknown().optional(),
  errorCode: z.string().nullable().optional(),
  reserved: z.boolean().optional(),
  createdAt: z.string().optional(),
});
const contextSchema = z.object({
  dispositions: z.array(
    z.object({
      question: z.string(),
      disposition: z.enum(["dismissed", "kept", "answered"]),
    }),
  ),
  allowance: z.object({
    remaining: z.number(),
    reserved: z.number(),
    renewsAt: z.string().nullable(),
  }),
});
export type GuidanceRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;
const reply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function hashGuidance(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function sign(secret: string, text: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export const signGuidance = (secret: string, owner: string, payload: string) =>
  sign(secret, `woolgather.guidance.v1:${owner}:${payload}`);
export const signGuidanceSettlement = (secret: string, payload: string) =>
  sign(secret, `woolgather.guidance.settle.v1:${payload}`);

export function guidanceRpcError(code?: string) {
  if (code === "PT409")
    return {
      status: 409,
      code: "stale_revision",
      error: "Your idea changed. Save the latest writing before reviewing it.",
    };
  if (code === "PT429")
    return {
      status: 429,
      code: "allowance_reached",
      error:
        "Your guidance allowance has been reached. Your writing and manual tools remain available.",
    };
  if (code === "PT425")
    return {
      status: 429,
      code: "review_busy",
      error: "Please wait a moment before starting another review.",
      retryAfter: 15,
    };
  if (code === "42501")
    return {
      status: 403,
      code: "access_required",
      error:
        "Guidance is unavailable for this account. Check your session; your writing is saved.",
    };
  if (code === "P0002")
    return {
      status: 404,
      code: "idea_unavailable",
      error: "This saved idea is unavailable.",
    };
  if (code === "22023")
    return {
      status: 422,
      code: "invalid_request",
      error: "This review could not be prepared. Your writing is saved.",
    };
  return {
    status: 503,
    code: "connection_interrupted",
    error:
      "The review could not be confirmed. Check its status before starting again.",
  };
}
// Only database delivery is retried. Its command ID/payload remains identical.
export async function repeatGuidanceRpc(
  rpc: GuidanceRpc,
  name: string,
  args: Record<string, unknown>,
  attempts = 2,
) {
  let result: Awaited<ReturnType<GuidanceRpc>> = {
    data: null,
    error: { code: "connection_interrupted" },
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      result = await rpc(name, args);
    } catch {
      result = { data: null, error: { code: "connection_interrupted" } };
    }
    if (!result.error || /^(PT|22|42|P0002)/.test(result.error.code || ""))
      break;
  }
  return result;
}
export async function ideaGuidance(
  client: SupabaseClient,
  env: GuidanceEnv,
  owner: string,
  input: unknown,
  options: {
    settle?: GuidanceRpc;
    deadlineAt?: number;
    send?: typeof fetch;
    language?: string;
    log?: (event: Record<string, unknown>) => void;
  } = {},
) {
  const started = Date.now(),
    deadline = options.deadlineAt ?? started + 45000;
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    return reply(
      { error: "Invalid idea snapshot.", code: "invalid_request" },
      422,
    );
  const request = parsed.data;
  if (!env.ACCOUNT_ACTION_SECRET)
    return reply(
      {
        error: "Guidance is unavailable. Continue writing manually.",
        code: "unavailable",
      },
      503,
    );
  const rpc: GuidanceRpc = async (name, args) => client.rpc(name, args);
  const command = async (value: unknown) => {
    const payload = JSON.stringify(value);
    return repeatGuidanceRpc(rpc, "idea_guidance_command", {
      payload,
      signature: await signGuidance(env.ACCOUNT_ACTION_SECRET!, owner, payload),
    });
  };
  const snapshot = await rpc("idea_guidance_snapshot", {
    idea_id: request.ideaId,
  });
  if (snapshot.error) {
    const e = guidanceRpcError(snapshot.error.code);
    return reply(e, e.status);
  }
  const saved = ideaSchema.safeParse(snapshot.data);
  if (
    !saved.success ||
    saved.data.trashed ||
    saved.data.archived ||
    saved.data.projectId
  )
    return reply({ error: "Idea unavailable.", code: "idea_unavailable" }, 404);
  const idea = saved.data,
    doc = idea.document || emptyIdeaDocument();
  const sourceKey = await hashGuidance(guidanceSourceKey(idea.body, doc));
  const context = await command({ action: "context", ideaId: idea.id });
  if (context.error) {
    const e = guidanceRpcError(context.error.code);
    return reply(e, e.status);
  }
  const { dispositions, allowance } = contextSchema.parse(context.data);
  const present = (value: unknown) => {
    const run = runSchema.parse(value);
    const current = run.sourceKey === sourceKey;
    const parsedResult = guidanceSchema.safeParse(run.result);
    const readinessBasis =
      run.status === "completed" &&
      parsedResult.success &&
      parsedResult.data.outcome === "ready"
        ? run.sourceSnapshot
          ? ideaReadinessBasis(
              run.sourceSnapshot.body,
              run.sourceSnapshot.document || emptyIdeaDocument(),
            )
          : current
            ? ideaReadinessBasis(idea.body, doc)
            : null
        : null;
    const ready =
      !!readinessBasis &&
      preservesIdeaReadiness(readinessBasis, idea.body, doc);
    const { sourceSnapshot: _source, ...publicRun } = run;
    return {
      ...publicRun,
      current,
      ready,
      readinessBasis,
      allowance,
      followUp: guidanceFollowUp(run.result, idea.body, doc),
      ...(run.result && (current || ready)
        ? { result: validateGuidance(run.result, idea.body, doc, dispositions) }
        : { result: null }),
    };
  };
  if (request.action === "feedback") {
    if (!request.runId || !request.disposition)
      return reply(
        { error: "Choose a question action.", code: "invalid_request" },
        422,
      );
    const stored = await command({
      action: "feedback",
      ideaId: idea.id,
      runId: request.runId,
      disposition: request.disposition,
    });
    if (stored.error) {
      const e = guidanceRpcError(stored.error.code);
      return reply(e, e.status);
    }
    return reply({ saved: true });
  }
  if (request.action === "status") {
    const status = await command({
      action: "status",
      ideaId: idea.id,
      sourceKey,
      ...(request.runId ? { runId: request.runId } : {}),
    });
    if (status.error) {
      const e = guidanceRpcError(status.error.code);
      return reply(e, e.status);
    }
    return reply(present(status.data));
  }
  if (!guidanceEnabled(env))
    return reply(
      {
        error:
          "Guidance is not enabled. Continue developing your idea manually.",
        code: "unavailable",
      },
      503,
    );
  if (idea.revision !== request.revision) {
    const e = guidanceRpcError("PT409");
    return reply(e, e.status);
  }
  // A stale UI or another tab cannot spend a review merely because wording changed.
  const latest = await command({
    action: "status",
    ideaId: idea.id,
    sourceKey,
  });
  if (latest.error) {
    const e = guidanceRpcError(latest.error.code);
    return reply(e, e.status);
  }
  const previous = present(latest.data);
  if (previous.ready) return reply(previous);
  let body: string;
  try {
    body = providerRequest(
      idea,
      env.IDEA_GUIDANCE_MODEL || defaultGuidanceModel,
      {
        cacheKey: `wg-focused-v3-${owner}`,
        dispositions,
        language: options.language,
        continuationBlockId: request.continuationBlockId,
        effort: env.IDEA_GUIDANCE_EFFORT === "none" ? "none" : "low",
      },
    );
  } catch (error) {
    return reply(
      { error: (error as Error).message, code: "review_scope" },
      422,
    );
  }
  if (deadline - Date.now() < 12000)
    return reply(
      {
        error:
          "The connection is taking too long. Your idea is saved; try the review again.",
        code: "connection_slow",
      },
      503,
    );
  const runId = crypto.randomUUID(),
    attemptId = crypto.randomUUID(),
    capability = crypto.randomUUID() + crypto.randomUUID();
  const reservation = await command({
    action: "reserve",
    ideaId: idea.id,
    revision: idea.revision,
    runId,
    fingerprint: await hashGuidance(
      body + "\n" + stableJson(ideaReadinessBasis(idea.body, doc)),
    ),
    sourceKey,
    reserveMicrousd: reservationMicrousd(body),
    model: JSON.parse(body).model,
    capabilityHash: await hashGuidance(capability),
    priceVersion: guidancePriceVersion,
    configVersion: guidanceConfigVersion,
    maxOutputTokens: JSON.parse(body).max_output_tokens,
    ...(request.retryRunId ? { retryRunId: request.retryRunId } : {}),
  });
  if (reservation.error) {
    const e = guidanceRpcError(reservation.error.code);
    return reply({ ...e, ...(e.status === 503 ? { runId } : {}) }, e.status);
  }
  const admitted = runSchema.parse(reservation.data);
  if (!admitted.reserved) return reply(present(admitted));
  const settle = async (value: Record<string, unknown>) => {
    const payload = JSON.stringify({ runId, attemptId, capability, ...value });
    return repeatGuidanceRpc(
      options.settle || rpc,
      "settle_idea_guidance",
      {
        payload,
        signature: await signGuidanceSettlement(
          env.ACCOUNT_ACTION_SECRET!,
          payload,
        ),
      },
      3,
    );
  };
  if (deadline - Date.now() < 10000) {
    await settle({ status: "cancelled", errorCode: "deadline_before_start" });
    return reply({
      status: "cancelled",
      runId,
      current: true,
      allowance,
      errorCode: "deadline_before_start",
    });
  }
  const claim = await command({ action: "claim", runId, attemptId });
  if (
    claim.error ||
    !z.object({ claimed: z.boolean() }).parse(claim.data).claimed
  )
    return reply(
      {
        status: "unknown",
        runId,
        current: true,
        allowance,
        errorCode: "claim_unconfirmed",
      },
      202,
    );
  const providerStarted = Date.now();
  const emit = (status: string, extra: Record<string, unknown> = {}) =>
    (options.log || (() => {}))({
      event: "idea_review",
      runId,
      status,
      config: guidanceConfigVersion,
      promptRevision: guidancePromptRevision,
      preflightMs: providerStarted - started,
      totalMs: Date.now() - started,
      ...extra,
    });
  try {
    const { result, usage } = await fetchGuidance(
      body,
      env.OPENAI_API_KEY!,
      idea,
      options.send || fetch,
      env.OPENAI_PROJECT_ID,
      {
        timeoutMs: Math.max(1, Math.min(30000, deadline - Date.now() - 8000)),
        dispositions,
      },
    );
    const stored = await settle({ status: "completed", result, usage });
    emit(stored.error ? "settlement_pending" : "completed", { usage });
    if (stored.error)
      return reply(
        {
          status: "unknown",
          runId,
          current: true,
          allowance,
          errorCode: "settlement_pending",
        },
        202,
      );
    return reply({
      status: "completed",
      runId,
      current: true,
      revision: idea.revision,
      result,
      ready: result.outcome === "ready",
      readinessBasis:
        result.outcome === "ready" ? ideaReadinessBasis(idea.body, doc) : null,
      allowance: {
        ...allowance,
        remaining: Math.max(0, allowance.remaining - 1),
      },
    });
  } catch (error) {
    const failure =
      error instanceof GuidanceFailure
        ? error
        : new GuidanceFailure("provider_interrupted");
    const stored = await settle({
      status: failure.usage ? "failed" : "unknown",
      result: null,
      ...(failure.usage ? { usage: failure.usage } : {}),
      errorCode: failure.code,
    });
    const status = failure.usage && !stored.error ? "failed" : "unknown";
    emit(status, {
      errorCode: failure.code,
      ...(failure.usage ? { usage: failure.usage } : {}),
    });
    return reply(
      { status, runId, current: true, allowance, errorCode: failure.code },
      status === "unknown" ? 202 : 200,
    );
  }
}
