import { requestEvidence } from "../apps/api/src/planningEvidence";
import { encodeEvent } from "../packages/domain/src/eventStream";
import type { PlanningLiveEvent } from "../packages/domain/src/planningStream";
import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../packages/domain/src";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import {
  emptyThinking,
  planningToolSchema,
  thinkingOf,
  type PlanningTurn,
} from "../packages/domain/src/projectPlanning";
import {
  adviceRequest,
  appendToolResult,
  consultationAgents,
  consultationSchema,
  enforceAgentScope,
  referencedSource,
} from "../apps/api/src/planningAgents";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import { visibleWorkActivity } from "../apps/web/src/projects/conversationWork";
import { planningWithAllowedScope as projectPlanning } from "../scripts/fixtures/planning-scope";
import { planningTestDatabase } from "../scripts/planning-test-database";

const enabled = (secret: string) => ({
  PROJECT_PLANNING_ENABLED: "true",
  OPENAI_API_KEY: "synthetic-only",
  ACCOUNT_ACTION_SECRET: secret,
});

const disabled = (secret: string) => ({
  PROJECT_PLANNING_ENABLED: "false",
  OPENAI_API_KEY: "synthetic-only",
  ACCOUNT_ACTION_SECRET: secret,
});

function assertStrictSchema(value: unknown, path: string) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertStrictSchema(child, `${path}[${index}]`),
    );
    return;
  }
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    assert.equal(
      schema.additionalProperties,
      false,
      `${path} must reject unknown fields`,
    );
    assert.deepEqual(
      [...((schema.required as string[]) || [])].sort(),
      Object.keys((schema.properties as object) || {}).sort(),
      `${path} must require every strict-tool field`,
    );
  }
  Object.entries(schema).forEach(([key, child]) =>
    assertStrictSchema(child, `${path}.${key}`),
  );
}

const responseFor = (
  body: string,
  name: string,
  value: unknown,
  showSummary = true,
) => {
  const request = JSON.parse(body) as {
    model: string;
    stream?: boolean;
    tools: Array<{ name: string; strict: boolean; parameters: unknown }>;
  };
  request.tools.forEach((tool) => {
    assert.equal(tool.strict, true);
    assertStrictSchema(tool.parameters, tool.name);
  });
  const parameters = request.tools.find((tool) => tool.name === name)!
    .parameters as { properties: Record<string, unknown> };
  if (name === "develop_project" || name === "respond_to_group") {
    const fields = Object.keys(parameters.properties);
    assert.equal(fields.at(-1), name === "develop_project" ? "reply" : "text");
    value = Object.fromEntries(
      fields.map((key) => [key, (value as Record<string, unknown>)[key]]),
    );
  }
  const result = {
    id: `resp_${crypto.randomUUID()}`,
    model: request.model,
    status: "completed",
    service_tier: "default",
    usage: {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        type: "function_call",
        name,
        arguments: JSON.stringify(value),
      },
    ],
  };
  if (request.stream) {
    const itemId = crypto.randomUUID();
    return new Response(
      new ReadableStream({
        start(controller) {
          if (showSummary)
            controller.enqueue(
              encodeEvent({
                type: "response.reasoning_summary_text.delta",
                delta: "A public reasoning summary.",
              }),
            );
          controller.enqueue(
            encodeEvent({
              type: "response.output_item.added",
              item: { id: itemId, type: "function_call", name },
            }),
          );
          for (const delta of JSON.stringify(value).match(/.{1,8}/gs) || [])
            controller.enqueue(
              encodeEvent({
                type: "response.function_call_arguments.delta",
                item_id: itemId,
                delta,
              }),
            );
          // A late summary terminator must not reopen work after reply text.
          controller.enqueue(
            encodeEvent({ type: "response.reasoning_summary_part.done" }),
          );
          controller.enqueue(
            encodeEvent({ type: "response.completed", response: result }),
          );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }
  return Response.json(result);
};

const finalResult = (reply = "The coordinator kept the shared context.") =>
  planningToolSchema.parse({
    reply,
    concepts: [],
    remove: [],
    relations: [],
    removeRelations: [],
    dismissProposals: [],
    sourceReferences: [],
    sourceUpdates: [],
    focus: null,
    view: "map",
  });

async function metadata(
  db: Awaited<ReturnType<typeof planningTestDatabase>>,
  project: Project,
  value: Record<string, unknown>,
  env = enabled(db.secret),
) {
  const result = await projectPlanning(db.rpc, db.settleRpc, env, db.owner, {
    id: crypto.randomUUID(),
    projectId: project.id,
    revision: project.revision,
    ...value,
  });
  const body = (await result.json()) as { project?: Project; error?: string };
  assert.equal(result.status, 200, body.error || "metadata command failed");
  return body.project!;
}

async function command(
  db: Awaited<ReturnType<typeof planningTestDatabase>>,
  project: Project,
  value: Record<string, unknown>,
) {
  const result = await db.rpc("project_planning_command", {
    command: {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      ...value,
    },
  });
  if (result.error) throw new Error(result.error.message);
  return result.data as Project;
}

test("work ends before answer deltas and routine replies leave no work disclosure", async () => {
  const db = await planningTestDatabase(55478);
  try {
    for (const showSummary of [false, true]) {
      const project = await db.createProject();
      const progress: PlanningLiveEvent[] = [];
      const result = await projectPlanning(
        db.rpc,
        db.settleRpc,
        enabled(db.secret),
        db.owner,
        {
          action: "send",
          id: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          projectId: project.id,
          revision: project.revision,
          conversationId: "main",
          text: "Hello there",
          mode: "assist",
          composer: { ...defaultComposer(), reasoning: "quick" },
        },
        async (_url, init) =>
          responseFor(
            init!.body as string,
            "develop_project",
            finalResult("Hello!"),
            showSummary,
          ),
        undefined,
        (event) => progress.push(event),
      );
      const body = (await result.json()) as {
        project: Project;
        notice?: string;
      };
      const turn = thinkingOf(body.project).turns.at(-1)!;
      assert.equal(
        turn.status,
        "complete",
        body.notice || "reply should complete",
      );
      const answerIndex = progress.findIndex(
        (event) => event.type === "phase" && event.phase === "answering",
      );
      assert.ok(answerIndex >= 0);
      assert.equal(progress[answerIndex + 1].type, "text");
      assert.ok(
        progress.slice(answerIndex + 1).every((event) => event.type === "text"),
        "no work or bookkeeping resumes during the final answer",
      );
      const phase = progress[answerIndex];
      assert.equal(
        turn.work?.completedAt,
        phase.type === "phase" ? phase.at : undefined,
      );
      assert.equal(
        progress.some((event) => event.type === "activity"),
        showSummary,
      );
      assert.equal(
        visibleWorkActivity(turn.work?.activity).length > 0,
        showSummary,
        "reopening preserves the same quiet/worked presentation",
      );
    }
  } finally {
    await db.close();
  }
});

test("metadata commands do not call the provider and archived chats reject new sends", async () => {
  const db = await planningTestDatabase(55466);
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    throw new Error("metadata must not invoke a provider");
  };
  try {
    let project = await db.createProject();
    const agentId = crypto.randomUUID();
    project = await metadata(db, project, {
      action: "upsert_agent",
      agentId,
      name: "World and environment",
      instructions: "Keep places and ecosystems coherent.",
      scopeIds: [],
    });
    const conversationId = crypto.randomUUID();
    project = await metadata(db, project, {
      action: "create_conversation",
      conversationId,
      title: "World branch",
      agentIds: [agentId],
      branch: null,
    });
    project = await metadata(db, project, {
      action: "archive_conversation",
      conversationId,
      archived: true,
    });
    const rejected = await projectPlanning(
      db.rpc,
      db.settleRpc,
      enabled(db.secret),
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        conversationId,
        text: "This must stay out of the archived branch.",
        mode: "assist",
      },
      provider,
    );
    const body = (await rejected.json()) as { error?: string };
    assert.equal(rejected.status, 422);
    assert.match(body.error || "", /conversation is unavailable/i);
    assert.equal(calls, 0);
  } finally {
    await db.close();
  }
});

test("main @agent mentions can read a saved source through the counted input path", async () => {
  const db = await planningTestDatabase(55469);
  const env = enabled(db.secret);
  const sourceText = "A saved ecology detail.";
  const providerEvents: Array<{ kind: string; hasSourceBytes: boolean }> = [];
  const loadedAttachmentIds: string[] = [];
  try {
    let project = await db.createProject("Main context source read.");
    const agentId = crypto.randomUUID();
    project = await command(db, project, {
      action: "upsert_agent",
      agentId,
      name: "World",
      instructions: "Check world and environment consequences.",
      scopeIds: [],
    });
    const attachmentId = crypto.randomUUID();
    await db.sql`
      insert into account_private.attachments
        (id,owner_id,name,mime_type,byte_size,sha256,state)
      values
        (${attachmentId},${db.owner},'ecology.txt','application/octet-stream',${sourceText.length},${"c".repeat(64)},'ready')
    `;
    const sourceId = crypto.randomUUID();
    const registered = await db.rpc("project_source_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "register_source",
        sourceId,
        attachmentId,
        note: "Saved ecology notes.",
        meaning: "undecided",
      },
    });
    assert.equal(registered.error, null, registered.error?.message ?? "");
    project = registered.data as Project;

    const provider: typeof fetch = async (url, init) => {
      const body = JSON.parse((init?.body as string) || "{}");
      const resultFor = (name: string, value: unknown) =>
        responseFor(JSON.stringify(body), name, value);
      const hasSourceBytes = body.input?.some(
        (entry: { content?: Array<{ text?: string }> }) =>
          Array.isArray(entry.content) &&
          entry.content.some((part) => part.text === sourceText),
      );
      if (String(url).endsWith("/input_tokens")) {
        providerEvents.push({ kind: "input_tokens", hasSourceBytes });
        return Response.json({ input_tokens: 42 });
      }
      providerEvents.push({
        kind: `response:${(body.tools || []).map((tool: { name: string }) => tool.name).join(",")}`,
        hasSourceBytes,
      });
      const request = body as { tools?: Array<{ name: string }> };
      if (request.tools?.some((tool) => tool.name === "read_project_source"))
        return resultFor("read_project_source", { sourceId });
      if (request.tools?.some((tool) => tool.name === "consult_agents"))
        return resultFor("consult_agents", {
          tasks: [{ agentId, task: "Check the saved source." }],
        });
      if (request.tools?.some((tool) => tool.name === "report_advice"))
        return resultFor("report_advice", {
          advice: "The saved source provides one bounded ecology detail.",
        });
      return resultFor("develop_project", {
        ...finalResult("I checked the saved source with the world specialist."),
        sourceReferences: [{ sourceId, quote: null }],
        sourceUpdates: [
          {
            sourceId,
            note: null,
            meaning: "use",
            sourceTurn: "t1",
            quote: "Use the saved ecology notes",
            origin: "author",
          },
        ],
      });
    };
    const loadAttachment = async (id: string) => {
      loadedAttachmentIds.push(id);
      return new Response(sourceText, { status: 200 });
    };
    const result = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        conversationId: "main",
        text: "Use the saved ecology notes and ask @World for a check.",
        mode: "assist",
        composer: {
          ...defaultComposer(),
          agentIds: [agentId],
        },
      },
      provider,
      loadAttachment,
    );
    const body = (await result.json()) as { project: Project; error?: string };
    assert.equal(result.status, 200, body.error || "coordinator failed");
    assert.deepEqual(loadedAttachmentIds, [attachmentId]);
    assert.equal(
      providerEvents.some(
        (event) => event.kind === "input_tokens" && event.hasSourceBytes,
      ),
      true,
      "the input token reservation sees the loaded source bytes",
    );
    assert.equal(
      providerEvents.some(
        (event) => event.kind.startsWith("response:") && event.hasSourceBytes,
      ),
      true,
      "the coordinator receives the loaded source before its response",
    );
    assert.equal(
      thinkingOf(body.project).turns.at(-1)?.sourceReferences?.[0]?.sourceId,
      sourceId,
    );
    assert.deepEqual(
      referencedSource(body.project, { sourceId, quote: null }),
      {
        sourceId,
        name: "ecology.txt",
      },
    );
    assert.equal(
      body.project.sources?.find((source) => source.id === sourceId)?.meaning,
      "use",
    );
    assert.equal(
      body.project.sources?.find((source) => source.id === sourceId)?.note,
      "Saved ecology notes.",
    );
    assert.equal(
      thinkingOf(body.project).turns.at(-1)?.sourceUpdates?.[0]?.note,
      undefined,
    );
    assert.equal(
      thinkingOf(body.project).turns.at(-1)?.composer?.agentIds?.[0],
      agentId,
      "the main conversation keeps the stable mentioned agent ID",
    );
  } finally {
    await db.close();
  }
});

test("source search can be followed by one bounded content read", async () => {
  const db = await planningTestDatabase(55470);
  const env = enabled(db.secret);
  const sourceText = "The target source contains a saved ecology detail.";
  const targetSourceId = crypto.randomUUID();
  const targetAttachmentId = crypto.randomUUID();
  const sourceActions: string[] = [];
  const loadedAttachmentIds: string[] = [];
  const providerEvents: Array<{
    kind: string;
    hasTargetBytes: boolean;
  }> = [];
  try {
    let project = await db.createProject("Search beyond the source index.");
    for (let index = 0; index < 25; index++) {
      const isTarget = index === 24;
      const attachmentId = isTarget ? targetAttachmentId : crypto.randomUUID();
      const sourceId = isTarget ? targetSourceId : crypto.randomUUID();
      const createdAt = isTarget
        ? new Date("2025-01-01T00:00:00.000Z")
        : new Date(`2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z`);
      await db.sql`
        insert into account_private.attachments
          (id,owner_id,name,mime_type,byte_size,sha256,state)
        values
          (${attachmentId},${db.owner},${isTarget ? "target-ecology.txt" : `filler-${index}.txt`},'application/octet-stream',${isTarget ? sourceText.length : 8},${String(index).padStart(2, "0") + "d".repeat(62)},'ready')
      `;
      await db.sql`
        insert into planning.project_sources
          (id,project_id,owner_id,attachment_id,name,mime_type,byte_size,note,meaning,created_at)
        values
          (${sourceId},${project.id},${db.owner},${attachmentId},${isTarget ? "target-ecology.txt" : `filler-${index}.txt`},'application/octet-stream',${isTarget ? sourceText.length : 8},${isTarget ? "Searchable target source." : "Filler source."},'undecided',${createdAt})
      `;
    }
    project = (await db.rpc("project_snapshot", { project_id: project.id }))
      .data as Project;
    assert.equal(project.sources?.length, 25);

    const provider: typeof fetch = async (url, init) => {
      const bodyText = (init?.body as string) || "{}";
      const body = JSON.parse(bodyText);
      const hasTargetBytes = body.input?.some(
        (entry: { content?: Array<{ text?: string }> }) =>
          Array.isArray(entry.content) &&
          entry.content.some((part) => part.text === sourceText),
      );
      if (String(url).endsWith("/input_tokens")) {
        providerEvents.push({ kind: "input_tokens", hasTargetBytes });
        return Response.json({ input_tokens: 42 });
      }
      const toolNames = (body.tools || []).map(
        (tool: { name: string }) => tool.name,
      );
      providerEvents.push({
        kind: `response:${toolNames.join(",")}`,
        hasTargetBytes,
      });
      if (!sourceActions.length) {
        assert.equal(
          JSON.stringify(body.input).includes(targetSourceId),
          false,
          "the target remains outside the bounded initial source index",
        );
        sourceActions.push("search_project_sources");
        return responseFor(bodyText, "search_project_sources", {
          query: "target-ecology",
        });
      }
      if (sourceActions.length === 1) {
        assert.equal(toolNames.includes("read_project_source"), true);
        assert.equal(
          JSON.stringify(body.input).includes(targetSourceId),
          true,
          "the selected search result is available to the next request",
        );
        sourceActions.push("read_project_source");
        return responseFor(bodyText, "read_project_source", {
          sourceId: targetSourceId,
        });
      }
      assert.equal(toolNames.includes("read_project_source"), false);
      return responseFor(bodyText, "develop_project", {
        ...finalResult("I read the source found by the project search."),
        sourceReferences: [{ sourceId: targetSourceId }],
      });
    };
    const loadAttachment = async (id: string) => {
      loadedAttachmentIds.push(id);
      return new Response(sourceText, { status: 200 });
    };
    const result = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        conversationId: "main",
        text: "Find the target ecology source and read it.",
        mode: "assist",
      },
      provider,
      loadAttachment,
    );
    const body = (await result.json()) as { project: Project; error?: string };
    assert.equal(result.status, 200, body.error || "coordinator failed");
    assert.deepEqual(sourceActions, [
      "search_project_sources",
      "read_project_source",
    ]);
    assert.deepEqual(loadedAttachmentIds, [targetAttachmentId]);
    assert.equal(
      providerEvents.some(
        (event) => event.kind === "input_tokens" && event.hasTargetBytes,
      ),
      true,
      "the counted input reservation sees bytes from the searched source",
    );
    assert.equal(
      providerEvents.some(
        (event) => event.kind.startsWith("response:") && event.hasTargetBytes,
      ),
      true,
      "the final coordinator request sees bytes from the searched source",
    );
    assert.equal(
      thinkingOf(body.project).turns.at(-1)?.sourceReferences?.[0]?.sourceId,
      targetSourceId,
    );
  } finally {
    await db.close();
  }
});

test("legacy retry keeps a branch conversation while disabled assistance fails safely", async () => {
  const db = await planningTestDatabase(55467);
  try {
    let project = await db.createProject();
    const noteResponse = await projectPlanning(
      db.rpc,
      db.settleRpc,
      disabled(db.secret),
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        text: "Start the world branch from this saved thought.",
        mode: "note",
      },
    );
    project = ((await noteResponse.json()) as { project: Project }).project;
    const sourceTurn = thinkingOf(project).turns[0].id;
    const conversationId = crypto.randomUUID();
    project = await metadata(
      db,
      project,
      {
        action: "create_conversation",
        conversationId,
        title: "World branch",
        agentIds: [],
        branch: {
          conversationId: "main",
          turnId: sourceTurn,
          message: "user",
          revision: project.revision,
        },
      },
      disabled(db.secret),
    );
    const branchNote = await projectPlanning(
      db.rpc,
      db.settleRpc,
      disabled(db.secret),
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        conversationId,
        text: "Keep this branch focused.",
        mode: "note",
      },
    );
    project = ((await branchNote.json()) as { project: Project }).project;
    const branchTurn = thinkingOf(project).turns.at(-1)!;
    assert.equal(branchTurn.conversationId, conversationId);
    const retried = await projectPlanning(
      db.rpc,
      db.settleRpc,
      disabled(db.secret),
      db.owner,
      {
        action: "retry",
        id: crypto.randomUUID(),
        turnId: branchTurn.id,
        projectId: project.id,
        revision: project.revision,
      },
    );
    const body = (await retried.json()) as { project: Project };
    assert.equal(retried.status, 200);
    assert.equal(
      thinkingOf(body.project).turns.find((turn) => turn.id === branchTurn.id)
        ?.conversationId,
      conversationId,
    );
    assert.equal(
      thinkingOf(body.project).turns.find((turn) => turn.id === branchTurn.id)
        ?.status,
      "failed",
    );
  } finally {
    await db.close();
  }
});

test("planning requests keep sourceTurn IDs stable across a branch cutoff", () => {
  const thinking = emptyThinking();
  const makeTurn = (
    id: string,
    text: string,
    status: PlanningTurn["status"] = "complete",
  ): PlanningTurn => ({
    id,
    text,
    reply: status === "pending" ? "" : `Reply to ${text}`,
    status,
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [],
  });
  const first = crypto.randomUUID();
  const cutoff = crypto.randomUUID();
  thinking.turns.push(makeTurn(first, "First author message."));
  thinking.turns.push(makeTurn(cutoff, "Branch from this author message."));
  const branchId = crypto.randomUUID();
  thinking.conversations.push({
    id: branchId,
    title: "World branch",
    agentIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    branch: {
      conversationId: "main",
      turnId: cutoff,
      message: "user",
      revision: 2,
    },
  });
  const branchTurn = crypto.randomUUID();
  thinking.turns.push({
    ...makeTurn(branchTurn, "Continue in the branch.", "pending"),
    conversationId: branchId,
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: "Branch source IDs",
    description: "",
    revision: 2,
    updatedAt: new Date().toISOString(),
    items: [],
    thinking,
  };
  const body = JSON.parse(
    planningRequest(project, "gpt-5.6-luna", "none", 1000),
  );
  const messages = body.input
    .filter((entry: { role: string }) => entry.role === "user")
    .map((entry: { content: string }) => entry.content)
    .filter((content: string) => content.startsWith("[sourceTurn:"));
  assert.deepEqual(
    messages.map((content: string) => content.match(/sourceTurn: (t\d+)/)?.[1]),
    ["t1", "t2", "t3"],
  );
  assert.match(
    requestEvidence(body).find((entry) => entry.sourceTurn === "t2")!.quote,
    /Branch from this author message/,
  );
  const assistantMessages = body.input.filter(
    (entry: { role: string; content?: string }) =>
      entry.role === "assistant" && entry.content,
  );
  assert.equal(
    assistantMessages.length,
    1,
    "the user cutoff hides only its ancestor reply",
  );
});

test("specialist selection and scope checks stay bounded and advisory", () => {
  const firstItem = crypto.randomUUID();
  const secondItem = crypto.randomUUID();
  const firstAgent = crypto.randomUUID();
  const secondAgent = crypto.randomUUID();
  const thinking = emptyThinking();
  thinking.agents.push(
    {
      id: firstAgent,
      name: "World",
      instructions: "Keep environments coherent.",
      scopeIds: [firstItem],
      archived: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: secondAgent,
      name: "Interface",
      instructions: "Keep interactions clear.",
      scopeIds: [secondItem],
      archived: false,
      createdAt: new Date().toISOString(),
    },
  );
  thinking.conversations.push({
    id: "group",
    title: "Specialists",
    agentIds: [firstAgent, secondAgent],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    branch: null,
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: "Specialist scopes",
    description: "",
    revision: 1,
    updatedAt: new Date().toISOString(),
    items: [
      {
        id: firstItem,
        title: "World",
        body: "World body",
        category: "feature",
        certainty: "stated",
        status: "open",
        answer: "",
        links: [],
        removed: false,
        source: "Written by you",
        promotedFrom: null,
      },
      {
        id: secondItem,
        title: "Interface",
        body: "Interface body",
        category: "feature",
        certainty: "stated",
        status: "open",
        answer: "",
        links: [],
        removed: false,
        source: "Written by you",
        promotedFrom: null,
      },
    ],
    thinking,
  };
  assert.equal(
    consultationSchema.safeParse({
      tasks: [
        { agentId: firstAgent, task: "World" },
        { agentId: secondAgent, task: "Interface" },
        { agentId: crypto.randomUUID(), task: "Extra" },
      ],
    }).success,
    false,
    "a consultation round has at most two tasks",
  );
  assert.deepEqual(
    consultationAgents(project).map((agent) => agent.id),
    [firstAgent, secondAgent],
  );
  const scoped = JSON.parse(
    adviceRequest(project, firstAgent, "Find risks.", []),
  );
  const scopedItems = JSON.parse(scoped.input[1].content).scope;
  assert.deepEqual(
    scopedItems.map((item: { id: string }) => item.id),
    [firstItem],
  );
  assert.throws(
    () =>
      enforceAgentScope(
        {
          ...project,
          thinking: {
            ...thinking,
            turns: [
              {
                id: crypto.randomUUID(),
                conversationId: "single",
                text: "A pending request",
                reply: "",
                status: "pending",
                focusId: null,
                createdAt: new Date().toISOString(),
                changedIds: [],
              },
            ],
            conversations: [
              {
                id: "main",
                title: "Main conversation",
                agentIds: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                archived: false,
                branch: null,
              },
              {
                id: "single",
                title: "World",
                agentIds: [firstAgent],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                archived: false,
                branch: null,
              },
            ],
          },
        },
        {
          ...finalResult(),
          concepts: [
            {
              ref: `new:${secondItem}`,
              title: "Out of scope",
              body: "Do not save this.",
              category: "feature",
              certainty: "stated",
              status: "open",
              answer: "",
              origin: "author",
              sourceTurn: "t1",
              quote: "A pending request",
              reason: "test",
            },
          ],
        },
      ),
    /outside its project branches/,
  );
});

test("a specialist group may edit its combined branches, not unrelated thoughts", () => {
  const thinking = emptyThinking();
  const now = new Date().toISOString();
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  thinking.agents = ids.slice(0, 2).map((id, index) => ({
    id: `agent${index}`,
    name: `Specialist ${index}`,
    instructions: "Work within this branch.",
    scopeIds: [id],
    archived: false,
    createdAt: now,
  }));
  thinking.conversations.push({
    id: "group",
    title: "Group",
    agentIds: ["agent0", "agent1"],
    archived: false,
    branch: null,
    createdAt: now,
    updatedAt: now,
  });
  thinking.turns.push({
    id: crypto.randomUUID(),
    conversationId: "group",
    text: "Refine this branch",
    reply: "",
    status: "pending",
    focusId: null,
    changedIds: [],
    createdAt: now,
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: "Scoped project",
    description: "",
    revision: 1,
    updatedAt: now,
    thinking,
    items: ids.map((id) => ({
      id,
      title: "Thought",
      body: "",
      category: "feature",
      certainty: "stated",
      status: "open",
      answer: "",
      links: [],
      removed: false,
      source: "Written by you",
      promotedFrom: null,
    })),
  };
  assert.doesNotThrow(() =>
    enforceAgentScope(project, {
      ...finalResult(),
      remove: [
        { ref: "c1", sourceTurn: "t1", quote: "Refine this branch" },
        { ref: "c2", sourceTurn: "t1", quote: "Refine this branch" },
      ],
    }),
  );
  assert.throws(
    () =>
      enforceAgentScope(project, {
        ...finalResult(),
        remove: [{ ref: "c3", sourceTurn: "t1", quote: "Refine this branch" }],
      }),
    /outside its project branches/,
  );
});

test("delegation settles each bounded run and stops after an unknown result", async () => {
  const db = await planningTestDatabase(55468);
  const env = enabled(db.secret);
  const budgetEvents: Array<{ action: string; runId?: string }> = [];
  const settlements: Array<{ status: string; runId?: string }> = [];
  try {
    let project = await db.createProject();
    const agentIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, agentId] of agentIds.entries())
      project = await command(db, project, {
        action: "upsert_agent",
        agentId,
        name: index === 0 ? "World" : "Interface",
        instructions: "Provide bounded advisory findings.",
        scopeIds: [],
      });
    project = await command(db, project, {
      action: "create_conversation",
      conversationId: "group",
      title: "Coordinator consulting specialists",
      agentIds: [],
      branch: null,
    });
    let calls = 0;
    let cancelProjectId: string | null = null;
    let cancellationDone = false;
    const provider: typeof fetch = async (_url, init) => {
      calls++;
      const body = init!.body as string;
      const request = JSON.parse(body) as { tools: Array<{ name: string }> };
      if (request.tools.some((tool) => tool.name === "consult_agents"))
        return responseFor(body, "consult_agents", {
          tasks: agentIds.map((agentId) => ({
            agentId,
            task: "Find one risk.",
          })),
        });
      if (request.tools.some((tool) => tool.name === "report_advice"))
        return responseFor(body, "report_advice", {
          advice: "The branch remains bounded and the finding is advisory.",
        });
      return responseFor(body, "develop_project", finalResult());
    };
    const rpc: typeof db.rpc = async (name, args) => {
      if (name === "project_planning_budget") {
        const payload = JSON.parse(args.payload as string) as {
          action: string;
          runId?: string;
        };
        budgetEvents.push(payload);
      }
      if (
        name === "project_planning_command" &&
        cancelProjectId &&
        !cancellationDone &&
        (args.command as { projectId?: string; action?: string }).projectId ===
          cancelProjectId &&
        (args.command as { action?: string }).action === "work" &&
        (
          args.command as { work?: { activity?: Array<{ label?: string }> } }
        ).work?.activity?.some((event) => event.label?.startsWith("Consulted "))
      ) {
        const command = args.command as { projectId: string; turnId: string };
        const latest = (
          await db.rpc("project_snapshot", { project_id: command.projectId })
        ).data as Project;
        const cancelled = await db.rpc("project_planning_command", {
          command: {
            id: crypto.randomUUID(),
            projectId: command.projectId,
            revision: latest.revision,
            action: "cancel",
            turnId: command.turnId,
          },
        });
        assert.equal(cancelled.error, null);
        cancellationDone = true;
      }
      return db.rpc(name, args);
    };
    const settle: typeof db.settleRpc = async (name, args) => {
      if (name === "settle_project_planning") {
        const payload = JSON.parse(args.payload as string) as {
          status: string;
          runId?: string;
        };
        settlements.push(payload);
      }
      return db.settleRpc(name, args);
    };
    const result = await projectPlanning(
      rpc,
      settle,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        conversationId: "group",
        text: "Review the shared project with the group.",
        mode: "assist",
      },
      provider,
    );
    const body = (await result.json()) as { project: Project };
    assert.equal(result.status, 200);
    assert.equal(calls, 4, "one coordinator, two helpers and one final call");
    assert.equal(
      budgetEvents.filter((event) => event.action === "reserve").length,
      5,
    );
    assert.equal(
      budgetEvents.filter((event) => event.action === "claim").length,
      5,
    );
    assert.equal(settlements.length, 5);
    assert.ok(settlements.every((event) => event.status === "completed"));
    assert.equal(new Set(settlements.map((event) => event.runId)).size, 5);
    assert.equal(thinkingOf(body.project).turns.at(-1)?.status, "complete");

    let cancelledProject = await db.createProject();
    for (const [index, agentId] of agentIds.entries())
      cancelledProject = await command(db, cancelledProject, {
        action: "upsert_agent",
        agentId,
        name: index === 0 ? "World" : "Interface",
        instructions: "Provide bounded advisory findings.",
        scopeIds: [],
      });
    cancelledProject = await command(db, cancelledProject, {
      action: "create_conversation",
      conversationId: "cancel-group",
      title: "Cancellable coordinator",
      agentIds: [],
      branch: null,
    });
    cancelProjectId = cancelledProject.id;
    const beforeCancellationCalls = calls;
    const beforeCancellationSettlements = settlements.length;
    const cancelledResult = await projectPlanning(
      rpc,
      settle,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: cancelledProject.id,
        revision: cancelledProject.revision,
        conversationId: "cancel-group",
        text: "Cancel after the first specialist round.",
        mode: "assist",
      },
      async (_url, init) => {
        calls++;
        const body = init!.body as string;
        const request = JSON.parse(body) as { tools: Array<{ name: string }> };
        if (request.tools.some((tool) => tool.name === "consult_agents"))
          return responseFor(body, "consult_agents", {
            tasks: agentIds.map((agentId) => ({
              agentId,
              task: "Find one risk.",
            })),
          });
        if (request.tools.some((tool) => tool.name === "report_advice"))
          return responseFor(body, "report_advice", {
            advice: "The branch remains bounded and the finding is advisory.",
          });
        return responseFor(body, "develop_project", finalResult());
      },
    );
    const cancelledBody = (await cancelledResult.json()) as {
      project: Project;
    };
    assert.equal(cancelledResult.status, 200);
    assert.equal(
      calls,
      beforeCancellationCalls + 2,
      "cancellation stops before the second specialist or final call",
    );
    assert.equal(cancellationDone, true);
    assert.equal(settlements.length, beforeCancellationSettlements + 3);
    assert.equal(
      thinkingOf(cancelledBody.project).turns.at(-1)?.status,
      "cancelled",
    );
    assert.deepEqual(
      cancelledBody.project.items,
      [],
      "cancellation leaves the shared plan untouched",
    );
    cancelProjectId = null;

    const unknownProject = await db.createProject();
    const before = calls;
    const unknownSettlementsStart = settlements.length;
    const interrupted = await projectPlanning(
      rpc,
      settle,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: unknownProject.id,
        revision: unknownProject.revision,
        text: "Interrupt this request.",
        mode: "assist",
      },
      async () => {
        calls++;
        throw new Error("lost transport");
      },
    );
    const interruptedBody = (await interrupted.json()) as { project: Project };
    assert.equal(interrupted.status, 200);
    assert.equal(
      calls,
      before + 1,
      "unknown work stops before helper or final calls",
    );
    assert.equal(settlements.length, unknownSettlementsStart + 2);
    assert.equal(settlements.at(-1)?.status, "unknown");
    assert.equal(
      thinkingOf(interruptedBody.project).turns.at(-1)?.status,
      "failed",
    );
    const wallet = (
      await db.sql`select reserved_microusd from account_private.guidance_wallet where id='openai'`
    )[0];
    assert.ok(
      Number(wallet.reserved_microusd) > 0,
      "unknown work keeps its reservation",
    );
  } finally {
    await db.close();
  }
});

test("final tool append removes delegation tools before the atomic commit", () => {
  const body = JSON.stringify({
    model: "gpt-5.6-luna",
    tools: [
      { type: "function", name: "develop_project" },
      { type: "function", name: "consult_agents" },
    ],
    input: [],
  });
  const result = JSON.parse(
    appendToolResult(
      body,
      "consult_agents",
      { tasks: [] },
      { reports: [] },
      true,
      [
        {
          type: "function_call",
          call_id: "call_consult",
          name: "consult_agents",
          arguments: '{"tasks":[]}',
        },
      ],
    ),
  );
  assert.deepEqual(
    result.tools.map((tool: { name: string }) => tool.name),
    ["develop_project"],
  );
  assert.deepEqual(result.tool_choice, {
    type: "function",
    name: "develop_project",
  });
  assert.equal(result.input[0].call_id, "call_consult");
  assert.equal(result.input[1].call_id, "call_consult");
});

test("group participants speak individually, listen, follow up and survive interruption", async (t) => {
  const db = await planningTestDatabase(55487);
  const { acceptGroupResponse } =
    await import("../apps/api/src/groupConversation");
  const { conversationTurns } =
    await import("../packages/domain/src/projectConversations");
  try {
    const makeGroup = async () => {
      let project = await db.createProject();
      for (const name of ["Cleo", "Fern"])
        project = await command(db, project, {
          action: "upsert_agent",
          agentId: name.toLowerCase(),
          name,
          avatar: name === "Cleo" ? "ripple" : "moss",
          instructions:
            name === "Cleo"
              ? "Keep the interface welcoming."
              : "Develop the world.",
          scopeIds: [],
        });
      return command(db, project, {
        action: "create_conversation",
        conversationId: "group",
        title: "Together",
        agentIds: ["cleo", "fern"],
        branch: null,
      });
    };
    const inputFor = (project: Project) => ({
      action: "send",
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      conversationId: "group",
      text: "How should someone enter the bakery?",
      mode: "assist",
      composer: defaultComposer(),
    });
    const message = (
      text: string | null,
      replyToAgentId: string | null = null,
      inviteAgentId: string | null = null,
    ) => ({ text, replyToAgentId, inviteAgentId });

    await t.test(
      "each counted speaker sees earlier replies; one requested follow-up and no coordinator message",
      async () => {
        const project = await makeGroup();
        const input = inputFor(project);
        let calls = 0;
        const progress: PlanningLiveEvent[] = [];
        const provider: typeof fetch = async (_url, init) => {
          const raw = init!.body as string;
          const body = JSON.parse(raw);
          calls++;
          assert.equal(
            body.tools.some(
              (tool: { name: string }) => tool.name === "consult_agents",
            ),
            false,
          );
          if (calls === 1)
            return responseFor(
              raw,
              "develop_project",
              finalResult("INTERNAL PLANNER REPLY"),
            );
          const context = JSON.parse(
            body.input.at(-1).content.split("\n").slice(1).join("\n"),
          );
          assert.equal(context.responses.length, calls - 2);
          assert.match(
            JSON.stringify(context.currentAgent),
            calls === 3 ? /"name":"Fern"/ : /"name":"Cleo"/,
          );
          return responseFor(
            raw,
            "respond_to_group",
            calls === 2
              ? message("Let the window invite them in.")
              : calls === 3
                ? message(
                    "Cleo, could the chair be the first interaction?",
                    "cleo",
                    "cleo",
                  )
                : message("Yes, reveal the choice beside the chair.", "fern"),
          );
        };
        const result = await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          provider,
          undefined,
          (event) => progress.push(event),
        );
        const body = (await result.json()) as {
          project: Project;
          notice?: string;
        };
        const turn = thinkingOf(body.project).turns.at(-1)!;
        assert.equal(
          turn.status,
          "complete",
          body.notice || "group should complete",
        );
        assert.equal(calls, 4);
        const savedActivity = progress.filter(
          (event) => event.type === "activity" && event.id === "save-result",
        );
        assert.deepEqual(
          savedActivity.map((event) =>
            event.type === "activity" ? event.label : "",
          ),
          [],
        );
        assert.equal(turn.work?.activity.at(-1)?.label, "Saved the reply");
        const streamed = progress.filter((event) => event.type === "text");
        assert.deepEqual(
          [...new Set(streamed.map((event) => event.speaker?.id))],
          ["cleo", "fern"],
        );
        assert.doesNotMatch(
          streamed.map((event) => event.text).join(""),
          /INTERNAL/,
        );
        assert.deepEqual(
          [0, 1, 2].map((index) =>
            streamed
              .filter((event) => event.index === index)
              .map((event) => event.text)
              .join(""),
          ),
          turn.agentResponses?.map((response) => response.text),
        );
        assert.ok(
          turn.work?.activity.some((entry) =>
            entry.detail?.includes("public reasoning summary"),
          ),
        );
        assert.deepEqual(
          turn.agentResponses?.map((r) => r.agentId),
          ["cleo", "fern", "cleo"],
        );
        assert.equal(turn.agentResponses?.[1].replyToAgentId, "cleo");
        assert.doesNotMatch(turn.reply, /INTERNAL/);
        const saved = (
          await db.rpc("project_snapshot", { project_id: project.id })
        ).data as Project;
        assert.deepEqual(
          thinkingOf(saved).turns.at(-1)?.agentResponses,
          turn.agentResponses,
        );
        const runs =
          await db.sql`select status from account_private.project_planning_runs where project_id=${project.id}`;
        assert.equal(runs.length, 5);
        assert.ok(runs.every((r) => r.status === "completed"));
        await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          provider,
        );
        assert.equal(calls, 4, "redelivery cannot regenerate group messages");
        const branched = await command(db, saved, {
          action: "create_conversation",
          conversationId: "branch",
          title: "Earlier",
          agentIds: [],
          branch: {
            conversationId: "group",
            turnId: turn.id,
            message: "user",
            revision: saved.revision,
          },
        });
        assert.equal(
          conversationTurns(branched, "branch")[0].agentResponses,
          undefined,
          "branching the user message must not leak later agent replies",
        );
        const agents = thinkingOf(saved).agents;
        assert.throws(
          () =>
            acceptGroupResponse(
              message("Hello", null, "outsider"),
              agents[0],
              agents,
              [],
            ),
          /outside/,
        );
        assert.throws(() =>
          acceptGroupResponse(message(null, "fern"), agents[0], agents, []),
        );
        const invalid = structuredClone(thinkingOf(saved));
        invalid.turns.at(-1)!.agentResponses![0].agentId = "outsider";
        const check =
          await db.sql`select planning.validate_thinking(${db.sql.json(invalid)}) valid`;
        assert.equal(
          check[0].valid,
          false,
          "database validates speaker identity too",
        );
      },
    );

    await t.test(
      "a direct mention gives its participant first opportunity; the other can listen",
      async () => {
        const project = await makeGroup();
        const input = inputFor(project);
        input.composer.agentIds = ["fern"];
        let calls = 0;
        const result = await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          async (_url, init) => {
            const raw = init!.body as string;
            calls++;
            if (calls === 1)
              return responseFor(raw, "develop_project", finalResult());
            assert.match(
              JSON.parse(raw).input.at(-1).content,
              calls === 2 ? /"name":"Fern"/ : /"name":"Cleo"/,
            );
            return responseFor(
              raw,
              "respond_to_group",
              message(calls === 2 ? "The baker opens the door." : null),
            );
          },
        );
        const body = (await result.json()) as {
          project: Project;
          notice?: string;
        };
        const turn = thinkingOf(body.project).turns.at(-1)!;
        assert.equal(
          turn.status,
          "complete",
          body.notice || "group should complete",
        );
        assert.deepEqual(
          turn.agentResponses?.map((r) => [r.agentId, r.text]),
          [
            ["fern", "The baker opens the door."],
            ["cleo", null],
          ],
        );
        assert.equal(calls, 3);
      },
    );

    await t.test(
      "all participants may read without manufacturing an answer",
      async () => {
        const project = await makeGroup();
        let calls = 0;
        const result = await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          inputFor(project),
          async (_url, init) => {
            const raw = init!.body as string;
            return ++calls === 1
              ? responseFor(raw, "develop_project", finalResult())
              : responseFor(raw, "respond_to_group", message(null));
          },
        );
        const body = (await result.json()) as {
          project: Project;
          notice?: string;
        };
        const turn = thinkingOf(body.project).turns.at(-1)!;
        assert.equal(
          turn.status,
          "complete",
          body.notice || "group should complete",
        );
        assert.equal(turn.reply, "Read by Cleo, Fern.");
        assert.ok(turn.agentResponses?.every((r) => r.text === null));
      },
    );

    await t.test(
      "an unknown second result keeps the first reply and blocks automatic re-inference",
      async () => {
        const project = await makeGroup();
        const input = inputFor(project);
        let calls = 0;
        const provider: typeof fetch = async (_url, init) => {
          const raw = init!.body as string;
          calls++;
          if (calls === 1)
            return responseFor(raw, "develop_project", finalResult());
          if (calls === 2)
            return responseFor(
              raw,
              "respond_to_group",
              message("A quiet first step."),
            );
          throw new Error("Lost second participant transport");
        };
        const result = await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          provider,
        );
        const body = (await result.json()) as {
          project: Project;
          notice?: string;
        };
        const turn = thinkingOf(body.project).turns.at(-1)!;
        assert.equal(
          turn.status,
          "failed",
          body.notice || "group should retain failure",
        );
        assert.equal(turn.agentResponses?.length, 1);
        assert.equal(turn.agentResponses?.[0].text, "A quiet first step.");
        assert.equal(turn.reply, "Cleo: A quiet first step.");
        assert.equal(body.project.items.length, 0);
        await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          provider,
        );
        assert.equal(calls, 3);
        const runs =
          await db.sql`select status from account_private.project_planning_runs where project_id=${project.id}`;
        assert.equal(runs.filter((r) => r.status === "unknown").length, 1);
      },
    );
  } finally {
    await db.close();
  }
});

test("specialist handoff failures retain a safe reason, preserve the Plan and recover only on deliberate retry", async () => {
  const db = await planningTestDatabase(55480);
  try {
    for (const scenario of [
      "unknown",
      "duplicate",
      "invalid_arguments",
      "invalid_advice",
      "success",
    ] as const) {
      let project = await db.createProject();
      const agentId = crypto.randomUUID();
      project = await metadata(db, project, {
        action: "upsert_agent",
        agentId,
        name: "Designer",
        instructions: "Help with interface clarity.",
        scopeIds: [],
      });
      const before = structuredClone(project.items);
      let calls = 0;
      const provider: typeof fetch = async (_url, init) => {
        const body = init!.body as string;
        calls++;
        if (calls === 1) {
          if (scenario === "invalid_arguments")
            return responseFor(body, "consult_agents", {
              tasks: [{ agentId, task: "" }],
            });
          const task = {
            agentId: scenario === "unknown" ? "designer" : agentId,
            task: "Suggest a clear journal completion signal.",
          };
          return responseFor(body, "consult_agents", {
            tasks: scenario === "duplicate" ? [task, task] : [task],
          });
        }
        if (calls === 2)
          return responseFor(body, "report_advice", {
            advice:
              scenario === "invalid_advice"
                ? ""
                : "Keep the journal's state readable.",
          });
        return responseFor(
          body,
          "develop_project",
          finalResult("The designer suggests a readable completion signal."),
        );
      };
      const turnId = crypto.randomUUID();
      const run = async (input: object, send = provider) => {
        const result = await projectPlanning(
          db.rpc,
          db.settleRpc,
          enabled(db.secret),
          db.owner,
          input,
          send,
        );
        assert.equal(result.status, 200);
        return (await result.json()) as { project: Project; notice?: string };
      };
      const result = await run({
        action: "send",
        id: crypto.randomUUID(),
        turnId,
        projectId: project.id,
        revision: project.revision,
        conversationId: "main",
        text: "Help me with the journal.",
        composer: defaultComposer(),
      });
      project = result.project;
      const turn = thinkingOf(project).turns.at(-1)!;
      assert.deepEqual(project.items, before);
      if (scenario === "success") {
        assert.equal(
          turn.status,
          "complete",
          result.notice || "handoff should complete",
        );
        assert.equal(calls, 3);
        assert.equal(
          turn.work?.activity.some((entry) => entry.label === "Reply stopped"),
          false,
        );
        continue;
      }
      assert.equal(turn.status, "failed");
      assert.equal(turn.reply, "");
      assert.equal(
        calls,
        scenario === "invalid_advice" ? 2 : 1,
        "no automatic repair or fallback generation",
      );
      assert.match(result.notice!, /specialist/i);
      assert.deepEqual(turn.work?.activity.at(-1), {
        label: "Reply stopped",
        detail: result.notice,
      });
      const reopened = await run({
        action: "status",
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
      });
      assert.deepEqual(
        thinkingOf(reopened.project).turns.at(-1)?.work,
        turn.work,
      );
      const priorCalls = calls;
      const retry = {
        action: "retry",
        id: crypto.randomUUID(),
        turnId,
        projectId: project.id,
        revision: project.revision,
      };
      const recovered = await run(retry, async (_url, init) => {
        calls++;
        const saved = await db.rpc("project_snapshot", {
          project_id: project.id,
        });
        assert.deepEqual(
          thinkingOf(saved.data as Project).turns.at(-1)?.work?.activity,
          [],
          "retry clears the earlier attempt's failure before calling the model",
        );
        return responseFor(
          init!.body as string,
          "develop_project",
          finalResult("A recovered reply."),
        );
      });
      assert.equal(recovered.notice, undefined);
      assert.equal(thinkingOf(recovered.project).turns.length, 1);
      assert.equal(thinkingOf(recovered.project).turns[0].status, "complete");
      assert.equal(
        thinkingOf(recovered.project).turns[0].work?.activity.some(
          (entry) => entry.label === "Reply stopped",
        ),
        false,
      );
      assert.deepEqual((await run(retry)).project, recovered.project);
      assert.equal(
        calls,
        priorCalls + 1,
        "acknowledgement replay must not pay twice",
      );
    }
  } finally {
    await db.close();
  }
});

test("a specialist transport interruption keeps its hold and durable paused-retry explanation", async () => {
  const db = await planningTestDatabase(55480);
  try {
    let project = await db.createProject();
    const agentId = crypto.randomUUID();
    project = await metadata(db, project, {
      action: "upsert_agent",
      agentId,
      name: "Designer",
      instructions: "Check clarity.",
      scopeIds: [],
    });
    const turnId = crypto.randomUUID();
    let calls = 0;
    const provider: typeof fetch = async (_url, init) => {
      calls++;
      if (calls === 1)
        return responseFor(init!.body as string, "consult_agents", {
          tasks: [{ agentId, task: "Check journal clarity." }],
        });
      throw new TypeError("private transport payload that must never be shown");
    };
    const run = async (input: object) => {
      const response = await projectPlanning(
        db.rpc,
        db.settleRpc,
        enabled(db.secret),
        db.owner,
        input,
        provider,
      );
      assert.equal(response.status, 200);
      return (await response.json()) as { project: Project; notice?: string };
    };
    const failed = await run({
      action: "send",
      id: crypto.randomUUID(),
      turnId,
      projectId: project.id,
      revision: project.revision,
      text: "Help me with the journal.",
      composer: defaultComposer(),
    });
    project = failed.project;
    assert.match(failed.notice!, /paused while its outcome is checked/);
    assert.equal(failed.notice!.includes("private transport"), false);
    assert.equal(
      thinkingOf(project).turns.at(-1)!.work?.activity.at(-1)?.detail,
      failed.notice,
    );
    const holds =
      await db.sql`select status,reserve_microusd,actual_microusd from account_private.project_planning_runs where turn_id=${turnId} and status='unknown'`;
    assert.equal(holds.length, 1);
    assert.ok(Number(holds[0].reserve_microusd) > 0);
    assert.equal(holds[0].actual_microusd, null);
    const reopened = await run({
      action: "status",
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
    });
    assert.equal(
      thinkingOf(reopened.project).turns.at(-1)!.work?.activity.at(-1)?.detail,
      failed.notice,
    );
    const retried = await run({
      action: "retry",
      id: crypto.randomUUID(),
      turnId,
      projectId: project.id,
      revision: project.revision,
    });
    assert.match(retried.notice!, /still being checked/);
    assert.equal(calls, 2, "unknown outcomes never start another paid call");
  } finally {
    await db.close();
  }
});
