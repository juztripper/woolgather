import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planningTestDatabase } from "../scripts/planning-test-database";
import type { Project } from "../packages/domain/src";
import { projectPlanning } from "../apps/api/src/projectPlanning";
import { projectDeletionError } from "../apps/api/src/projectDeletionError";
import type { GuidanceRpc } from "../apps/api/src/ideaGuidance";

test("deletion failures describe the requested action without claiming writing was saved", async () => {
  for (const action of ["delete_conversation", "delete_source"] as const) {
    const subject = action === "delete_conversation" ? "chat" : "source";
    for (const failure of [
      { code: "22023", message: "Unknown planning command", status: 503 },
      { code: "22023", message: "Invalid source command", status: 503 },
      { code: "PGRST202", message: "Function not found", status: 503 },
      { code: "PT409", message: "Revision conflict", status: 409 },
      {
        code: "PT425",
        message: "A voice session is still being reconciled",
        status: 409,
      },
      { code: "P0002", message: "Not found", status: 404 },
      { code: "42501", message: "Permission denied", status: 403 },
      { code: "28000", message: "Sign in required", status: 401 },
      {
        code: "connection_interrupted",
        message: "Uncertain outcome",
        status: 503,
      },
    ]) {
      const command = {
        id: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        revision: 1,
        action,
        ...(subject === "chat"
          ? { conversationId: "main" }
          : { sourceId: crypto.randomUUID() }),
      };
      const rpc: GuidanceRpc = async (name, args) => {
        assert.equal(
          name,
          subject === "chat"
            ? "project_planning_command"
            : "project_source_command",
        );
        assert.deepEqual(args.command, command);
        return { data: null, error: failure };
      };
      const response = await projectPlanning(
        rpc,
        async () =>
          assert.fail("Deletion must not reserve or settle paid work"),
        {},
        crypto.randomUUID(),
        command,
        async () => assert.fail("Deletion must not call a provider"),
      );
      const body = (await response.json()) as { error: string };
      assert.equal(response.status, failure.status);
      assert.match(body.error, new RegExp(subject, "i"));
      assert.doesNotMatch(
        body.error,
        /writing is saved|thought is saved|reply could not be confirmed|Unknown planning command|Invalid source command/,
      );
      if (failure.code === "connection_interrupted")
        assert.match(
          body.error,
          /could not be confirmed.*check before trying again/,
        );
    }
  }
});

test("deletion errors keep invalid requests distinct from unavailable commands", () => {
  assert.equal(
    projectDeletionError(
      { code: "22023", message: "Restore this project before editing" },
      "chat",
    ).status,
    422,
  );
  assert.equal(projectDeletionError({ code: "42883" }, "source").status, 503);
});

test("the deletion migration upgrades an existing project without losing its plan", async () => {
  const migration =
    "20260914175310_permanently_delete_project_chat_and_sources.sql";
  const db = await planningTestDatabase(55503, migration);
  try {
    let project = await db.createProject(
      "Existing project before deletion support.",
    );
    const noted = await db.rpc("project_planning_command", {
      command: {
        id: crypto.randomUUID(),
        projectId: project.id,
        revision: project.revision,
        action: "turn",
        turnId: crypto.randomUUID(),
        mode: "note",
        text: "Keep this separately saved plan thought.",
        focusId: null,
      },
    });
    assert.equal(noted.error, null);
    project = noted.data as Project;
    const command = {
      id: crypto.randomUUID(),
      projectId: project.id,
      revision: project.revision,
      action: "delete_conversation",
      conversationId: "main",
    };
    const before = await projectPlanning(
      db.rpc,
      db.settleRpc,
      {},
      db.owner,
      command,
    );
    assert.equal(before.status, 503);
    assert.match(
      ((await before.json()) as { error: string }).error,
      /Chat deletion is temporarily unavailable/,
    );
    assert.deepEqual(
      (await db.rpc("project_snapshot", { project_id: project.id })).data,
      project,
    );

    await db.sql.unsafe(
      await readFile(`supabase/migrations/${migration}`, "utf8"),
    );
    const after = await projectPlanning(
      db.rpc,
      db.settleRpc,
      {},
      db.owner,
      command,
    );
    assert.equal(after.status, 200);
    const { project: saved } = (await after.json()) as { project: Project };
    assert.deepEqual(saved.thinking?.conversations, []);
    assert.deepEqual(saved.thinking?.turns, []);
    assert.deepEqual(
      saved.items.map(({ evidence, ...item }) => item),
      project.items.map(({ evidence, ...item }) => item),
    );
    const replay = await projectPlanning(
      db.rpc,
      db.settleRpc,
      {},
      db.owner,
      command,
    );
    assert.deepEqual(await replay.json(), { project: saved, enabled: false });
    assert.deepEqual(
      (await db.rpc("project_snapshot", { project_id: project.id })).data,
      saved,
    );
  } finally {
    await db.close();
  }
});
