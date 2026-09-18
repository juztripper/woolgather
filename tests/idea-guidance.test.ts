import {
  fetchGuidance,
  providerRequest,
  responseUsage,
  reservationMicrousd,
  GuidanceFailure,
} from "../apps/api/src/openaiGuidance";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  emptyIdeaDocument,
  openIdeaWritingPrompt,
} from "../packages/domain/src/ideaDocument";
import {
  guidanceSource,
  guidanceSourceKey,
  validateGuidance,
  guidanceProviderSchema,
  guidanceFollowUp,
} from "../packages/domain/src/ideaGuidance";
import {
  guidanceEnabled,
  hashGuidance,
  signGuidance,
  signGuidanceSettlement,
} from "../apps/api/src/ideaGuidance";
import type { Idea } from "../packages/domain/src/library";
const body =
  "A quiet game for birdwatchers. Players photograph birds on a forest walk. No combat. Maybe shared journals later.";
const document = emptyIdeaDocument();
const result = {
  recognition: [
    {
      summary: "For birdwatchers",
      certainty: "clear",
      evidence: [
        { sourceId: "block:original-writing", quote: "for birdwatchers" },
      ],
    },
    {
      summary: "Shared journals remain tentative",
      certainty: "uncertain",
      evidence: [
        {
          sourceId: "block:original-writing",
          quote: "Maybe shared journals later.",
        },
      ],
    },
  ],
  question: {
    text: "What helps a player notice a bird on their first walk?",
    why: "This would clarify the first discovery.",
    evidence: [{ sourceId: "block:original-writing", quote: "a forest walk" }],
  },
};
const idea = { id: crypto.randomUUID(), revision: 1, body, document } as Idea;
test("guidance preserves uncertainty and rejects invented evidence and malformed proposals", () => {
  assert.deepEqual(validateGuidance(result, body, document), result);
  assert.throws(
    () =>
      validateGuidance(
        {
          ...result,
          recognition: [
            {
              ...result.recognition[0],
              evidence: [
                {
                  sourceId: "block:original-writing",
                  quote: "for combat fans",
                },
              ],
            },
          ],
        },
        body,
        document,
      ),
    /Unverified/,
  );
  assert.throws(
    () =>
      validateGuidance(
        {
          ...result,
          recognition: [result.recognition[0], result.recognition[0]],
        },
        body,
        document,
      ),
    /Repeated/,
  );
  assert.throws(() =>
    validateGuidance({ ...result, projectName: "Invented" }, body, document),
  );
  for (const disposition of ["kept", "dismissed", "answered"] as const)
    assert.equal(
      validateGuidance(result, body, document, [
        { question: result.question.text, disposition },
      ]).question,
      null,
    );
  assert.deepEqual(document.covered, []);
});
test("direct OpenAI adapter uses explicit stable-prefix caching and accounts for complete, refused and truncated responses", async () => {
  assert.equal(guidanceEnabled({}), false);
  assert.equal(
    guidanceEnabled({
      IDEA_GUIDANCE_ENABLED: "true",
      IDEA_GUIDANCE_MODEL: "unpriced-model",
      OPENAI_API_KEY: "test",
      ACCOUNT_ACTION_SECRET: "test",
    }),
    false,
  );
  const request = providerRequest(idea, "gpt-5.6-sol"),
    parsed = JSON.parse(request);
  assert.equal(parsed.store, false);
  assert.equal(parsed.service_tier, "default");
  assert.equal(parsed.reasoning.effort, "low");
  assert.equal(parsed.prompt_cache_options.mode, "explicit");
  assert.equal(
    parsed.input[0].content[0].prompt_cache_breakpoint.mode,
    "explicit",
  );
  assert.equal(parsed.input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(parsed.text.format.strict, true);
  assert.equal(parsed.messages, undefined);
  const usage = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 20 },
  };
  const response = {
    id: "resp_test",
    status: "completed",
    service_tier: "default",
    usage,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(result) }],
      },
    ],
  };
  let destination = "",
    attempts = 0;
  const fake = (value: unknown) =>
    (async (input: RequestInfo | URL) => {
      destination = String(input);
      attempts++;
      return Response.json(value);
    }) as typeof fetch;
  const completed = await fetchGuidance(
    request,
    "test-only",
    idea,
    fake(response),
  );
  assert.equal(destination, "https://api.openai.com/v1/responses");
  assert.deepEqual(completed.result, result);
  assert.equal(completed.usage.costMicrousd, 5580);
  assert.ok(reservationMicrousd(request) > completed.usage.costMicrousd);
  assert.equal(
    responseUsage(usage, "gpt-5.6-sol", {
      responseId: "test",
      requestId: null,
      tier: "flex",
      latencyMs: 1,
    }).costMicrousd,
    2790,
  );
  assert.throws(() =>
    responseUsage({ ...usage, input_tokens: 1 }, "gpt-5.6-sol", {
      responseId: "test",
      requestId: null,
      tier: "default",
      latencyMs: 1,
    }),
  );
  for (const failed of [
    { ...response, status: "incomplete" },
    {
      ...response,
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "No" }] },
      ],
    },
    {
      ...response,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "invalid json" }],
        },
      ],
    },
  ])
    await assert.rejects(
      fetchGuidance(request, "test-only", idea, fake(failed)),
      (e) => e instanceof GuidanceFailure && e.usage?.costMicrousd === 5580,
    );
  assert.equal(attempts, 4);
  await assert.rejects(
    fetchGuidance(
      request,
      "test-only",
      idea,
      (async () => new Response("x".repeat(129000))) as typeof fetch,
    ),
    (e) => e instanceof GuidanceFailure && e.code === "response_too_large",
  );
  assert.throws(
    () => providerRequest({ ...idea, body: "鳥".repeat(30000) }, "gpt-5.6-sol"),
    /too long/,
  );
  assert.throws(() => providerRequest(idea, "unpriced-model"), /supported/);
});
test("source projection separates question context, excludes saved questions, and ignores formatting", async () => {
  const {
    materializeIdea,
    withIdeaBlocks,
    buildIdeaBrief,
    pendingIdeaQuestions,
  } = await import("../packages/domain/src/ideaDocument");
  const { textBlock, blocksMarkdown } =
    await import("../packages/domain/src/ideaBlocks");
  const doc = withIdeaBlocks(materializeIdea("", document).document, [
    textBlock("title", "Not multiplayer.", "paragraph"),
    textBlock("answer", "No.", "reviewAnswer", {
      prompt: "Should the game include combat?",
    }),
    textBlock(
      "question",
      "Should it include paid loot boxes?",
      "openQuestion",
      { important: false },
    ),
    {
      id: "image",
      type: "image",
      props: {
        caption: "Blue fog",
        url: "https://example.test/pic.png",
        name: "pic",
      },
      children: [],
    },
  ]);
  doc.title = "Author title";
  const source = guidanceSource("duplicated stale body", doc);
  assert.deepEqual(
    source.passages.map((p) => p.text),
    ["Author title", "Not multiplayer.", "No.", "Blue fog"],
  );
  assert.equal(source.passages[2].question, "Should the game include combat?");
  assert.equal(source.passages[3].kind, "caption");
  assert.equal(
    new Set(source.passages.map((p) => p.id)).size,
    source.passages.length,
  );
  assert.throws(
    () =>
      validateGuidance(
        {
          recognition: [
            {
              summary: "Paid boxes",
              certainty: "clear",
              evidence: [
                { sourceId: "block:question", quote: "paid loot boxes" },
              ],
            },
          ],
          question: null,
        },
        "",
        doc,
      ),
    /Unverified/,
  );
  assert.throws(
    () =>
      validateGuidance(
        {
          recognition: [
            {
              summary: "Combat",
              certainty: "clear",
              evidence: [{ sourceId: "block:answer", quote: "include combat" }],
            },
          ],
          question: null,
        },
        "",
        doc,
      ),
    /Unverified/,
  );
  const formatted = structuredClone(doc);
  formatted.blocks[0].props.textColor = "red";
  assert.equal(guidanceSourceKey("", doc), guidanceSourceKey("", formatted));
  assert.match(blocksMarkdown(doc.blocks), /Should the game include combat/);
  assert.match(blocksMarkdown(doc.blocks), /No\./);
  assert.match(
    buildIdeaBrief("stale body", doc),
    /Should the game include combat/,
  );
  assert.match(buildIdeaBrief("stale body", doc), /No\./);
  assert.equal(pendingIdeaQuestions("", doc).length, 1);
  assert.doesNotMatch(
    buildIdeaBrief("", doc),
    /Who is this for|What should someone/,
  );
});

// Local PostgreSQL test: each admitted attempt retains accounting independently
// from its disposable idea cache and from the owner's authenticated session.
test("signed lifecycle survives duplicate delivery, unknown outcomes, deletions and late settlement", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    id = crypto.randomUUID();
  const secret = "local-test-secret-".repeat(4),
    capability = "test-run-capability";
  const as = (
    actor: string,
    fn: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: actor, aal: "aal1" })},true)`;
      return fn(tx);
    });
  const call = async (
    actor: string,
    value: object,
    signer = actor,
  ): Promise<any> => {
    const payload = JSON.stringify(value),
      signature = await signGuidance(secret, signer, payload);
    return as(
      actor,
      async (tx) =>
        (
          await tx`select public.idea_guidance_command(${payload},${signature}) d`
        )[0].d,
    );
  };
  const settle = async (value: object, signer = secret): Promise<any> => {
    const payload = JSON.stringify({ capability, ...value }),
      signature = await signGuidanceSettlement(signer, payload);
    return sql.begin(async (tx) => {
      await tx`set local role anon`;
      return (
        await tx`select public.settle_idea_guidance(${payload},${signature}) d`
      )[0].d;
    });
  };
  const costs = responseUsage(
    {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
      output_tokens: 100,
    },
    "gpt-5.6-sol",
    { responseId: "resp_test", requestId: null, tier: "default", latencyMs: 5 },
  );
  const period = `test:${owner}`;
  let request: any;
  const reserve = async (fingerprint: string, extra: object = {}) => {
    await sql`update account_private.guidance_allowances set last_requested_at=now()-interval '1 minute' where owner_id=${owner}`;
    request = {
      ...request,
      runId: crypto.randomUUID(),
      fingerprint: fingerprint.repeat(64),
      ...extra,
    };
    return call(owner, request);
  };
  try {
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner}),(${other},${other})`;
    await sql`insert into account_private.action_secrets values('account_deletion',${secret}) on conflict(purpose) do nothing`;
    await sql`insert into planning.ideas(id,owner_id,body) values(${id},${owner},${body})`;
    request = {
      action: "reserve",
      ideaId: id,
      revision: 1,
      fingerprint: "a".repeat(64),
      sourceKey: "a".repeat(64),
      runId: crypto.randomUUID(),
      model: "gpt-5.6-sol",
      reserveMicrousd: 100000,
      capabilityHash: await hashGuidance(capability),
      priceVersion: "2026-09-11",
      configVersion: "focused-review-v3",
      maxOutputTokens: 2000,
    };
    await assert.rejects(call(owner, request), /unavailable/);
    await sql`insert into account_private.guidance_allowances(owner_id,max_requests,budget_microusd) values(${owner},20,2000000),(${other},20,2000000)`;
    await sql`update account_private.guidance_review_periods set max_reviews=2 where owner_id=${owner}`;
    await sql`update account_private.guidance_wallet set enabled=true,budget_microusd=2000000 where id='openai'`;
    const baseline = (
      await sql`select spent_microusd from account_private.guidance_wallet where id='openai'`
    )[0];
    await assert.rejects(call(other, request, owner), /signature/);
    await assert.rejects(call(other, request), /unavailable/);
    await assert.rejects(call(owner, { ...request, revision: 2 }), /changed/);
    const responses = await Promise.all([
      call(owner, request),
      call(owner, { ...request, runId: crypto.randomUUID() }),
    ]);
    assert.equal(responses.filter((r) => r.reserved).length, 1);
    const runId = responses[0].runId,
      attemptId = crypto.randomUUID();
    assert.equal((await call(owner, request)).runId, runId);
    assert.equal(
      (await call(other, { action: "status", ideaId: id, runId })).status,
      "idle",
    );
    assert.equal(
      (
        await call(owner, {
          action: "status",
          ideaId: crypto.randomUUID(),
          runId,
        })
      ).status,
      "idle",
    );
    for (let n = 0; n < 2; n++)
      assert.equal(
        (await call(owner, { action: "claim", runId, attemptId })).claimed,
        true,
      );
    assert.equal(
      (
        await call(owner, {
          action: "claim",
          runId,
          attemptId: crypto.randomUUID(),
        })
      ).claimed,
      false,
    );
    assert.equal(
      (await reserve("b")).runId,
      runId,
      "changed request cannot duplicate in-flight work",
    );
    await assert.rejects(
      settle(
        { runId, attemptId, status: "completed", usage: costs, result },
        "wrong",
      ),
      /signature/,
    );
    await settle({ runId, attemptId, status: "unknown", errorCode: "timeout" });
    assert.equal((await reserve("c")).status, "unknown");
    const completion = {
      runId,
      attemptId,
      status: "completed",
      usage: costs,
      result,
    };
    await settle(completion);
    await settle(completion);
    await assert.rejects(settle({ ...completion, result: null }), /conflict/);
    assert.equal(
      (await call(owner, { action: "status", ideaId: id, runId })).status,
      "completed",
    );
    await call(owner, {
      action: "feedback",
      ideaId: id,
      runId,
      disposition: "dismissed",
    });
    const context = await call(owner, { action: "context", ideaId: id });
    assert.equal(context.allowance.remaining, 1);
    assert.equal(context.dispositions[0].disposition, "dismissed");
    assert.deepEqual(
      (await reserve("a")).result,
      result,
      "retained review is free",
    );
    const abandoned = await reserve("d");
    await sql`update account_private.guidance_journal set created_at=now()-interval '2 minutes' where id=${abandoned.runId}`;
    assert.equal(
      (
        await call(owner, {
          action: "status",
          ideaId: id,
          runId: abandoned.runId,
        })
      ).status,
      "cancelled",
    );
    assert.equal(
      (
        await call(owner, {
          action: "claim",
          runId: abandoned.runId,
          attemptId: crypto.randomUUID(),
        })
      ).claimed,
      false,
    );
    const failed = await reserve("e"),
      failedAttempt = crypto.randomUUID();
    await call(owner, {
      action: "claim",
      runId: failed.runId,
      attemptId: failedAttempt,
    });
    await settle({
      runId: failed.runId,
      attemptId: failedAttempt,
      status: "failed",
      usage: costs,
      result: null,
    });
    assert.equal(
      (await call(owner, { action: "context", ideaId: id })).allowance
        .remaining,
      1,
      "known invalid output costs business dollars but no customer review",
    );
    assert.equal(
      (await reserve("e")).status,
      "failed",
      "no implicit paid retry",
    );
    const last = await reserve("e", { retryRunId: failed.runId }),
      lastAttempt = crypto.randomUUID();
    await call(owner, {
      action: "claim",
      runId: last.runId,
      attemptId: lastAttempt,
    });
    await sql`update account_private.guidance_journal set started_at=now()-interval '2 minutes' where id=${last.runId}`;
    assert.equal(
      (await call(owner, { action: "status", ideaId: id, runId: last.runId }))
        .status,
      "unknown",
    );
    await assert.rejects(
      as(
        owner,
        async (tx) => tx`select * from account_private.guidance_journal`,
      ),
      /permission denied/,
    );
    await sql`delete from auth.users where id=${owner}`;
    await settle({
      runId: last.runId,
      attemptId: lastAttempt,
      status: "completed",
      usage: { ...costs, costMicrousd: 1 },
      result,
    });
    assert.equal(
      (
        await sql`select enabled from account_private.guidance_wallet where id='openai'`
      )[0].enabled,
      false,
      "cost mismatch settles the authoritative calculation and stops new spending",
    );
    assert.equal(
      (
        await sql`select accounting_anomaly from account_private.guidance_journal where id=${last.runId}`
      )[0].accounting_anomaly,
      "adapter_cost_mismatch",
    );
    const wallet = (
      await sql`select spent_microusd,reserved_microusd from account_private.guidance_wallet where id='openai'`
    )[0];
    assert.equal(
      Number(wallet.spent_microusd) - Number(baseline.spent_microusd),
      3 * costs.costMicrousd,
    );
    assert.equal(Number(wallet.reserved_microusd), 0);
    const retained = (
      await sql`select owner_id,period_id,status from account_private.guidance_journal where id=${last.runId}`
    )[0];
    assert.deepEqual(retained, {
      owner_id: null,
      period_id: null,
      status: "completed",
    });
    assert.equal(
      (
        await sql`select count(*) n from account_private.guidance_runs where id=${last.runId}`
      )[0].n,
      "0",
    );
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});

test("review findings retain exact source grounding without changing author intent", () => {
  const finding = {
    title: "The first discovery needs a cue",
    detail:
      "Without a cue, a first-time player may miss the bird before trying the journal.",
    nextStep: null,
    evidence: [
      {
        sourceId: "block:original-writing",
        quote: "Players photograph birds on a forest walk.",
      },
    ],
  };
  const upgraded = { ...result, finding, outcome: "clarify" as const };
  assert.deepEqual(validateGuidance(upgraded, body, document), upgraded);
  assert.doesNotThrow(() => guidanceProviderSchema.parse(upgraded));
  assert.throws(() => guidanceProviderSchema.parse(result));
  assert.deepEqual(
    validateGuidance(result, body, document),
    result,
    "older stored reviews remain readable",
  );
  assert.throws(
    () =>
      validateGuidance(
        {
          ...upgraded,
          finding: {
            ...finding,
            evidence: [
              {
                sourceId: "block:original-writing",
                quote: "The player wants navigation arrows.",
              },
            ],
          },
        },
        body,
        document,
      ),
    /Unverified source/,
  );
  assert.equal(
    document.answers.experience,
    "",
    "a suggestion never fills a manual answer",
  );
});

test("opening an empty prompt does not make a saved review stale", () => {
  const opened = openIdeaWritingPrompt(
    body,
    document,
    "audience",
    "empty-answer",
  );
  assert.equal(
    guidanceSourceKey(body, opened.document),
    guidanceSourceKey(body, document),
  );
});

test("continuation follows the saved answer while stale source quotes stay separate", async () => {
  const { continuationIdea, answeredQuestion, answerText } =
    await import("../scripts/guidanceContinuationEvaluation");
  const prior = {
    ...result,
    question: { ...result.question, text: answeredQuestion },
  };
  assert.deepEqual(
    guidanceFollowUp(prior, continuationIdea.body, continuationIdea.document!),
    { blockId: "taste-profile-answer", question: answeredQuestion },
  );
  assert.equal(guidanceFollowUp(prior, body, document), null);
  const source = guidanceSource(
    continuationIdea.body,
    continuationIdea.document!,
    [],
    "en",
    "taste-profile-answer",
  );
  assert.deepEqual(source.continuation, {
    sourceId: "block:taste-profile-answer",
    question: answeredQuestion,
  });
  assert.equal(
    source.passages.find(
      (passage) => passage.id === source.continuation?.sourceId,
    )?.text,
    answerText,
  );
  assert.throws(
    () =>
      guidanceSource(
        continuationIdea.body,
        continuationIdea.document!,
        [],
        "en",
        "cooking",
      ),
    /Save your answer/,
  );
  assert.throws(
    () =>
      guidanceSource(
        continuationIdea.body,
        continuationIdea.document!,
        [],
        "en",
        "missing",
      ),
    /Save your answer/,
  );
  const firstRequest = providerRequest(continuationIdea, "gpt-5.6-sol");
  const followRequest = providerRequest(continuationIdea, "gpt-5.6-sol", {
    continuationBlockId: "taste-profile-answer",
  });
  assert.notEqual(
    firstRequest,
    followRequest,
    "continuation context participates in request identity",
  );
});
