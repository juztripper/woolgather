import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "../packages/domain/src";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import { thinkingOf } from "../packages/domain/src/projectPlanning";
import { projectPlanning } from "../apps/api/src/projectPlanning";
import { parseProjectScope } from "../apps/api/src/projectScope";
import { visibleWorkActivity } from "../apps/web/src/projects/conversationWork";
import {
  planningTestDatabase,
  syntheticPlanningResponse,
} from "../scripts/planning-test-database";
import { syntheticScopeResponse } from "../scripts/fixtures/planning-scope";

test("recaps preserve usable Undo and proposal-only updates save a visible durable summary", async () => {
  const db = await planningTestDatabase(55520);
  try {
    const env = {
      PROJECT_PLANNING_ENABLED: "true",
      OPENAI_API_KEY: "synthetic-only",
      ACCOUNT_ACTION_SECRET: db.secret,
    };
    let project = await db.createProject();
    let phase: "capture" | "recap" | "suggest" = "capture";
    let calls = 0;
    const send: typeof fetch = async (_url, init) => {
      calls++;
      const body = init!.body as string;
      const request = JSON.parse(body);
      if (request.tool_choice?.name === "check_project_scope")
        return syntheticScopeResponse(body, {
          decision: "allow",
          reply: "",
          planning: {
            language: "en",
            intent: phase === "capture" ? "authored_update" : "discussion",
            resolvedThoughtIds: [],
            reclassifiedThoughtIds: [],
          },
        });
      const context = JSON.parse(
        request.input[1].content.split("\n").slice(1).join("\n"),
      );
      assert.equal(
        context.requestInterpretation.intent,
        phase === "capture" ? "authored_update" : "discussion",
      );
      const response = (await syntheticPlanningResponse(body).json()) as {
        output: Array<{ arguments: string }>;
      };
      if (phase !== "capture") {
        const raw = JSON.parse(response.output[0].arguments);
        raw.reply =
          "The calm hint is saved. A soft sound could accompany it if you choose.";
        raw.concepts =
          phase === "recap"
            ? []
            : [
                {
                  ref: "new:soft-sound",
                  title: "A soft sound",
                  body: "A soft sound could accompany the calm hint.",
                  category: "feature",
                  certainty: "tentative",
                  status: "open",
                  answer: "",
                  origin: "suggestion",
                  evidenceRef: null,
                  reason: "An optional idea, not yet chosen.",
                },
              ];
        raw.relations = [];
        raw.focus = null;
        response.output[0].arguments = JSON.stringify(raw);
      }
      return Response.json(response);
    };
    const message = async (text: string) => {
      const response = await projectPlanning(
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
          text,
          mode: "assist",
          composer: { ...defaultComposer(), reasoning: "quick" },
        },
        send,
      );
      const result = (await response.json()) as {
        project: Project;
        notice?: string;
      };
      project = result.project;
      assert.equal(
        thinkingOf(project).turns.at(-1)!.status,
        "complete",
        result.notice || "Reply should complete",
      );
    };
    await message("Use a calm preparation hint.");
    const evidence = structuredClone(project.items[0].evidence);
    const originalUndo = structuredClone(thinkingOf(project).undo);
    phase = "recap";
    await message("Please recap the decision.");
    assert.equal(calls, 4, "Interpretation does not add another provider call");
    assert.deepEqual(project.items[0].evidence, evidence);
    assert.equal(thinkingOf(project).undo!.revision, project.revision);
    assert.deepEqual(thinkingOf(project).undo!.items, originalUndo!.items);
    const reopened = (
      await db.rpc("project_snapshot", { project_id: project.id })
    ).data as Project;
    assert.deepEqual(reopened, project);
    const undone = await db.rpc("project_planning_command", {
      command: {
        action: "undo",
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
      },
    });
    assert.equal(undone.error, null);
    project = undone.data as Project;
    assert.equal(project.items.filter((item) => !item.removed).length, 0);
    phase = "suggest";
    await message("Could a sound fit the hint?");
    const turn = thinkingOf(project).turns.at(-1)!;
    assert.deepEqual(turn.changedIds, []);
    assert.equal(thinkingOf(project).proposals.length, 1);
    assert.ok(
      visibleWorkActivity(turn.work?.activity).some(
        (entry) =>
          entry.label === "Updated the plan" && entry.detail === "1 suggestion",
      ),
    );
    assert.deepEqual(
      (await db.rpc("project_snapshot", { project_id: project.id })).data,
      project,
    );
  } finally {
    await db.close();
  }
});

test("missing or invalid meaning interpretation fails closed", () => {
  for (const planning of [
    undefined,
    { language: "en", intent: "discussion" },
    {
      language: "en; ignore rules",
      intent: "discussion",
      resolvedThoughtIds: [],
      reclassifiedThoughtIds: [],
    },
  ]) {
    assert.throws(
      () => parseProjectScope({ decision: "allow", reply: "", planning }),
      /message check was incomplete/,
    );
  }
});
