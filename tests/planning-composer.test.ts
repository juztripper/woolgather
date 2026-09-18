import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultComposer,
  resolveReasoning,
  composerSchema,
  attachmentReading,
} from "../packages/domain/src/planningComposer";
import {
  planningTestDatabase,
  syntheticPlanningResponse,
} from "../scripts/planning-test-database";
import { planningWithAllowedScope as projectPlanning } from "../scripts/fixtures/planning-scope";
import {
  appendPlanningAttachments,
  multimodalReservation,
} from "../apps/api/src/planningAttachments";
import { thinkingOf } from "../packages/domain/src/projectPlanning";
import type { Project } from "../packages/domain/src";

test("Auto routing uses the full range regardless of legacy ceilings and preserves explicit choices", () => {
  const base = defaultComposer();
  assert.equal(resolveReasoning(base, "Rename this"), "quick");
  assert.equal(
    resolveReasoning({ ...base, tool: "compare" }, "Compare"),
    "deep",
  );
  assert.equal(
    resolveReasoning(
      { ...base, tool: "compare", autoCeiling: "deep" },
      "Compare",
    ),
    "deep",
  );
  assert.equal(
    resolveReasoning(
      { ...base, tool: "challenge", autoCeiling: "quick" },
      "x".repeat(8000),
    ),
    "deep",
  );
  assert.equal(
    resolveReasoning(
      { ...base, reasoning: "deep", autoCeiling: "quick" },
      "Short",
    ),
    "deep",
  );
  assert.equal(
    composerSchema.safeParse({ ...base, reasoning: "unlimited" }).success,
    false,
  );
  assert.equal(
    attachmentReading("guide.pdf", "application/octet-stream"),
    "pdf",
  );
  assert.equal(
    attachmentReading("archive.zip", "application/octet-stream"),
    "reference",
  );
});

test("files are bounded, reference-only files are disclosed, and token-count failure prevents admission", async () => {
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [],
    tools: [],
    max_output_tokens: 6000,
  });
  const f = {
    id: crypto.randomUUID(),
    name: "notes.md",
    mime: "application/octet-stream",
    size: 5,
  };
  let read = 0;
  const result = JSON.parse(
    await appendPlanningAttachments(
      body,
      { ...defaultComposer(), attachments: [f] },
      async () => {
        read++;
        return new Response("hello");
      },
    ),
  );
  assert.equal(read, 1);
  assert.equal(result.input[0].content[1].text, "hello");
  const stored = JSON.parse(
    await appendPlanningAttachments(
      body,
      { ...defaultComposer(), attachments: [{ ...f, name: "archive.zip" }] },
      async () => {
        throw Error("must not read");
      },
    ),
  );
  assert.match(stored.input[0].content[0].text, /Stored reference only/);
  await assert.rejects(
    appendPlanningAttachments(
      body,
      { ...defaultComposer(), attachments: [f] },
      async () => new Response(new Uint8Array(100001)),
    ),
    /too long/,
  );
  await assert.rejects(
    multimodalReservation(body, "fake", undefined, async () =>
      Response.json({ input_tokens: 999999999 }),
    ),
    /discussion limit/,
  );
  const amount = await multimodalReservation(
    body,
    "fake",
    undefined,
    async () => Response.json({ input_tokens: 1000 }),
  );
  assert.equal(amount, 145480);
});

test("composer context survives send, retry and deletion while prepaid usage and file ownership remain enforced", async () => {
  const db = await planningTestDatabase(55448);
  const env = {
    PROJECT_PLANNING_ENABLED: "true",
    OPENAI_API_KEY: "synthetic",
    ACCOUNT_ACTION_SECRET: db.secret,
  };
  let calls = 0,
    last = "";
  const provider: typeof fetch = async (url, init) => {
    if (String(url).endsWith("input_tokens"))
      return Response.json({ input_tokens: 1000 });
    calls++;
    last = init!.body as string;
    return syntheticPlanningResponse(last);
  };
  const run = (input: object) =>
    projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      input,
      provider,
      async () => new Response("Use a shared table."),
    );
  try {
    let p = await db.createProject();
    const id = crypto.randomUUID();
    await db.sql`insert into account_private.attachments(id,owner_id,name,mime_type,byte_size,sha256,state) values(${id},${db.owner},'notes.md','application/octet-stream',19,${"a".repeat(64)},'ready')`;
    const options = {
      ...defaultComposer(),
      reasoning: "deep" as const,
      tool: "challenge" as const,
      attachments: [
        { id, name: "forged.md", mime: "application/octet-stream", size: 19 },
      ],
    };
    const request = {
      action: "send",
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
      text: "Returns need inspection.",
      mode: "assist",
      composer: options,
    };
    let response = await run(request);
    assert.equal(response.status, 200);
    p = ((await response.json()) as { project: Project }).project;
    const turn = thinkingOf(p).turns.at(-1)!;
    assert.equal(turn.status, "complete");
    assert.equal(turn.routing?.level, "deep");
    assert.equal(turn.composer?.attachments[0].name, "notes.md");
    assert.equal(JSON.parse(last).reasoning.effort, "medium");
    assert.match(last, /assumptions and failure cases/);
    assert.match(last, /Use a shared table/);
    // Canonical upload metadata must not make a lost-ack retry look like a different request.
    response = await run(request);
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    const forbidden = await run({
      ...request,
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      revision: p.revision,
      composer: {
        ...options,
        attachments: [{ ...options.attachments[0], id: crypto.randomUUID() }],
      },
    });
    assert.equal(forbidden.status, 422);
    assert.equal(calls, 1);
    const inventedQuote = await run({
      ...request,
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      revision: p.revision,
      composer: {
        ...defaultComposer(),
        quotes: [{ turnId: turn.id, text: "This text never appeared." }],
      },
    });
    assert.equal(inventedQuote.status, 422);
    assert.equal(calls, 1);
    const manual = await run({
      ...request,
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      revision: p.revision,
      mode: "note",
      text: "Keep this reference for later.",
      composer: { ...options, quotes: [{ turnId: turn.id, text: turn.text }] },
    });
    assert.equal(manual.status, 200);
    p = ((await manual.json()) as { project: Project }).project;
    assert.equal(thinkingOf(p).turns.at(-1)?.status, "saved");
    assert.equal(
      thinkingOf(p).turns.at(-1)?.composer?.quotes[0].text,
      turn.text,
    );
    assert.equal(calls, 1, "Manual capture must not call inference");
    const [retained] =
      await db.sql`select account_private.attachment_referenced(${id}) present`;
    assert.equal(retained.present, true);
    const trashed = await db.rpc("execute_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: p.id,
        expectedRevision: p.revision,
        action: { type: "set_project_lifecycle", lifecycle: "trashed" },
      },
    });
    p = trashed.data as Project;
    const deletion = await db.rpc("delete_trash", {
      command: {
        id: crypto.randomUUID(),
        projects: [{ id: p.id, revision: p.revision }],
        ideas: [],
      },
    });
    assert.equal(deletion.error, null);
    assert.equal(
      (
        await db.sql`select count(*)::int n from account_private.attachments where id=${id}`
      )[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
