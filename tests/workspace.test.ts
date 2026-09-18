import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { libraryEntries, type Idea } from "../packages/domain/src/library";
import type { ProjectSummary } from "../packages/domain/src";

test("Workspace locations contain both types; filters and recent span locations", () => {
  const folder = "folder";
  const p: ProjectSummary = {
    id: "p",
    name: "Project",
    description: "",
    folderId: folder,
    lifecycle: "active",
    revision: 1,
    updatedAt: "2026-09-09",
    itemCount: 0,
  };
  const idea: Idea = {
    id: "i",
    body: "Original",
    projectId: p.id,
    folderId: folder,
    revision: 2,
    updatedAt: "2026-09-08",
    trashed: false,
  };
  const root: Idea = { ...idea, id: "root", projectId: null, folderId: null };
  const archived: Idea = { ...idea, id: "archive", archived: true };
  const trashed: Idea = { ...idea, id: "trash", trashed: true };
  const ideas = [idea, root, archived, trashed];
  const ids = (
    view: Parameters<typeof libraryEntries>[0],
    recent: string[] = [],
  ) => libraryEntries(view, [p], ideas, recent).map((e) => e.item.id);
  assert.deepEqual(ids("workspace"), ["root"]);
  assert.deepEqual(ids("folder:folder").sort(), ["i", "p"]);
  assert.deepEqual(ids("ideas").sort(), ["i", "root"]);
  assert.deepEqual(ids("projects"), ["p"]);
  assert.deepEqual(ids("recent", ["i", "p", "archive", "trash", "missing"]), [
    "i",
    "p",
  ]);
  assert.deepEqual(ids("archive"), ["archive"]);
  assert.deepEqual(ids("trash"), ["trash"]);
  assert.deepEqual(
    libraryEntries("folder:folder", [p], ideas, [], "original").map(
      (e) => e.item.id,
    ),
    ["i"],
  );
});

test("Shared folders preserve original ideas, ownership, lifecycle and independent deletion", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    folder = crypto.randomUUID(),
    foreign = crypto.randomUUID(),
    idea = crypto.randomUUID(),
    project = crypto.randomUUID();
  async function run(
    actor: string,
    rpc: string,
    command: object,
  ): Promise<any> {
    return sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: actor, aal: "aal1" })},true)`;
      return (
        await tx`select public.${tx(rpc)}(${tx.json(command as postgres.JSONValue)}) d`
      )[0].d;
    });
  }
  const command = (
    type: string,
    targetId: string,
    expectedRevision: number,
    extra: object = {},
  ) => ({
    id: crypto.randomUUID(),
    targetId,
    expectedRevision,
    type,
    ...extra,
  });
  const lib = (c: object) => run(owner, "library_command", c);
  const snapshot = async () =>
    (await sql`select public.project_snapshot(${project}) d`)[0].d;
  const trashProject = (revision: number) =>
    run(owner, "execute_command", {
      id: crypto.randomUUID(),
      projectId: project,
      expectedRevision: revision,
      action: { type: "set_project_lifecycle", lifecycle: "trashed" },
    });
  try {
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner}),(${other},${other})`;
    await lib(command("save_folder", folder, 0, { name: "Creature game" }));
    await run(
      other,
      "library_command",
      command("save_folder", foreign, 0, { name: "Private" }),
    );
    await assert.rejects(
      lib(
        command("save_idea", idea, 0, {
          body: "Private folder attempt",
          folderId: foreign,
        }),
      ),
      /Folder not found/,
    );
    await lib(
      command("save_idea", idea, 0, {
        body: "Uncertain idea, not a decision.",
        folderId: folder,
      }),
    );
    const conversion = command("convert_idea", idea, 1, {
      projectId: project,
      name: "",
      folderId: folder,
    });
    const converted = await lib(conversion);
    assert.deepEqual(converted, await lib(conversion));
    assert.equal(converted.ideas[0].folderId, folder);
    let p = await snapshot();
    assert.equal(p.name, "Untitled Project");
    assert.equal(p.folderId, folder);
    assert.equal(p.originalIdea, "Uncertain idea, not a decision.");
    assert.equal(p.items.length, 0);
    await assert.rejects(
      run(
        other,
        "library_command",
        command("move_idea", idea, 2, { folderId: null }),
      ),
      /Idea not found/,
    );
    await assert.rejects(
      lib(command("move_idea", idea, 2, { folderId: foreign })),
      /Folder not found/,
    );
    await assert.rejects(
      lib(command("move_idea", idea, 1, { folderId: null })),
      /Revision conflict/,
    );
    const moved = await lib(command("move_idea", idea, 2, { folderId: null }));
    assert.equal(moved.ideas[0].folderId, null);
    assert.equal((await snapshot()).folderId, folder);
    await lib(command("archive_idea", idea, 3));
    await assert.rejects(
      lib(command("move_idea", idea, 4, { folderId: folder })),
      /Restore this idea/,
    );
    const restored = await lib(command("restore_idea", idea, 4));
    assert.equal(restored.ideas[0].archived, false);
    await lib(command("move_idea", idea, 5, { folderId: folder }));
    const dropped = await lib(command("delete_folder", folder, 1));
    assert.equal(dropped.ideas[0].folderId, null);
    p = await snapshot();
    assert.equal(p.folderId, null);
    assert.equal(p.originalIdea, "Uncertain idea, not a decision.");
    // Deleting the project retains the original as an independent idea.
    const sourceBeforeTrash = await snapshot();
    p = await trashProject(p.revision);
    const [released] = await sql`select * from planning.ideas where id=${idea}`;
    assert.equal(
      released.project_id,
      null,
      "Trash immediately releases the idea",
    );
    assert.equal(released.body, sourceBeforeTrash.originalIdea);
    await assert.rejects(
      lib(
        command("save_idea", idea, released.revision - 1, {
          body: "Stale edit",
        }),
      ),
      /Revision conflict/,
    );
    const revisedBody = "A revised direction after discarding the project.";
    await lib(
      command("save_idea", idea, released.revision, { body: revisedBody }),
    );
    p = await run(owner, "execute_command", {
      id: crypto.randomUUID(),
      projectId: project,
      expectedRevision: p.revision,
      action: { type: "set_project_lifecycle", lifecycle: "active" },
    });
    const [afterRestore] =
      await sql`select * from planning.ideas where id=${idea}`;
    assert.equal(
      afterRestore.project_id,
      null,
      "Restoring does not lock the revised idea",
    );
    assert.equal(afterRestore.body, revisedBody);
    assert.equal(p.originalIdea, sourceBeforeTrash.originalIdea);
    assert.deepEqual(p.ideaDocument, sourceBeforeTrash.ideaDocument);
    p = await trashProject(p.revision);
    await run(owner, "delete_trash", {
      id: crypto.randomUUID(),
      projects: [{ id: project, revision: p.revision }],
      ideas: [],
    });
    const [kept] = await sql`select * from planning.ideas where id=${idea}`;
    assert.equal(kept.project_id, null);
    assert.equal(kept.body, revisedBody);
    // A new project keeps source evidence even if its separate original idea is deleted.
    const secondProject = crypto.randomUUID();
    await lib(
      command("convert_idea", idea, kept.revision, {
        projectId: secondProject,
        name: "Second",
        folderId: null,
      }),
    );
    const [linked] = await sql`select * from planning.ideas where id=${idea}`;
    const trashed = await lib(command("trash_idea", idea, linked.revision));
    await run(owner, "delete_trash", {
      id: crypto.randomUUID(),
      projects: [],
      ideas: [{ id: idea, revision: trashed.ideas[0].revision }],
    });
    const remaining = (
      await sql`select public.project_snapshot(${secondProject}) d`
    )[0].d;
    assert.equal(remaining.originalIdea, kept.body);
    assert.equal(remaining.items.length, 0);
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});
