import test from "node:test";
import assert from "node:assert/strict";
import {
  planningTestDatabase,
  syntheticPlanningResponse,
} from "../scripts/planning-test-database";
import { signPlanning } from "../apps/api/src/projectPlanning";
import { planningWithAllowedScope as projectPlanning } from "../scripts/fixtures/planning-scope";
import { thinkingOf } from "../packages/domain/src/projectPlanning";
import { conversationsOf } from "../packages/domain/src/projectConversations";
import type { Project } from "../packages/domain/src";

test("unknown concept references preserve the reply and Plan, and explicit retry recovers once", async () => {
  const db = await planningTestDatabase(55440);
  const env = {
    PROJECT_PLANNING_ENABLED: "true",
    OPENAI_API_KEY: "synthetic-only",
    ACCOUNT_ACTION_SECRET: db.secret,
  };
  let calls = 0;
  let invalid = true;
  const provider: typeof fetch = async (_url, init) => {
    calls++;
    const response = (await syntheticPlanningResponse(
      init!.body as string,
    ).json()) as { output: Array<{ arguments: string }> };
    const result = JSON.parse(response.output[0].arguments);
    if (invalid) result.concepts[0].ref = "s1";
    response.output[0].arguments = JSON.stringify(result);
    return Response.json(response);
  };
  const run = async (input: object) => {
    const response = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      input,
      provider,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { project: Project; notice?: string };
  };
  try {
    let p = await db.createProject();
    const before = structuredClone(p.items);
    const turnId = crypto.randomUUID();
    const failed = await run({
      action: "send",
      id: crypto.randomUUID(),
      turnId,
      projectId: p.id,
      revision: p.revision,
      text: "Maybe a shared table later.",
    });
    p = failed.project;
    assert.match(failed.notice || "", /Unknown concept reference/);
    assert.deepEqual(p.items, before);
    const turn = thinkingOf(p).turns.at(-1)!;
    assert.equal(turn.status, "failed");
    assert.ok(turn.reply);
    const reopened = await run({
      action: "status",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
    });
    assert.equal(thinkingOf(reopened.project).turns.at(-1)!.reply, turn.reply);
    assert.equal(calls, 1, "reopening never retries a paid generation");
    invalid = false;
    const retry = {
      action: "retry",
      id: crypto.randomUUID(),
      turnId,
      projectId: p.id,
      revision: p.revision,
    };
    const recovered = await run(retry);
    assert.equal(recovered.notice, undefined);
    assert.equal(thinkingOf(recovered.project).turns.length, 1);
    assert.equal(thinkingOf(recovered.project).turns[0].status, "complete");
    assert.equal(recovered.project.items.length, before.length + 1);
    assert.deepEqual((await run(retry)).project, recovered.project);
    assert.equal(calls, 2, "retry acknowledgement cannot generate twice");
  } finally {
    await db.close();
  }
});

test("planning HTTP handler and real database reconcile sends, retries, cancellation and prepaid usage", async () => {
  const db = await planningTestDatabase(55440);
  const env = {
    PROJECT_PLANNING_ENABLED: "true",
    OPENAI_API_KEY: "synthetic-only",
    ACCOUNT_ACTION_SECRET: db.secret,
  };
  let calls = 0,
    invalidSource = false;
  const provider: typeof fetch = async (_url, init) => {
    calls++;
    return syntheticPlanningResponse(init!.body as string, invalidSource);
  };
  const run = async (input: object, send = provider, config = env) => {
    const settlementErrors: unknown[] = [];
    const r = await projectPlanning(
      db.rpc,
      async (name, args) => {
        const result = await db.settleRpc(name, args);
        if (result.error) settlementErrors.push(result.error);
        return result;
      },
      config,
      db.owner,
      input,
      send,
    );
    assert.deepEqual(settlementErrors, []);
    const data = (await r.json()) as {
      project: Project;
      notice?: string;
      enabled: boolean;
      error?: string;
    };
    assert.equal(
      r.status,
      200,
      data.error || "Expected a handled planning request",
    );
    return data;
  };
  const request = (p: Project, text: string, mode = "assist") => ({
    action: "send",
    id: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    projectId: p.id,
    revision: p.revision,
    text,
    mode,
  });
  const status = (p: Project) =>
    run({
      action: "status",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
    });
  try {
    let p = await db.createProject();
    const note = request(p, "Maybe a shared table later.", "note");
    p = (await run(note)).project;
    assert.equal(calls, 0);
    assert.equal(p.items[0].body, note.text);
    assert.deepEqual((await run(note)).project, p);
    const first = request(p, "Returns need inspection.");
    const firstResult = await run(first);
    assert.equal(firstResult.notice, undefined);
    p = firstResult.project;
    assert.equal(calls, 1);
    assert.equal(thinkingOf(p).turns.at(-1)!.status, "complete");
    assert.equal(p.items.length, 2);
    assert.deepEqual((await run(first)).project, p);
    assert.equal(calls, 1, "lost acknowledgement never repeats inference");
    assert.equal((await status(p)).project.revision, p.revision);
    assert.equal(calls, 1, "status never starts inference");
    let wallet = (
      await db.sql`select * from account_private.guidance_wallet where id='openai'`
    )[0];
    assert.equal(Number(wallet.spent_microusd), 8036);
    assert.equal(Number(wallet.reserved_microusd), 0);

    invalidSource = true;
    const failed = request(p, "No automatic messages.");
    const rejected = await run(failed);
    p = rejected.project;
    assert.match(rejected.notice || "", /authored source/);
    assert.equal(thinkingOf(p).turns.at(-1)!.status, "failed");
    assert.match(
      thinkingOf(p).turns.at(-1)!.reply,
      /kept that thought/,
      "a rejected map update does not erase a readable reply",
    );
    assert.equal(p.items.length, 2, "invalid source does not alter the plan");
    invalidSource = false;
    const count = thinkingOf(p).turns.length;
    const retry = {
      action: "retry",
      id: crypto.randomUUID(),
      turnId: failed.turnId,
      projectId: p.id,
      revision: p.revision,
    };
    p = (await run(retry)).project;
    assert.equal(
      thinkingOf(p).turns.length,
      count,
      "retry preserves one authored turn",
    );
    assert.equal(thinkingOf(p).turns.at(-1)!.status, "complete");
    await run(retry);
    assert.equal(calls, 3, "retry acknowledgement cannot duplicate a charge");

    const relation = {
      action: "connect",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
      from: p.items[0].id,
      to: p.items[1].id,
      kind: "requires",
      reason: "Check this first.",
    };
    p = (await run(relation)).project;
    assert.ok(thinkingOf(p).relations.some((r) => r.id === relation.id));
    p = (
      await run({
        action: "disconnect",
        id: crypto.randomUUID(),
        projectId: p.id,
        revision: p.revision,
        relationId: relation.id,
      })
    ).project;
    assert.ok(!thinkingOf(p).relations.some((r) => r.id === relation.id));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow: typeof fetch = async (url, init) => {
      reached();
      await gate;
      return provider(url, init);
    };
    const stoppedRequest = request(p, "An interrupted thought.");
    const ongoing = run(stoppedRequest, slow);
    await arrived;
    p = (await status(p)).project;
    assert.equal(thinkingOf(p).turns.at(-1)!.status, "pending");
    const before = p.items.length;
    p = (
      await run({
        action: "cancel",
        id: crypto.randomUUID(),
        projectId: p.id,
        revision: p.revision,
        turnId: stoppedRequest.turnId,
      })
    ).project;
    release();
    p = (await ongoing).project;
    assert.equal(p.items.length, before);
    assert.equal(
      thinkingOf(p).turns.at(-1)!.status,
      "cancelled",
      "late completion cannot override Stop",
    );
    wallet = (
      await db.sql`select * from account_private.guidance_wallet where id='openai'`
    )[0];
    assert.equal(
      Number(wallet.spent_microusd),
      32144,
      "completed provider work is billed even when discarded",
    );
    assert.equal(Number(wallet.reserved_microusd), 0);

    const unknown = request(p, "A connection with no confirmed reply.");
    p = (
      await run(unknown, async () => {
        calls++;
        throw new Error("lost transport");
      })
    ).project;
    const reserved = Number(
      (
        await db.sql`select reserved_microusd from account_private.guidance_wallet where id='openai'`
      )[0].reserved_microusd,
    );
    assert.ok(reserved > 0, "unknown work retains its reservation");
    const callCount = calls;
    const checked = await run({
      action: "retry",
      id: crypto.randomUUID(),
      projectId: p.id,
      revision: p.revision,
      turnId: unknown.turnId,
    });
    assert.match(checked.notice!, /previous reply/i);
    assert.equal(calls, callCount);
    const forged = await db.rpc("project_planning_budget", {
      payload: JSON.stringify({
        action: "status",
        projectId: p.id,
        turnId: unknown.turnId,
      }),
      signature: "0".repeat(64),
    });
    assert.equal(forged.error?.code, "42501");
    const settleForgery = await db.settleRpc("settle_project_planning", {
      payload: "{}",
      signature: "0".repeat(64),
    });
    assert.equal(settleForgery.error?.code, "42501");

    const orphan = await db.createProject();
    const orphanTurn = request(orphan, "Saved before a process stopped.");
    let fresh = (
      await db.rpc("project_planning_command", {
        command: { ...orphanTurn, action: "turn" },
      })
    ).data as Project;
    const thinking = thinkingOf(fresh);
    thinking.turns[0].createdAt = new Date(Date.now() - 240_000).toISOString();
    await db.sql`update planning.projects set thinking=${db.sql.json(thinking as never)} where id=${fresh.id}`;
    fresh = (await status(fresh)).project;
    assert.equal(thinkingOf(fresh).turns[0].status, "failed");
    assert.equal(calls, callCount);

    const disabled = await db.createProject();
    const saved = await run(
      request(disabled, "Keep this without discussion."),
      provider,
      { ...env, PROJECT_PLANNING_ENABLED: "false" },
    );
    assert.equal(saved.enabled, false);
    assert.equal(
      thinkingOf(saved.project).turns[0].text,
      "Keep this without discussion.",
    );
    assert.equal(calls, callCount);
    const payload = JSON.stringify({
      action: "status",
      projectId: p.id,
      turnId: unknown.turnId,
    });
    const signed = await db.rpc("project_planning_budget", {
      payload,
      signature: await signPlanning(db.secret, db.owner, payload),
    });
    assert.equal((signed.data as { status: string }).status, "unknown");
  } finally {
    await db.close();
  }
});

test("discussion-only responses save and reopen without Plan edits or another provider call", async () => {
  const db = await planningTestDatabase(55446);
  let calls = 0;
  try {
    const project = await db.createProject();
    const input = {
      action: "send",
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      text: "Would this platform suit the project?",
      mode: "assist",
    };
    const provider: typeof fetch = async (_url, init) => {
      calls++;
      const response = (await syntheticPlanningResponse(
        init!.body as string,
      ).json()) as { output: { arguments: string }[] };
      const value = JSON.parse(response.output[0].arguments);
      Object.assign(value, {
        reply: "It is an option worth discussing; no decision is needed yet.",
        concepts: [],
        relations: [],
        focus: "c999",
      });
      response.output[0].arguments = JSON.stringify(value);
      return Response.json(response);
    };
    const run = async (request: object) =>
      (
        await projectPlanning(
          db.rpc,
          db.settleRpc,
          {
            PROJECT_PLANNING_ENABLED: "true",
            OPENAI_API_KEY: "synthetic-only",
            ACCOUNT_ACTION_SECRET: db.secret,
          },
          db.owner,
          request,
          provider,
        )
      ).json() as Promise<{ project: Project; notice?: string }>;
    const saved = await run(input);
    assert.equal(saved.notice, undefined);
    assert.equal(thinkingOf(saved.project).turns.at(-1)!.status, "complete");
    assert.deepEqual(saved.project.items, project.items);
    assert.deepEqual(thinkingOf(saved.project).turns.at(-1)!.changedIds, []);
    const reopened = await run({
      action: "status",
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: saved.project.revision,
    });
    assert.deepEqual(reopened.project, saved.project);
    assert.equal(calls, 1);
  } finally {
    await db.close();
  }
});

test("manual Plan notes stay detached after Main deletion and replay safely", async () => {
  const db = await planningTestDatabase(55504);
  const env = {
    PROJECT_PLANNING_ENABLED: "true",
    OPENAI_API_KEY: "synthetic-only",
    ACCOUNT_ACTION_SECRET: db.secret,
  };
  let providerCalls = 0;
  const provider: typeof fetch = async () => {
    providerCalls++;
    throw new Error("Manual notes must not call a provider.");
  };
  try {
    let project = await db.createProject();
    const deleted = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "delete_conversation",
        conversationId: "main",
      },
      provider,
    );
    assert.equal(deleted.status, 200);
    project = ((await deleted.json()) as { project: Project }).project;
    assert.deepEqual(conversationsOf(project), []);

    const note = {
      action: "send",
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      projectId: project.id,
      conversationId: "main",
      revision: project.revision,
      mode: "note",
      text: "Keep the manual plan capture independent of chat history.",
    };
    const saved = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      note,
      provider,
    );
    assert.equal(saved.status, 200);
    project = ((await saved.json()) as { project: Project }).project;
    assert.deepEqual(conversationsOf(project), []);
    assert.equal(project.items.at(-1)?.body, note.text);
    assert.equal(providerCalls, 0);

    const assistedSend = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      {
        action: "send",
        id: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        projectId: project.id,
        conversationId: "main",
        revision: project.revision,
        mode: "assist",
        text: "This cannot be sent to a deleted chat.",
      },
      provider,
    );
    assert.equal(assistedSend.status, 422);
    assert.equal(providerCalls, 0);

    const replay = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      note,
      provider,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(
      ((await replay.json()) as { project: Project }).project,
      project,
      "replaying the same note does not duplicate the plan item or recreate Main",
    );

    const staleRetry = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      {
        action: "retry",
        id: crypto.randomUUID(),
        turnId: note.turnId,
        projectId: project.id,
        revision: project.revision,
        conversationId: "main",
      },
      provider,
    );
    assert.equal(staleRetry.status, 422);
    assert.deepEqual(
      conversationsOf(
        (await db.rpc("project_snapshot", { project_id: project.id }))
          .data as Project,
      ),
      [],
      "retrying a saved manual note cannot recreate Main or start inference",
    );
    assert.equal(providerCalls, 0);
  } finally {
    await db.close();
  }
});
