import { test } from "node:test";
import assert from "node:assert/strict";
import type { Idea } from "../packages/domain/src/library";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ideaGuidance,
  hashGuidance,
  type GuidanceRpc,
} from "../apps/api/src/ideaGuidance";
import { emptyIdeaDocument } from "../packages/domain/src/ideaDocument";
import { guidanceSourceKey } from "../packages/domain/src/ideaGuidance";
const owner = crypto.randomUUID(),
  idea = {
    id: crypto.randomUUID(),
    body: "A quiet game. No combat.",
    document: emptyIdeaDocument(),
    revision: 1,
    updatedAt: new Date().toISOString(),
    projectId: null,
    trashed: false,
  };
const result = {
  finding: {
    title: "A quiet first interaction",
    detail:
      "A small interaction could establish the quiet tone before a larger world is needed.",
    nextStep:
      "Sketch one moment of noticing something without a reward or opponent.",
    evidence: [
      { sourceId: "block:original-writing", quote: "A quiet game. No combat." },
    ],
  },
  recognition: [
    {
      summary: "A quiet game without combat",
      certainty: "clear",
      evidence: [
        {
          sourceId: "block:original-writing",
          quote: "A quiet game. No combat.",
        },
      ],
    },
  ],
  question: null,
};
const env = {
  IDEA_GUIDANCE_ENABLED: "true",
  OPENAI_API_KEY: "test-only",
  ACCOUNT_ACTION_SECRET: "test-only",
};
const provider = {
  id: "test",
  model: "gpt-5.6-sol",
  service_tier: "default",
  status: "completed",
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 100,
  },
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(result) }],
    },
  ],
};
function harness(
  settings: {
    cached?: boolean;
    loseAdmission?: boolean;
    loseSettlement?: boolean;
    unknown?: boolean;
    invalidOutput?: boolean;
    snapshot?: Idea;
    statusResult?: unknown;
    statusSourceKey?: string;
    statusSourceSnapshot?: { body: string; document: unknown };
  } = {},
) {
  let reservations = 0,
    settlements = 0,
    providerCalls = 0;
  const commands: Record<string, any>[] = [];
  let runId = crypto.randomUUID();
  const rpc: GuidanceRpc = async (name, args) => {
    if (name === "idea_guidance_snapshot")
      return { data: settings.snapshot || idea, error: null };
    const command = JSON.parse(String(args.payload));
    commands.push(command);
    if (command.action === "context")
      return {
        data: {
          dispositions: [],
          allowance: { remaining: 4, reserved: 0, renewsAt: null },
        },
        error: null,
      };
    if (command.action === "status")
      return {
        data: {
          runId,
          status: "completed",
          sourceKey:
            settings.statusSourceKey ||
            (await hashGuidance(guidanceSourceKey(idea.body, idea.document))),
          result: settings.statusResult || result,
          sourceSnapshot: settings.statusSourceSnapshot,
        },
        error: null,
      };
    if (command.action === "reserve") {
      reservations++;
      runId = command.runId;
      if (settings.loseAdmission && reservations === 1)
        return { data: null, error: { code: "fetch_error" } };
      return {
        data: {
          runId,
          status: settings.cached ? "completed" : "reserved",
          reserved: !settings.cached,
          sourceKey: command.sourceKey,
          ...(settings.cached ? { result } : {}),
        },
        error: null,
      };
    }
    if (command.action === "claim")
      return { data: { claimed: true }, error: null };
    throw new Error("Unexpected authenticated RPC");
  };
  const settle: GuidanceRpc = async (_name, args) => {
    settlements++;
    commands.push(JSON.parse(String(args.payload)));
    return settings.loseSettlement && settlements === 1
      ? { data: null, error: { code: "fetch_error" } }
      : { data: { settled: true }, error: null };
  };
  const send = (async () => {
    providerCalls++;
    if (settings.unknown) throw new Error("timeout");
    return Response.json(
      settings.invalidOutput ? { ...provider, status: "incomplete" } : provider,
    );
  }) as typeof fetch;
  return {
    client: { rpc } as unknown as SupabaseClient,
    settle,
    send,
    commands,
    counts: () => ({ reservations, settlements, providerCalls }),
  };
}
test("status and exact-result reuse never call the provider", async () => {
  const h = harness({ cached: true });
  for (const action of ["status", "review"]) {
    const response = await ideaGuidance(
      h.client,
      env,
      owner,
      { action, ideaId: idea.id, revision: 1 },
      h,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as any).result, result);
  }
  assert.equal(h.counts().providerCalls, 0);
});
test("lost admission and settlement acknowledgements replay identical signed payloads once around a single inference", async () => {
  const h = harness({ loseAdmission: true, loseSettlement: true });
  const response = await ideaGuidance(
    h.client,
    env,
    owner,
    { ideaId: idea.id, revision: 1 },
    h,
  );
  assert.equal(((await response.json()) as any).status, "completed");
  assert.deepEqual(h.counts(), {
    reservations: 2,
    settlements: 2,
    providerCalls: 1,
  });
  const admissions = h.commands.filter((c) => c.action === "reserve"),
    finished = h.commands.filter((c) => c.status === "completed");
  assert.deepEqual(admissions[0], admissions[1]);
  assert.deepEqual(finished[0], finished[1]);
  assert(
    !h.commands.some((c) => c.action === "finish"),
    "settlement uses the session-independent callback",
  );
});
test("unknown and unusable provider outcomes do not launch a repair call", async () => {
  for (const [settings, status] of [
    [{ unknown: true }, "unknown"],
    [{ invalidOutput: true }, "failed"],
  ] as const) {
    const h = harness(settings);
    const response = await ideaGuidance(
      h.client,
      env,
      owner,
      { ideaId: idea.id, revision: 1 },
      h,
    );
    assert.equal(((await response.json()) as any).status, status);
    assert.equal(h.counts().providerCalls, 1);
    const finish = h.commands.at(-1)!;
    assert.equal(finish.status, status);
    assert.equal(!!finish.usage, status === "failed");
  }
});
test("stale revisions and exhausted preflight deadlines cannot admit paid work", async () => {
  for (const [revision, deadlineAt] of [
    [2, Date.now() + 45000],
    [1, Date.now() + 5000],
  ]) {
    const h = harness();
    const response = await ideaGuidance(
      h.client,
      env,
      owner,
      { ideaId: idea.id, revision },
      { ...h, deadlineAt },
    );
    assert.notEqual(response.status, 200);
    assert.equal(h.counts().providerCalls, 0);
    assert.equal(h.counts().reservations, 0);
  }
});

test("an invalid continuation cannot reserve money or contact a provider", async () => {
  const h = harness();
  const response = await ideaGuidance(
    h.client,
    env,
    owner,
    {
      action: "review",
      ideaId: idea.id,
      revision: 1,
      continuationBlockId: "not-an-answer",
    },
    h,
  );
  assert.equal(response.status, 422);
  assert.deepEqual(h.counts(), {
    reservations: 0,
    settlements: 0,
    providerCalls: 0,
  });
});

test("status preserves an answered review question across source changes without presenting stale evidence as current", async () => {
  const { continuationIdea, answeredQuestion } =
    await import("../scripts/guidanceContinuationEvaluation");
  const snapshot = { ...idea, ...continuationIdea } as Idea;
  const prior = {
    ...result,
    question: {
      text: answeredQuestion,
      why: "Clarifies first recommendations",
      evidence: [
        { sourceId: "block:cooking", quote: "find recipes that he may like" },
      ],
    },
  };
  const h = harness({
    snapshot,
    statusResult: prior,
    statusSourceKey: "older-source",
  });
  const response = await ideaGuidance(
    h.client,
    env,
    owner,
    { action: "status", ideaId: snapshot.id, revision: snapshot.revision },
    h,
  );
  assert.equal(response.status, 200);
  const data = (await response.json()) as any;
  assert.equal(data.current, false);
  assert.equal(
    data.result,
    null,
    "stale quotations are not validated against or presented as the changed document",
  );
  assert.deepEqual(data.followUp, {
    blockId: "taste-profile-answer",
    question: answeredQuestion,
  });
  assert.equal(h.counts().providerCalls, 0);
});

test("ready state survives saved wording changes and blocks a redundant paid review", async () => {
  const ready = {
    outcome: "ready",
    finding: null,
    recognition: [],
    question: null,
  };
  const changed = {
    ...idea,
    body: "A peaceful game without combat. An extra note.",
    revision: 2,
  };
  const h = harness({
    snapshot: changed as Idea,
    statusResult: ready,
    statusSourceKey: "prior-source",
    statusSourceSnapshot: { body: idea.body, document: idea.document },
  });
  for (const action of ["status", "review"]) {
    const response = await ideaGuidance(
      h.client,
      env,
      owner,
      { action, ideaId: idea.id, revision: 2 },
      h,
    );
    const data: any = await response.json();
    assert.equal(response.status, 200);
    assert.equal(
      data.current,
      false,
      "exact-source provenance remains distinct",
    );
    assert.equal(data.ready, true);
    assert.deepEqual(data.result, ready);
    assert.ok(data.readinessBasis.parts.length);
    assert.equal(
      data.sourceSnapshot,
      undefined,
      "do not retransmit the private source document",
    );
  }
  assert.deepEqual(h.counts(), {
    reservations: 0,
    settlements: 0,
    providerCalls: 0,
  });
});
