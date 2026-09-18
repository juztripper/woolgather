import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../packages/domain/src";
import { emptyThinking } from "../packages/domain/src/projectPlanning";
import type { GuidanceRpc } from "../apps/api/src/ideaGuidance";
import {
  PROJECT_VOICE_MAX_CONTEXT_BYTES,
  PROJECT_VOICE_MAX_TRANSCRIPT_CHARACTERS,
  PROJECT_VOICE_MAX_TRANSCRIPT_FRAGMENTS,
  appendProjectVoiceTranscript,
  liveSessionBody,
  projectVoiceRequestSchema,
  projectVoice,
  projectVoiceTranscriptFragment,
  providerSession,
} from "../apps/api/src/projectVoice";

const owner = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function project(): Project {
  const value: Project = {
    id: projectId,
    name: "Voice fixture",
    description: "A bounded voice fixture.",
    revision: 4,
    updatedAt: new Date().toISOString(),
    lifecycle: "active",
    items: [],
    thinking: emptyThinking(),
  };
  value.thinking!.turns.push({
    conversationId: "main",
    id: "33333333-3333-4333-8333-333333333333",
    text: "Keep the capture gentle and reversible.",
    reply: "We can keep it small and recoverable.",
    status: "complete",
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [],
  });
  return value;
}

const env = {
  PROJECT_VOICE_ENABLED: "true",
  OPENAI_API_KEY: "server-only-key",
  OPENAI_PROJECT_ID: "proj_voice_fixture",
  ACCOUNT_ACTION_SECRET: "fixture-action-secret",
};

function okRpc(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  snapshot = project(),
): GuidanceRpc {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "project_snapshot") return { data: snapshot, error: null };
    if (name === "project_voice_start")
      return { data: { status: "reserved" }, error: null };
    if (name === "project_voice_prepare")
      return { data: { prepared: true }, error: null };
    if (name === "project_voice_claim")
      return {
        data: {
          claimed: true,
          status: "running",
          expiresAt: Date.now() + 60_000,
        },
        error: null,
      };
    if (name === "project_voice_status")
      return {
        data: {
          status: "running",
          durationSeconds: "3",
          transcript: [
            { speaker: "user", text: "hello", startMs: 0, endMs: 500 },
          ],
        },
        error: null,
      };
    return { data: { settled: true }, error: null };
  };
}

function startInput() {
  return {
    action: "start" as const,
    runId: "55555555-5555-4555-8555-555555555555",
    projectId,
    conversationId: "main",
    revision: 4,
    sdp: "v=0\r\no=- fixture offer\r\n",
  };
}

test("Live startup is server-configured, bounded and client-delegated", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const attached: unknown[] = [];
  const controller = {
    attach: async (value: unknown) => {
      attached.push(value);
    },
    stop: async () => {},
  };
  let providerCalls = 0;
  const send: typeof fetch = async (_input, init) => {
    providerCalls += 1;
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer server-only-key",
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.session.model, "gpt-live-1");
    assert.equal(body.session.store, false);
    assert.deepEqual(body.session.delegation, { type: "client" });
    assert.equal(body.transport.type, "webrtc");
    assert.equal(body.transport.sdp, startInput().sdp);
    return Response.json(
      {
        session: { id: "live_fixture" },
        transport: { type: "webrtc", sdp: "v=0\r\no=- fixture answer" },
      },
      { status: 201 },
    );
  };
  const response = await projectVoice(
    okRpc(calls),
    okRpc([]),
    env,
    owner,
    startInput(),
    controller,
    send,
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal((body.session as { id: string }).id, "live_fixture");
  assert.equal(providerCalls, 1);
  assert.equal(attached.length, 1);
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "project_voice_start",
      "project_snapshot",
      "project_voice_history",
      "project_voice_prepare",
      "project_voice_claim",
    ],
  );
  const prepare = JSON.parse(String(calls[3].args.payload)) as Record<
    string,
    unknown
  >;
  const claim = JSON.parse(String(calls[4].args.payload)) as Record<
    string,
    unknown
  >;
  const reserve = JSON.parse(String(calls[0].args.payload)) as Record<
    string,
    unknown
  >;
  assert.equal(reserve.runId, startInput().runId);
  assert.equal(prepare.action, "prepare");
  assert.equal(prepare.runId, startInput().runId);
  assert.equal(prepare.projectId, projectId);
  assert.equal(prepare.revision, 4);
  assert.equal(typeof prepare.attemptId, "string");
  assert.equal(typeof prepare.capability, "string");
  assert.match(String(calls[3].args.signature), /^[0-9a-f]{64}$/);
  assert.equal(claim.projectId, projectId);
  assert.equal(claim.revision, 4);
  assert.equal(JSON.stringify(body).includes("server-only-key"), false);
});

test("SDP validation preserves the browser offer including terminal CRLF", () => {
  const sdp = "v=0\r\no=- browser offer\r\n";
  const parsed = projectVoiceRequestSchema.safeParse({
    ...startInput(),
    sdp,
  });
  assert.equal(parsed.success, true);
  if (parsed.success && parsed.data.action === "start")
    assert.equal(parsed.data.sdp, sdp);
  assert.equal(
    projectVoiceRequestSchema.safeParse({ ...startInput(), sdp: " \r\n" })
      .success,
    false,
  );
});

test("provider rejection retains only bounded safe diagnostics", async () => {
  const send: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "invalid_request_error",
          param: "transport.sdp",
          message: "do not retain this provider message",
        },
      }),
      {
        status: 400,
        headers: { "x-request-id": "req_voice_fixture" },
      },
    );
  await assert.rejects(providerSession("{}", env, send), (error: unknown) => {
    const failure = error as Error & {
      providerStatus?: number;
      providerCode?: string;
      providerParam?: string;
      providerRequestId?: string;
    };
    assert.equal(failure.message, "live_http_400");
    assert.equal(failure.providerStatus, 400);
    assert.equal(failure.providerCode, "invalid_request_error");
    assert.equal(failure.providerParam, "transport.sdp");
    assert.equal(failure.providerRequestId, "req_voice_fixture");
    assert.equal(
      JSON.stringify(failure).includes("do not retain this provider message"),
      false,
    );
    return true;
  });
});

test("a durable controller owns provider creation when bound", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let durableStarts = 0;
  let directProviderCalls = 0;
  const response = await projectVoice(
    okRpc(calls),
    okRpc([]),
    env,
    owner,
    startInput(),
    {
      start: async (input) => {
        durableStarts += 1;
        assert.equal(input.runId, startInput().runId);
        assert.match(input.body, /gpt-live-1/);
        return { id: "durable_live_fixture", sdp: "v=0\\r\\no=- durable" };
      },
      attach: async () => {},
      stop: async () => {},
    },
    async () => {
      directProviderCalls += 1;
      throw new Error("direct provider path should not run");
    },
  );
  assert.equal(response.status, 201);
  assert.equal(durableStarts, 1);
  assert.equal(directProviderCalls, 0);
});

test("commercial voice limits the call to remaining time and paid expiry before provider creation", async () => {
  for (const scenario of [
    "free",
    "remaining",
    "expiring",
    "expired",
  ] as const) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let starts = 0;
    const baseRpc = okRpc(calls);
    const rpc: GuidanceRpc = async (name, args) =>
      name === "account_plan"
        ? {
            error: null,
            data: {
              enabled: true,
              tier: scenario === "free" ? "free" : "paid",
              credits: 1500,
              reservedCredits: 0,
              monthlyCredits: 1500,
              welcomeCredits: 0,
              renewsAt: null,
              paidUntil: new Date(
                Date.now() +
                  (scenario === "expired"
                    ? -1000
                    : scenario === "expiring"
                      ? 20_000
                      : 86_400_000),
              ).toISOString(),
              voiceSeconds: scenario === "free" ? 0 : 37,
              reservedVoiceSeconds: 0,
              storageBytes: 0,
              storageLimitBytes: 1024 ** 3,
            },
          }
        : baseRpc(name, args);
    const before = Date.now();
    const response = await projectVoice(
      rpc,
      okRpc([]),
      { ...env, PLAN_ALLOWANCES_ENABLED: "true" },
      owner,
      startInput(),
      {
        start: async (input) => {
          starts++;
          assert.ok(input.expiresAt <= Date.now() + 37_000);
          assert.ok(input.expiresAt > before);
          return { id: "live_fixture", sdp: "v=0\r\no=- fixture answer" };
        },
        attach: async () => {},
        stop: async () => {},
      },
      async () => {
        throw new Error("No direct provider call is allowed");
      },
    );
    if (scenario === "free" || scenario === "expired") {
      assert.equal(response.status, 429);
      assert.equal(starts, 0);
      assert.equal(calls.length, 0);
    } else {
      assert.equal(response.status, 201);
      assert.equal(starts, 1);
      const reservation = JSON.parse(String(calls[0].args.payload));
      const seconds = reservation.maxDurationSeconds;
      if (scenario === "remaining") assert.equal(seconds, 37);
      else assert.ok(seconds >= 16 && seconds <= 18);
      assert.equal(
        reservation.reserveMicrousd,
        Math.ceil(((seconds + 15) * 50000) / 60),
      );
      const reply = (await response.json()) as { maxDurationSeconds: number };
      assert.equal(reply.maxDurationSeconds, seconds);
    }
  }
});

test("prepare denial, replay and timeout never contact the provider", async () => {
  for (const mode of ["denied", "replayed", "timeout"] as const) {
    const calls: string[] = [];
    const settlements: string[] = [];
    let providerStarts = 0;
    const rpc: GuidanceRpc = async (name) => {
      calls.push(name);
      if (name === "project_voice_start")
        return { data: { status: "reserved", created: true }, error: null };
      if (name === "project_snapshot") return { data: project(), error: null };
      if (name === "project_voice_history")
        return { data: { sessions: [] }, error: null };
      if (name === "project_voice_prepare") {
        if (mode === "timeout") throw new Error("synthetic prepare timeout");
        return {
          data:
            mode === "replayed"
              ? { prepared: false, replayed: true }
              : { prepared: false },
          error: null,
        };
      }
      throw new Error(`unexpected ${name}`);
    };
    const accounting: GuidanceRpc = async (name) => {
      settlements.push(name);
      throw new Error("prepare failures must keep the reservation recoverable");
    };
    const response = await projectVoice(
      rpc,
      accounting,
      env,
      owner,
      startInput(),
      {
        start: async () => {
          providerStarts += 1;
          return { id: "must-not-start", sdp: "answer" };
        },
        attach: async () => {},
        stop: async () => {},
      },
    );
    assert.equal(response.status, mode === "timeout" ? 503 : 425);
    assert.equal(providerStarts, 0);
    assert.deepEqual(calls, [
      "project_voice_start",
      "project_snapshot",
      "project_voice_history",
      "project_voice_prepare",
    ]);
    assert.deepEqual(settlements, []);
  }
});

test("provider startup failures settle known and unknown outcomes separately", async () => {
  for (const [failure, expectedStatus, expectedSettlement] of [
    ["http", 502, "failed"],
    ["network", 503, "unknown"],
  ] as const) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const settlements: Record<string, unknown>[] = [];
    const accounting: GuidanceRpc = async (name, args) => {
      if (name === "settle_project_voice")
        settlements.push(
          JSON.parse(String(args.payload)) as Record<string, unknown>,
        );
      return { data: { settled: true }, error: null };
    };
    const send: typeof fetch = async () => {
      if (failure === "network") throw new Error("synthetic network drop");
      return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    };
    const response = await projectVoice(
      okRpc(calls),
      accounting,
      env,
      owner,
      startInput(),
      { attach: async () => {}, stop: async () => {} },
      send,
    );
    assert.equal(response.status, expectedStatus);
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].status, expectedSettlement);
    assert.equal(
      calls.some((call) => call.name === "project_voice_claim"),
      false,
    );
  }
});

test("a snapshot transport failure releases the reservation before provider contact", async () => {
  const settlements: Record<string, unknown>[] = [];
  const rpc: GuidanceRpc = async (name, args) => {
    if (name === "project_voice_start")
      return { data: { status: "reserved", created: true }, error: null };
    if (name === "project_snapshot") throw new Error("synthetic read outage");
    throw new Error(`unexpected ${name}`);
  };
  const accounting: GuidanceRpc = async (name, args) => {
    if (name === "settle_project_voice")
      settlements.push(
        JSON.parse(String(args.payload)) as Record<string, unknown>,
      );
    return { data: { settled: true }, error: null };
  };
  const response = await projectVoice(
    rpc,
    accounting,
    env,
    owner,
    startInput(),
    { attach: async () => {}, stop: async () => {} },
    async () => {
      throw new Error("provider must not be contacted");
    },
  );
  assert.equal(response.status, 503);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].status, "failed");
  assert.equal(settlements[0].providerClosed, true);
  assert.equal(settlements[0].durationSeconds, 0);
});

test("a replayed admission never retries an ambiguous provider start", async () => {
  let providerCalls = 0;
  const calls: string[] = [];
  const rpc: GuidanceRpc = async (name) => {
    calls.push(name);
    if (name === "project_voice_start")
      return { data: { status: "reserved", created: false }, error: null };
    throw new Error(`unexpected ${name}`);
  };
  const response = await projectVoice(
    rpc,
    rpc,
    env,
    owner,
    startInput(),
    { attach: async () => {}, stop: async () => {} },
    async () => {
      providerCalls += 1;
      return Response.json({});
    },
  );
  assert.equal(response.status, 425);
  assert.equal(providerCalls, 0);
  assert.deepEqual(calls, ["project_voice_start"]);
});

test("voice status returns numeric usage and bounded durable captions", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = await projectVoice(
    okRpc(calls),
    okRpc([]),
    { ACCOUNT_ACTION_SECRET: env.ACCOUNT_ACTION_SECRET },
    owner,
    {
      action: "status",
      runId: "44444444-4444-4444-8444-444444444444",
      projectId,
      revision: 4,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { durationSeconds?: number }).durationSeconds,
    3,
  );
  assert.equal(calls[0].name, "project_voice_status");

  const input = projectVoiceTranscriptFragment({
    type: "session.input_transcript.delta",
    delta: "Keep this reversible.",
    start_ms: 100,
    end_ms: 800,
  });
  assert.deepEqual(input, {
    speaker: "user",
    text: "Keep this reversible.",
    startMs: 100,
    endMs: 800,
  });
  let transcript = [] as NonNullable<typeof input>[];
  for (
    let index = 0;
    index < PROJECT_VOICE_MAX_TRANSCRIPT_FRAGMENTS + 20;
    index += 1
  ) {
    transcript = appendProjectVoiceTranscript(transcript, {
      speaker: "assistant",
      text: "x".repeat(500),
      startMs: index,
      endMs: index + 1,
    });
  }
  assert.ok(transcript.length <= PROJECT_VOICE_MAX_TRANSCRIPT_FRAGMENTS);
  assert.ok(
    transcript.reduce((sum, value) => sum + value.text.length, 0) <=
      PROJECT_VOICE_MAX_TRANSCRIPT_CHARACTERS,
  );
});

test("history action returns only bounded transcript projections", async () => {
  const calls: string[] = [];
  const rpc: GuidanceRpc = async (name) => {
    calls.push(name);
    if (name === "project_snapshot") return { data: project(), error: null };
    if (name === "project_voice_history")
      return {
        data: [
          {
            id: "voice-history-1",
            status: "completed",
            providerSessionId: "secret-provider-id",
            capability: "secret-capability",
            durationSeconds: "4",
            transcript: [
              { speaker: "user", text: "hello", startMs: 0, endMs: 200 },
              { speaker: "assistant", text: "world", startMs: 200, endMs: 400 },
            ],
          },
        ],
        error: null,
      };
    throw new Error(`unexpected ${name}`);
  };
  const response = await projectVoice(
    rpc,
    rpc,
    { ACCOUNT_ACTION_SECRET: env.ACCOUNT_ACTION_SECRET },
    owner,
    {
      action: "history",
      projectId,
      conversationId: "main",
      revision: 4,
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    history: Array<Record<string, unknown>>;
  };
  assert.equal(body.history[0].runId, "voice-history-1");
  assert.equal(body.history[0].durationSeconds, 4);
  assert.equal((body.history[0].transcript as unknown[]).length, 2);
  assert.equal(JSON.stringify(body).includes("secret-provider-id"), false);
  assert.equal(JSON.stringify(body).includes("secret-capability"), false);
  assert.deepEqual(calls, ["project_snapshot", "project_voice_history"]);
});

test("disabled voice never requests microphone or provider startup", async () => {
  let providerCalls = 0;
  const response = await projectVoice(
    okRpc([]),
    okRpc([]),
    { ...env, PROJECT_VOICE_ENABLED: "false" },
    owner,
    startInput(),
    { attach: async () => {}, stop: async () => {} },
    async () => {
      providerCalls += 1;
      return Response.json({});
    },
  );
  assert.equal(response.status, 503);
  assert.equal(providerCalls, 0);
});

test("history excludes attachment bytes and uses the current conversation", () => {
  const fixture = project();
  const itemId = "66666666-6666-4666-8666-666666666666";
  const agentId = "voice-focus-agent";
  fixture.items.push({
    id: itemId,
    title: "Gentle capture",
    body: "Keep the first version small and reversible.",
    category: "constraint",
    certainty: "confirmed",
    status: "open",
    answer: "",
    links: [],
    removed: false,
    source: "author",
    promotedFrom: null,
  });
  fixture.thinking!.focusId = itemId;
  fixture.thinking!.conversations[0].agentIds = [agentId];
  fixture.thinking!.agents.push({
    id: agentId,
    name: "Capture specialist",
    instructions: "Keep the capture flow gentle and reversible.",
    scopeIds: [itemId],
    archived: false,
    createdAt: new Date().toISOString(),
  });
  const body = liveSessionBody(fixture, "main", "offer", [
    {
      runId: "voice-history-1",
      status: "completed",
      transcript: [
        { speaker: "user", text: "spoken context", startMs: 0, endMs: 100 },
      ],
    },
  ]);
  assert.equal(body.transport.sdp, "offer");
  assert.equal(body.session.store, false);
  assert.equal(body.session.input.length, 4);
  assert.equal(
    (body.session.input[3].content[0] as { text: string }).text,
    "spoken context",
  );
  const contextText = body.session.input
    .map((entry) => (entry.content[0] as { text: string }).text)
    .join("\n");
  assert.match(contextText, /Voice fixture/);
  assert.match(contextText, /Gentle capture/);
  assert.match(contextText, /Capture specialist/);
  assert.ok(
    new TextEncoder().encode(contextText).length <=
      PROJECT_VOICE_MAX_CONTEXT_BYTES,
  );
  assert.equal(JSON.stringify(body).includes("attachment"), false);
});
