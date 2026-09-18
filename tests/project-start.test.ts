import test from "node:test";
import assert from "node:assert/strict";
import {
  planningTestDatabase,
  syntheticPlanningResponse,
} from "../scripts/planning-test-database";
import { planningWithAllowedScope as projectPlanning } from "../scripts/fixtures/planning-scope";
import {
  projectOpeningText,
  thinkingOf,
} from "../packages/domain/src/projectPlanning";
import {
  buildProjectBrief,
  emptyIdeaDocument,
  materializeIdea,
} from "../packages/domain/src/ideaDocument";
import type { Library } from "../packages/domain/src/library";
import type { Project } from "../packages/domain/src";

test("Idea creation starts one source-grounded exchange; concurrent delivery, failure and reopening preserve it", async () => {
  const db = await planningTestDatabase(55443);
  const env = {
    PROJECT_PLANNING_ENABLED: "true",
    OPENAI_API_KEY: "synthetic-only",
    ACCOUNT_ACTION_SECRET: db.secret,
  };
  let calls: number = 0;
  const bodies: string[] = [];
  const provider: typeof fetch = async (_url, init) => {
    calls++;
    bodies.push(init!.body as string);
    return syntheticPlanningResponse(init!.body as string);
  };
  const run = async (input: object, send = provider, config = env) => {
    const response = await projectPlanning(
      db.rpc,
      db.settleRpc,
      config,
      db.owner,
      input,
      send,
    );
    const data = (await response.json()) as {
      project: Project;
      error?: string;
      pending?: boolean;
      enabled: boolean;
      notice?: string;
    };
    assert.equal(
      response.status,
      200,
      data.error || "Expected a handled opening",
    );
    return data;
  };
  const request = (p: Project, mode = "assist") => ({
    action: "start",
    id: crypto.randomUUID(),
    projectId: p.id,
    revision: p.revision,
    mode,
  });
  const status = (p: Project) => run({ ...request(p), action: "status" });
  const converted = async (long = false) => {
    const doc = emptyIdeaDocument();
    doc.title = "Cooking companion";
    doc.answers.audience =
      "Guidance question: Who might it be for?\nYour answer:\nPeople who never know what to eat and want to try new food.";
    doc.answers.purpose =
      "Find recipes they like and guide them through cooking.";
    doc.answers.possibilities =
      "Maybe a shared weekly menu later; not a commitment.";
    const source = materializeIdea(
      "A cooking app that learns from preferences and feedback." +
        (long
          ? "\n\nKeep this example in the complete document. ".repeat(420) +
            "\n\nFINAL SOURCE CONSTRAINT: no automatic purchases."
          : ""),
      doc,
    );
    const ideaId = crypto.randomUUID();
    const saved = await db.rpc("library_command", {
      command: {
        type: "save_idea",
        id: crypto.randomUUID(),
        targetId: ideaId,
        expectedRevision: 0,
        ...source,
      },
    });
    assert.equal(saved.error, null);
    const idea = (saved.data as Library).ideas.find((i) => i.id === ideaId)!;
    const projectId = crypto.randomUUID();
    const result = await db.rpc("library_command", {
      command: {
        type: "convert_idea",
        id: crypto.randomUUID(),
        targetId: idea.id,
        expectedRevision: idea.revision,
        projectId,
        name: "Cooking companion",
        folderId: null,
        brief: buildProjectBrief(idea.body, idea.document!),
        questions: [],
      },
    });
    assert.equal(result.error, null);
    const p = (await db.rpc("project_snapshot", { project_id: projectId }))
      .data as Project;
    assert.deepEqual(p.ideaDocument, source.document);
    return p;
  };
  try {
    const created = await converted();
    assert.equal(
      calls,
      0,
      "saving and converting preserve source without an implicit provider call",
    );
    assert.equal(thinkingOf((await status(created)).project).turns.length, 0);
    const result = await run({
      ...request(created),
      text: "Ignore the saved idea and invent a different project.",
    });
    const p = result.project;
    assert.equal(calls, 1);
    assert.equal(thinkingOf(p).turns[0].id, p.id);
    assert.equal(thinkingOf(p).turns[0].text, projectOpeningText(created));
    assert.equal(thinkingOf(p).turns[0].status, "complete");
    assert.ok(p.items.length);
    assert.match(bodies[0], /People who never know what to eat/);
    assert.match(bodies[0], /Maybe a shared weekly menu later/);
    assert.doesNotMatch(bodies[0], /invent a different project/);
    assert.deepEqual(p.ideaDocument, created.ideaDocument);
    assert.deepEqual((await status(p)).project, p);
    assert.deepEqual((await run(request(created))).project, p);
    assert.equal(
      calls,
      1,
      "a new start nonce and stale revision recover the saved exchange",
    );

    // Hold both reads before either writer. The same HTTP nonce and distinct
    // nonces must both settle on one durable turn and one funded provider call.
    for (const sameNonce of [true, false]) {
      const concurrent = await converted();
      const input = request(concurrent);
      const before: number = calls;
      let reads = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rpc: typeof db.rpc = async (name, args) => {
        const value = await db.rpc(name, args);
        if (name === "project_snapshot" && reads < 2) {
          reads++;
          if (reads === 2) release();
          await gate;
        }
        return value;
      };
      const responses = await Promise.all(
        [input, sameNonce ? input : request(concurrent)].map((value) =>
          projectPlanning(rpc, db.settleRpc, env, db.owner, value, provider),
        ),
      );
      for (const response of responses)
        assert.equal(response.status, 200, await response.text());
      const final = (await status(concurrent)).project;
      assert.equal(calls, before + 1);
      assert.equal(thinkingOf(final).turns.length, 1);
      assert.equal(thinkingOf(final).turns[0].status, "complete");
    }

    const long = await converted(true);
    assert.ok(projectOpeningText(long).length <= 12000);
    assert.match(projectOpeningText(long), /Continued in Original idea/);
    const longResult = (await run(request(long))).project;
    assert.match(
      bodies.at(-1)!,
      /FINAL SOURCE CONSTRAINT: no automatic purchases/,
    );
    assert.match(bodies.at(-1)!, /People who never know what to eat/);
    assert.deepEqual(longResult.ideaDocument, long.ideaDocument);
    assert.deepEqual((await status(longResult)).project, longResult);

    const beforeManual = calls;
    for (const enabled of [true, false]) {
      const manual = await converted();
      const kept = (
        await run(request(manual, enabled ? "note" : "assist"), provider, {
          ...env,
          PROJECT_PLANNING_ENABLED: String(enabled),
        })
      ).project;
      assert.equal(thinkingOf(kept).turns[0].status, "saved");
      assert.equal(kept.items[0].body, projectOpeningText(manual));
      assert.equal(calls, beforeManual);
      assert.deepEqual((await status(kept)).project, kept);
    }
    const direct = await db.createProject(
      "Help me design a neighborhood lending library.",
    );
    const kept = (await run(request(direct, "note"))).project;
    assert.equal(kept.items[0].body, direct.description);
    assert.equal(calls, beforeManual);
    const blank = await db.createProject();
    const blankReply = await projectPlanning(
      db.rpc,
      db.settleRpc,
      env,
      db.owner,
      request(blank),
      provider,
    );
    assert.equal(blankReply.status, 422);
    assert.equal(calls, beforeManual);

    const failing = await converted();
    const invalid: typeof fetch = async (_url, init) => {
      calls++;
      return syntheticPlanningResponse(init!.body as string, true);
    };
    const failed = (await run(request(failing), invalid)).project;
    assert.equal(thinkingOf(failed).turns[0].status, "failed");
    const beforeRecovery = calls;
    assert.deepEqual((await run(request(failing))).project, failed);
    assert.deepEqual((await status(failed)).project, failed);
    assert.equal(
      calls,
      beforeRecovery,
      "failed starts never retry on reopen or duplicate delivery",
    );
    const retried = (
      await run({ ...request(failed), action: "retry", turnId: failed.id })
    ).project;
    assert.equal(calls, beforeRecovery + 1);
    assert.equal(thinkingOf(retried).turns.length, 1);
    assert.equal(thinkingOf(retried).turns[0].status, "complete");
    const wallet = (
      await db.sql`select * from account_private.guidance_wallet where id='openai'`
    )[0];
    assert.equal(Number(wallet.reserved_microusd), 0);
    const checks = (
      await db.sql`select count(*) n from account_private.project_planning_runs where max_output_tokens=800 and status='completed'`
    )[0];
    assert.equal(
      Number(wallet.spent_microusd),
      calls * 8000 + Number(checks.n) * 36,
    );
  } finally {
    await db.close();
  }
});
