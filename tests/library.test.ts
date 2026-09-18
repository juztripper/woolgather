import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
test("Ideas and personal project organization preserve ownership, revisions and original text", async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    idea = crypto.randomUUID(),
    folder = crypto.randomUUID(),
    pid = crypto.randomUUID();
  const as = async (
    owner: string,
    fn: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal: "aal1" })},true)`;
      return fn(tx);
    });
  const run = (owner: string, c: object) =>
    as(
      owner,
      async (tx) =>
        (
          await tx`select public.library_command(${tx.json(c as postgres.JSONValue)}) d`
        )[0].d,
    ) as Promise<any>;
  const change = (revision: number, action: object) =>
    as(
      a,
      async (tx) =>
        (
          await tx`select public.execute_command(${tx.json({ id: crypto.randomUUID(), projectId: pid, expectedRevision: revision, action } as postgres.JSONValue)}) d`
        )[0].d,
    ) as Promise<any>;
  try {
    await sql`insert into auth.users(id) values(${a}),(${b})`;
    await sql`insert into auth.sessions(id,user_id) values(${a},${a}),(${b},${b})`;
    const create = {
      id: crypto.randomUUID(),
      targetId: idea,
      expectedRevision: 0,
      type: "save_idea",
      body: "Maybe a quiet creature game.\nCombat is still undecided.",
    };
    const [first, retry] = await Promise.all([run(a, create), run(a, create)]);
    assert.deepEqual(first, retry);
    assert.equal(first.ideas.length, 1);
    assert.deepEqual(
      await as(
        b,
        async (tx) => (await tx`select public.library_snapshot() d`)[0].d,
      ),
      { ideas: [], folders: [] },
    );
    await assert.rejects(
      run(b, { ...create, id: crypto.randomUUID(), expectedRevision: 1 }),
      /not found/,
    );
    await assert.rejects(
      run(a, { ...create, body: "changed" }),
      /Retry key reused/,
    );
    await run(a, {
      id: crypto.randomUUID(),
      targetId: folder,
      expectedRevision: 0,
      type: "save_folder",
      name: "Games",
    });
    const foreign = crypto.randomUUID();
    await run(b, {
      id: crypto.randomUUID(),
      targetId: foreign,
      expectedRevision: 0,
      type: "save_folder",
      name: "Private",
    });
    const folderProject = crypto.randomUUID();
    const folderCommand = {
      id: crypto.randomUUID(),
      projectId: folderProject,
      expectedRevision: 0,
      action: {
        type: "create_project",
        name: "Folder creation",
        description: "",
        folderId: folder,
      },
    };
    const inFolder = (await as(
      a,
      async (tx) =>
        (
          await tx`select public.execute_command(${tx.json(folderCommand)}) d`
        )[0].d,
    )) as any;
    assert.equal(inFolder.folderId, folder);
    const conversion = {
      id: crypto.randomUUID(),
      targetId: idea,
      expectedRevision: 1,
      type: "convert_idea",
      projectId: pid,
      name: "",
      folderId: folder,
    };
    await assert.rejects(
      run(a, { ...conversion, folderId: foreign }),
      /Folder not found/,
    );
    const [converted, again] = await Promise.all([
      run(a, conversion),
      run(a, conversion),
    ]);
    assert.deepEqual(converted, again);
    assert.equal(converted.ideas[0].projectId, pid);
    const snapshot = (await as(
      a,
      async (tx) => (await tx`select public.project_snapshot(${pid}) d`)[0].d,
    )) as any;
    assert.equal(snapshot.name, "Untitled Project");
    assert.equal(snapshot.originalIdea, create.body);
    assert.equal(snapshot.description, create.body);
    assert.deepEqual(snapshot.items, []);
    assert.equal(snapshot.folderId, folder);
    await assert.rejects(
      run(a, { ...create, id: crypto.randomUUID(), expectedRevision: 2 }),
      /read only/,
    );
    await assert.rejects(
      run(a, { ...conversion, id: crypto.randomUUID() }),
      /Revision conflict/,
    );
    let p = await change(1, {
      type: "update_project",
      name: "Field notes",
      description: "A developing idea",
      folderId: null,
    });
    assert.equal(p.revision, 2);
    assert.equal(p.originalIdea, create.body);
    await assert.rejects(
      change(1, { type: "rename_project", name: "Stale" }),
      /Revision conflict/,
    );
    p = await change(2, {
      type: "set_project_lifecycle",
      lifecycle: "archived",
    });
    assert.equal(p.lifecycle, "archived");
    await assert.rejects(
      change(3, { type: "rename_project", name: "No" }),
      /Restore this project/,
    );
    p = await change(3, {
      type: "set_project_lifecycle",
      lifecycle: "trashed",
    });
    assert.equal(p.lifecycle, "trashed");
    p = await change(4, { type: "set_project_lifecycle", lifecycle: "active" });
    assert.equal(p.originalIdea, create.body);
    await sql`delete from auth.sessions where id=${a}`;
    assert.deepEqual(
      await as(
        a,
        async (tx) => (await tx`select public.library_snapshot() d`)[0].d,
      ),
      { ideas: [], folders: [] },
    );
    await assert.rejects(
      run(a, {
        id: crypto.randomUUID(),
        targetId: crypto.randomUUID(),
        expectedRevision: 0,
        type: "save_idea",
        body: "blocked",
      }),
      /Sign in required/,
    );
  } finally {
    await sql`delete from auth.users where id in (${a},${b})`;
    await sql.end();
  }
});
