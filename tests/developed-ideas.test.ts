import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  emptyIdeaDocument,
  buildIdeaBrief,
  pendingIdeaQuestions,
} from "../packages/domain/src/ideaDocument";

test("developed ideas retain context and owned images atomically through retries, conversion, and independent deletion", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    idea = crypto.randomUUID(),
    image = crypto.randomUUID(),
    project = crypto.randomUUID();
  const as = (
    owner: string,
    fn: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal: "aal1" })},true)`;
      return fn(tx);
    });
  const run = (owner: string, command: object) =>
    as(
      owner,
      async (tx) =>
        (
          await tx`select public.library_command(${tx.json(command as postgres.JSONValue)}) d`
        )[0].d,
    ) as Promise<any>;
  const pic = (owner: string) =>
    as(
      owner,
      async (tx) => (await tx`select public.reference_image(${image}) d`)[0].d,
    ) as Promise<any>;
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  try {
    await sql`insert into auth.users(id) values(${a}),(${b})`;
    await sql`insert into auth.sessions(id,user_id) values(${a},${a}),(${b},${b})`;
    const upload = { id: image, dataUrl: png };
    const uploadAs = (owner: string, command = upload) =>
      as(
        owner,
        async (tx) =>
          (
            await tx`select public.upload_reference_image(${tx.json(command)}) d`
          )[0].d,
      );
    assert.deepEqual(await uploadAs(a), await uploadAs(a));
    assert.equal((await pic(a)).dataUrl, png);
    assert.equal(await pic(b), null);
    await assert.rejects(
      uploadAs(a, {
        ...upload,
        dataUrl: "data:image/png;base64,SGVsbG9ub3RhbmFjdHVhbGltYWdl",
      }),
      /Invalid image/,
    );
    const document = emptyIdeaDocument();
    document.title = "Restaurant idea";
    document.questions = [
      {
        id: crypto.randomUUID(),
        text: "Could delivery matter in a later version?",
        important: false,
      },
    ];
    document.answers.purpose = "Take customer orders";
    document.answers.possibilities =
      "Maybe delivery someday; not a commitment.";
    document.references = [
      { id: image, name: "Logo.png", caption: "Our existing logo" },
    ];
    const create = {
      id: crypto.randomUUID(),
      targetId: idea,
      expectedRevision: 0,
      type: "save_idea",
      body: "I want an app for my restaurant.",
      document,
    };
    await assert.rejects(
      run(b, { ...create, targetId: crypto.randomUUID() }),
      /Invalid idea document/,
    );
    await assert.rejects(
      run(a, { ...create, document: { ...document, answers: {} } }),
      /Invalid idea document/,
    );
    const first = await run(a, create);
    assert.deepEqual(first.ideas[0].document, document);
    assert.deepEqual(await run(a, create), first);
    assert(!JSON.stringify(first).includes("base64"));
    await assert.rejects(
      run(a, { ...create, id: crypto.randomUUID(), expectedRevision: 9 }),
      /Revision conflict/,
    );
    const convert = {
      id: crypto.randomUUID(),
      targetId: idea,
      expectedRevision: 1,
      type: "convert_idea",
      projectId: project,
      name: "",
      folderId: null,
      brief: buildIdeaBrief(create.body, document),
      questions: pendingIdeaQuestions(create.body, document).map((q) => q.text),
    };
    await assert.rejects(
      run(a, { ...convert, questions: ["a".repeat(201)] }),
      /Invalid question/,
    );
    assert.equal(
      (
        await sql`select count(*) n from planning.projects where id=${project}`
      )[0].n,
      "0",
    );
    const [converted, retry] = await Promise.all([
      run(a, convert),
      run(a, convert),
    ]);
    assert.deepEqual(converted, retry);
    const snapshot = () =>
      as(
        a,
        async (tx) =>
          (await tx`select public.project_snapshot(${project}) d`)[0].d,
      ) as Promise<any>;
    const p = await snapshot();
    assert.equal(p.name, "Untitled Project");
    assert.equal(p.description, convert.brief);
    assert.deepEqual(p.ideaQuestions, convert.questions);
    assert.equal(p.originalIdea, create.body);
    assert.deepEqual(p.ideaDocument, document);
    assert.deepEqual(p.references, document.references);
    const contextOnlyId = crypto.randomUUID(),
      contextProject = crypto.randomUUID();
    const contextDoc = emptyIdeaDocument();
    contextDoc.answers.purpose = "Organize the team schedule";
    await run(a, {
      ...create,
      id: crypto.randomUUID(),
      targetId: contextOnlyId,
      body: "",
      document: contextDoc,
    });
    await run(a, {
      ...convert,
      id: crypto.randomUUID(),
      targetId: contextOnlyId,
      projectId: contextProject,
      brief: buildIdeaBrief("", contextDoc),
      questions: pendingIdeaQuestions("", contextDoc).map((q) => q.text),
    });
    const contextSnapshot = (await as(
      a,
      async (tx) =>
        (await tx`select public.project_snapshot(${contextProject}) d`)[0].d,
    )) as any;
    assert.equal(contextSnapshot.originalIdea, "");
    assert.equal(
      contextSnapshot.ideaDocument.answers.purpose,
      contextDoc.answers.purpose,
    );
    assert.equal(contextSnapshot.ideaQuestions.length, 0);
    assert.equal(p.items.length, 1);
    assert(
      p.items.every(
        (i: any) =>
          i.category === "question" &&
          i.status === "open" &&
          i.certainty === "tentative" &&
          i.source === "Open question from original idea",
      ),
    );
    await assert.rejects(
      run(a, { ...create, id: crypto.randomUUID(), expectedRevision: 2 }),
      /read only/,
    );
    // Existing clients that only edit body cannot erase structured context.
    const other = crypto.randomUUID();
    await run(a, { ...create, id: crypto.randomUUID(), targetId: other });
    const edited = await run(a, {
      id: crypto.randomUUID(),
      targetId: other,
      expectedRevision: 1,
      type: "save_idea",
      body: "Updated original note",
    });
    assert.deepEqual(
      edited.ideas.find((i: any) => i.id === other).document,
      document,
    );
    const deleteIdea = async (id: string, revision: number) => {
      const result = await run(a, {
        id: crypto.randomUUID(),
        targetId: id,
        expectedRevision: revision,
        type: "trash_idea",
      });
      const trashed = result.ideas.find((i: any) => i.id === id);
      await as(
        a,
        async (tx) =>
          tx`select public.delete_trash(${tx.json({ id: crypto.randomUUID(), projects: [], ideas: [{ id, revision: trashed.revision }] })})`,
      );
    };
    await deleteIdea(idea, 2);
    await deleteIdea(other, 2);
    assert.equal(
      (await pic(a)).dataUrl,
      png,
      "project source keeps the image after original deletion",
    );
    assert.deepEqual((await snapshot()).ideaDocument, document);
    await assert.rejects(run(a, convert), /permanently deleted/);
    const updated = (await as(
      a,
      async (tx) =>
        (
          await tx`select public.execute_command(${tx.json({ id: crypto.randomUUID(), projectId: project, expectedRevision: 1, action: { type: "update_references", references: [] } })}) d`
        )[0].d,
    )) as any;
    assert.deepEqual(updated.references, []);
    assert.deepEqual(updated.ideaDocument.references, document.references);
    const trashed = (await as(
      a,
      async (tx) =>
        (
          await tx`select public.execute_command(${tx.json({ id: crypto.randomUUID(), projectId: project, expectedRevision: 2, action: { type: "set_project_lifecycle", lifecycle: "trashed" } })}) d`
        )[0].d,
    )) as any;
    await as(
      a,
      async (tx) =>
        tx`select public.delete_trash(${tx.json({ id: crypto.randomUUID(), projects: [{ id: project, revision: trashed.revision }], ideas: [] })})`,
    );
    assert.equal(
      await pic(a),
      null,
      "permanent deletion removes unreferenced image bytes",
    );
    await uploadAs(a, { id: crypto.randomUUID(), dataUrl: png });
    await sql`delete from auth.sessions where id=${a}`;
    await assert.rejects(
      uploadAs(a, { id: crypto.randomUUID(), dataUrl: png }),
      /Sign in required/,
    );
    assert.equal(await pic(a), null);
  } finally {
    await sql`delete from auth.users where id in (${a},${b})`;
    assert.equal(
      (
        await sql`select count(*) n from planning.reference_images where owner_id in (${a},${b})`
      )[0].n,
      "0",
    );
    await sql.end();
  }
});
