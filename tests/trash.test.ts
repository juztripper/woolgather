import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
test("Permanent trash deletion is scoped, atomic, revision checked and retry safe", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  const run = async (
    actor: string,
    rpc: string,
    command: object,
  ): Promise<any> =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${actor},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: actor, aal: "aal1" })},true)`;
      return (
        await tx`select public.${tx(rpc)}(${tx.json(command as postgres.JSONValue)}) d`
      )[0].d;
    });
  const lib = (c: object) => run(owner, "library_command", c);
  const project = (pid: string, revision: number, action: object) =>
    run(owner, "execute_command", {
      id: crypto.randomUUID(),
      projectId: pid,
      expectedRevision: revision,
      action,
    });
  const remove = (projects: object[], ideas: object[] = []) => ({
    id: crypto.randomUUID(),
    projects,
    ideas,
  });
  try {
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner}),(${other},${other})`;
    const pid = crypto.randomUUID(),
      iid = crypto.randomUUID(),
      survivor = crypto.randomUUID();
    const createIdea = {
      id: crypto.randomUUID(),
      targetId: iid,
      expectedRevision: 0,
      type: "save_idea",
      body: "purge-private-original",
    };
    await lib(createIdea);
    const convert = {
      id: crypto.randomUUID(),
      targetId: iid,
      expectedRevision: 1,
      type: "convert_idea",
      projectId: pid,
      name: "Delete me",
      folderId: null,
    };
    await lib(convert);
    await lib({
      id: crypto.randomUUID(),
      targetId: survivor,
      expectedRevision: 0,
      type: "save_idea",
      body: "Keep this",
    });
    const populated = await project(pid, 1, {
      type: "add_item",
      itemId: crypto.randomUUID(),
      item: {
        title: "Private item",
        body: "purge-private-original",
        category: "decision",
        certainty: "tentative",
        status: "open",
        answer: "",
        links: [],
      },
    });
    assert.equal(populated.items.length, 1);
    let p = await project(pid, populated.revision, {
      type: "set_project_lifecycle",
      lifecycle: "trashed",
    });
    const deletion = remove([{ id: pid, revision: p.revision }]);
    await assert.rejects(run(other, "delete_trash", deletion), /Trash changed/);
    await assert.rejects(
      run(
        owner,
        "delete_trash",
        remove([{ id: pid, revision: p.revision - 1 }]),
      ),
      /Trash changed/,
    );
    await assert.rejects(
      run(
        owner,
        "delete_trash",
        remove([
          { id: pid, revision: p.revision },
          { id: crypto.randomUUID(), revision: 1 },
        ]),
      ),
      /Trash changed/,
    );
    assert.equal(
      (await sql`select count(*) n from planning.projects where id=${pid}`)[0]
        .n,
      "1",
    );
    // Restored after confirmation: the whole selection must remain.
    p = await project(pid, p.revision, {
      type: "set_project_lifecycle",
      lifecycle: "active",
    });
    await assert.rejects(run(owner, "delete_trash", deletion), /Trash changed/);
    p = await project(pid, p.revision, {
      type: "set_project_lifecycle",
      lifecycle: "trashed",
    });
    const newer = crypto.randomUUID();
    let n = await project(newer, 0, {
      type: "create_project",
      name: "Trashed later",
      description: "",
    });
    n = await project(newer, n.revision, {
      type: "set_project_lifecycle",
      lifecycle: "trashed",
    });
    await lib({
      id: crypto.randomUUID(),
      targetId: iid,
      expectedRevision: 3, // Trashing the project released the linked idea.
      type: "trash_idea",
    });
    const actual = remove(
      [{ id: pid, revision: p.revision }],
      [{ id: iid, revision: 4 }],
    );
    const [result, retry] = await Promise.all([
      run(owner, "delete_trash", actual),
      run(owner, "delete_trash", actual),
    ]);
    assert.deepEqual(result, retry);
    assert.ok(result.ideas.includes(iid));
    for (const table of ["projects", "items", "history", "commands"]) {
      const column = table === "projects" ? "id" : "project_id";
      assert.equal(
        (
          await sql.unsafe(
            `select count(*) n from planning.${table} where ${column}=$1`,
            [pid],
          )
        )[0].n,
        "0",
      );
    }
    assert.equal(
      (await sql`select count(*) n from planning.ideas where id=${iid}`)[0].n,
      "0",
    );
    assert.equal(
      (await sql`select count(*) n from planning.projects where id=${newer}`)[0]
        .n,
      "1",
    );
    assert.equal(
      (
        await sql`select count(*) n from planning.library_receipts where owner_id=${owner} and (request::text like '%purge-private-original%' or result::text like '%purge-private-original%')`
      )[0].n,
      "0",
    );
    await assert.rejects(lib(createIdea), /permanently deleted/);
    await assert.rejects(lib(convert), /permanently deleted/);
    await assert.rejects(
      project(pid, 0, {
        type: "create_project",
        name: "Resurrection",
        description: "",
      }),
      /permanently deleted/,
    );
    await assert.rejects(
      run(owner, "delete_trash", {
        ...actual,
        ideas: [{ id: survivor, revision: 1 }],
      }),
      /Retry key reused/,
    );
    // Active ideas cannot be purged. Empty-trash selection deletes both types.
    await assert.rejects(
      run(owner, "delete_trash", remove([], [{ id: survivor, revision: 1 }])),
      /Trash changed/,
    );
    await lib({
      id: crypto.randomUUID(),
      targetId: survivor,
      expectedRevision: 1,
      type: "trash_idea",
    });
    await run(
      owner,
      "delete_trash",
      remove(
        [{ id: newer, revision: n.revision }],
        [{ id: survivor, revision: 2 }],
      ),
    );
    assert.equal(
      (
        await sql`select count(*) n from planning.projects where owner_id=${owner}`
      )[0].n,
      "0",
    );
    assert.equal(
      (
        await sql`select count(*) n from planning.ideas where owner_id=${owner}`
      )[0].n,
      "0",
    );

    // Folder deletion preserves all project lifecycles and invalidates stale edits.
    const fid = crypto.randomUUID();
    await lib({
      id: crypto.randomUUID(),
      targetId: fid,
      expectedRevision: 0,
      type: "save_folder",
      name: "Folder QA",
    });
    const kept = [];
    for (const lifecycle of ["active", "archived", "trashed"]) {
      const id = crypto.randomUUID();
      let p = await project(id, 0, {
        type: "create_project",
        name: lifecycle,
        description: "Preserve",
        folderId: fid,
      });
      if (lifecycle !== "active")
        p = await project(id, p.revision, {
          type: "set_project_lifecycle",
          lifecycle,
        });
      kept.push(p);
    }
    const drop = {
      id: crypto.randomUUID(),
      targetId: fid,
      expectedRevision: 1,
      type: "delete_folder",
    };
    await assert.rejects(
      run(other, "library_command", drop),
      /Folder not found/,
    );
    await assert.rejects(
      lib({ ...drop, expectedRevision: 2 }),
      /Revision conflict/,
    );
    await lib(drop);
    await lib(drop);
    assert.equal(
      (await sql`select count(*) n from planning.folders where id=${fid}`)[0].n,
      "0",
    );
    for (const p of kept) {
      const [row] = await sql`select * from planning.projects where id=${p.id}`;
      assert.equal(row.folder_id, null);
      assert.equal(row.lifecycle, p.lifecycle);
      assert.equal(row.revision, p.revision + 1);
      assert.equal(row.description, "Preserve");
    }
    await assert.rejects(
      lib({
        id: crypto.randomUUID(),
        targetId: fid,
        expectedRevision: 0,
        type: "save_folder",
        name: "Resurrect",
      }),
      /Folder deleted/,
    );
    await sql`delete from auth.sessions where user_id=${owner}`;
    await assert.rejects(
      run(owner, "delete_trash", actual),
      /Sign in required/,
    );
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});
