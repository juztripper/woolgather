import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  emptyIdeaDocument,
  materializeIdea,
  withIdeaBlocks,
  ideaDocumentSchema,
  updateIdeaContext,
  openIdeaWritingPrompt,
  insertIdeaQuestionBlock,
  hasIdeaContent,
  emptiedQuestionHeadings,
  availableIdeaWritingPrompts,
  buildIdeaBrief,
} from "../packages/domain/src/ideaDocument";
import {
  ideaBlocksSchema,
  textBlock,
  blockText,
  blocksText,
  blocksMarkdown,
  attachmentScheme,
} from "../packages/domain/src/ideaBlocks";
import { libraryCommandSchema } from "../packages/domain/src/library";

test("writing prompts append once, preserve previous writing, and do not count empty sections as answers", () => {
  const start = materializeIdea("", emptyIdeaDocument()).document;
  const opened = openIdeaWritingPrompt("", start, "purpose", "new-answer");
  assert.equal(opened.created, true);
  assert.deepEqual(opened.document.blocks.slice(0, -2), start.blocks);
  assert.equal(
    blockText(opened.document.blocks.at(-2)!),
    "Questions & answers",
  );
  assert.equal(
    opened.document.blocks.at(-1)?.props.prompt,
    "What could it make possible?",
  );
  assert.equal(
    hasIdeaContent(blocksText(opened.document.blocks), opened.document),
    false,
  );
  const again = openIdeaWritingPrompt(
    "",
    opened.document,
    "purpose",
    "duplicate",
  );
  assert.equal(again.created, false);
  assert.equal(again.blockId, "new-answer");
  assert.equal(again.document, opened.document);
  assert.doesNotThrow(() => ideaDocumentSchema.parse(again.document));
});

test("question groups reuse edited headings and insert before later writing without moving existing content", () => {
  const first = openIdeaWritingPrompt(
    "My idea",
    emptyIdeaDocument(),
    "purpose",
    "first",
  ).document;
  const heading = first.blocks.find((b) => b.type === "heading")!;
  heading.content = [{ type: "text", text: "Things to explore", styles: {} }];
  const later = textBlock("later", "Keep this later note here.");
  const blocks = insertIdeaQuestionBlock(
    [...first.blocks, later],
    textBlock("second", "", "reviewAnswer", { prompt: "Who is it for?" }),
  );
  assert.deepEqual(
    blocks.map((b) => b.id),
    [...first.blocks.map((b) => b.id), "second", "later"],
  );
  assert.equal(blocks.filter((b) => b.type === "heading").length, 1);
  assert.equal(
    blockText(blocks.find((b) => b.type === "heading")!),
    "Things to explore",
  );
  const manual = textBlock("manual", "Questions & Answers", "heading", {
    level: 1,
  });
  const reused = insertIdeaQuestionBlock(
    [manual],
    textBlock("answer", "", "ideaAnswer", { field: "context" }),
  );
  assert.deepEqual(
    reused.map((b) => b.id),
    ["manual", "answer"],
  );
});

test("returning to a nested or legacy prompt preserves exact answers, formatting and question context", () => {
  const legacy = emptyIdeaDocument();
  legacy.answers.context =
    "Guidance question: What matters to you?\nYour answer:\nTime with friends.";
  const migrated = openIdeaWritingPrompt(
    "Existing idea.",
    legacy,
    "context",
    "unused",
  );
  assert.equal(migrated.created, false);
  assert.equal(migrated.document.answers.context, legacy.answers.context);
  const answer = migrated.document.blocks[1];
  answer.content = [
    {
      type: "text",
      text: "Time with friends.\nAnd room to experiment.",
      styles: { bold: true },
    },
  ];
  const parent = textBlock("moved-section", "A section", "heading", {
    level: 2,
  });
  parent.children = [answer];
  const saved = withIdeaBlocks(migrated.document, [
    migrated.document.blocks[0],
    parent,
  ]);
  const opened = openIdeaWritingPrompt(
    blocksText(saved.blocks),
    saved,
    "context",
    "unused-again",
  );
  assert.equal(opened.created, false);
  assert.equal(opened.blockId, answer.id);
  assert.deepEqual(opened.document, saved);
  assert.match(
    buildIdeaBrief(blocksText(saved.blocks), saved),
    /What matters to you\?/,
  );
  assert.match(
    buildIdeaBrief(blocksText(saved.blocks), saved),
    /And room to experiment/,
  );
});

test("block documents preserve existing text, contextual answers, references and questions without inventing formatting", () => {
  const doc = emptyIdeaDocument();
  doc.answers.constraints =
    "Guidance question: Must it be online?\nYour answer:\nNo. It needs to work offline.";
  doc.questions = [
    {
      id: crypto.randomUUID(),
      text: "Should journals be shared later?",
      important: false,
    },
  ];
  doc.references = [
    {
      id: crypto.randomUUID(),
      name: "Sketch.png",
      caption: "An early sketch, not a requirement.",
    },
  ];
  const source =
    "A **quiet** observation game.\nNo combat.\n\nMaybe multiplayer later.";
  const first = materializeIdea(source, doc),
    again = materializeIdea(source, doc);
  assert.deepEqual(first, again);
  assert.equal(blockText(first.document.blocks[0]), source);
  assert.deepEqual(first.document.answers, doc.answers);
  assert.deepEqual(first.document.questions, doc.questions);
  assert.deepEqual(first.document.references, doc.references);
  assert.equal(first.body.includes("Must it be online?"), false);
  assert.deepEqual(ideaDocumentSchema.parse(first.document), first.document);
  const edited = updateIdeaContext(first.document, {
    ...first.document,
    answers: { ...first.document.answers, constraints: "Offline on tablets." },
  });
  assert.equal(edited.answers.constraints, "Offline on tablets.");
  assert(blocksText(edited.blocks).includes("Offline on tablets."));
  assert(!blocksText(edited.blocks).includes("No. It needs to work offline."));
  assert(blocksMarkdown(first.document.blocks).includes("\\*\\*quiet\\*\\*"));
});

test("attachment prose uses the filename while exports retain mapped paths and IDs", () => {
  const attachmentId = crypto.randomUUID();
  const image = {
    id: "starting-image",
    type: "image" as const,
    props: {
      backgroundColor: "default",
      name: "gathered-light.webp",
      url: attachmentScheme + attachmentId,
      caption: "A soft reference for the opening mood.",
      showPreview: true,
    },
    children: [],
  };
  const document = withIdeaBlocks(emptyIdeaDocument(), [image]);
  assert.deepEqual(document.attachments, [attachmentId]);

  const opening = blocksMarkdown(document.blocks);
  assert.equal(
    opening,
    "gathered-light.webp\n\nA soft reference for the opening mood.",
  );
  assert.doesNotMatch(opening, new RegExp(attachmentId));

  const exported = blocksMarkdown(document.blocks, {
    [attachmentId]: `attachments/${attachmentId}-gathered-light.webp`,
  });
  assert.equal(
    exported,
    `![gathered-light.webp](attachments/${attachmentId}-gathered-light.webp)\n\nA soft reference for the opening mood.`,
  );
});

test("rich documents reject unsafe links, remote media, duplicate IDs and mismatched text projections", () => {
  const base = textBlock("p", "Saved writing");
  assert.throws(() => ideaBlocksSchema.parse([base, base]));
  assert.throws(() =>
    ideaBlocksSchema.parse([
      {
        ...base,
        content: [
          {
            type: "link",
            href: "javascript:alert(1)",
            content: [{ type: "text", text: "click", styles: {} }],
          },
        ],
      },
    ]),
  );
  assert.throws(() =>
    ideaBlocksSchema.parse([
      {
        id: "file",
        type: "image",
        props: {
          name: "remote",
          url: "https://example.com/tracker.png",
          caption: "",
          showPreview: true,
        },
        children: [],
      },
    ]),
  );
  const doc = withIdeaBlocks(emptyIdeaDocument(), [base]);
  assert.throws(() =>
    ideaDocumentSchema.parse({
      ...doc,
      answers: { ...doc.answers, purpose: "An invented purpose" },
    }),
  );
  assert.throws(() =>
    libraryCommandSchema.parse({
      id: crypto.randomUUID(),
      targetId: crypto.randomUUID(),
      expectedRevision: 1,
      type: "save_idea",
      body: "Different text",
      document: doc,
    }),
  );
});

test("database validates blocks and attachments across owner isolation, retry, conversion, deletion and garbage collection", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 5 });
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    aid = crypto.randomUUID(),
    iid = crypto.randomUUID(),
    pid = crypto.randomUUID();
  const as = async (
    owner: string,
    fn: (tx: postgres.TransactionSql) => Promise<any>,
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${owner},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: owner, aal: "aal1" })},true)`;
      return fn(tx);
    });
  const run = (owner: string, cmd: object) =>
    as(
      owner,
      async (tx) =>
        (
          await tx`select public.library_command(${tx.json(cmd as postgres.JSONValue)}) d`
        )[0].d,
    );
  const reserve = {
    id: aid,
    name: "notes.txt",
    mime: "application/octet-stream",
    size: 7,
    sha256: "a".repeat(64),
  };
  const blocks = [
    textBlock("intro", "A quiet game. No combat. Maybe sharing later."),
    {
      id: "attachment",
      type: "file" as const,
      props: {
        backgroundColor: "default",
        name: "notes.txt",
        url: attachmentScheme + aid,
        caption: "Reference material",
      },
      children: [],
    },
  ];
  const doc = withIdeaBlocks(emptyIdeaDocument(), blocks),
    body = blocksText(blocks);
  try {
    await sql`insert into auth.users(id) values(${a}),(${b})`;
    await sql`insert into auth.sessions(id,user_id) values(${a},${a}),(${b},${b})`;
    const upload = () =>
      as(
        a,
        async (tx) =>
          (await tx`select public.reserve_attachment(${tx.json(reserve)}) d`)[0]
            .d,
      );
    assert.deepEqual(await upload(), await upload());
    await assert.rejects(
      as(
        b,
        async (tx) => tx`select public.reserve_attachment(${tx.json(reserve)})`,
      ),
    );
    await assert.rejects(
      as(
        a,
        async (tx) =>
          tx`select public.finish_attachment(${aid},${a},${reserve.sha256})`,
      ),
    );
    const command = {
      id: crypto.randomUUID(),
      targetId: iid,
      expectedRevision: 0,
      type: "save_idea",
      body,
      document: doc,
    };
    await assert.rejects(
      run(a, command),
      "Pending bytes must not become a saved attachment",
    );
    await sql`select public.finish_attachment(${aid},${a},${reserve.sha256})`;
    assert.equal(
      await as(
        b,
        async (tx) =>
          (await tx`select public.attachment_metadata(${aid}) d`)[0].d,
      ),
      null,
    );
    const projection = await as(
      a,
      async (tx) =>
        (
          await tx`select planning.idea_block_projection(${tx.json(blocks as postgres.JSONValue)}) d`
        )[0].d,
    );
    assert.equal(projection.body, body);
    assert.deepEqual(projection.attachments, [aid]);
    const saved = await run(a, command);
    assert.deepEqual(await run(a, command), saved);
    await assert.rejects(
      run(b, {
        ...command,
        id: crypto.randomUUID(),
        targetId: crypto.randomUUID(),
      }),
    );
    await assert.rejects(
      run(a, {
        ...command,
        id: crypto.randomUUID(),
        expectedRevision: 1,
        body: "Wrong projection",
      }),
    );
    const converted = await run(a, {
      id: crypto.randomUUID(),
      targetId: iid,
      expectedRevision: 1,
      type: "convert_idea",
      projectId: pid,
      name: "",
      folderId: null,
      brief: "Reviewable brief",
      questions: [],
    });
    assert.equal(converted.ideas.find((i: any) => i.id === iid).projectId, pid);
    const source = await as(
      a,
      async (tx) => (await tx`select public.project_snapshot(${pid}) d`)[0].d,
    );
    assert.deepEqual(source.ideaDocument, doc);
    assert.equal(source.originalIdea, body);
    assert.equal(source.sources.length, 1);
    assert.equal(source.sources[0].attachmentId, aid);
    assert.equal(source.sources[0].name, "notes.txt");
    assert.equal(source.sources[0].meaning, "undecided");
    assert.equal(source.sources[0].note, "");
    const catalog = await as(
      a,
      async (tx) =>
        (await tx`select public.project_source_catalog(${pid}) d`)[0].d,
    );
    assert.deepEqual(catalog, source.sources);
    assert.deepEqual(
      await as(
        b,
        async (tx) =>
          (await tx`select public.project_source_catalog(${pid}) d`)[0].d,
      ),
      [],
    );
    // Removing a catalog entry must not delete the independently owned Idea
    // file or recreate the entry on later project edits/reopening.
    await as(
      a,
      async (tx) =>
        tx`select public.project_source_command(${tx.json({
          id: crypto.randomUUID(),
          projectId: pid,
          revision: source.revision,
          action: "delete_source",
          sourceId: source.sources[0].id,
        })})`,
    );
    await sql`update planning.projects set name='Renamed' where id=${pid}`;
    const reopened = await as(
      a,
      async (tx) => (await tx`select public.project_snapshot(${pid}) d`)[0].d,
    );
    assert.deepEqual(reopened.sources, []);
    assert.deepEqual(reopened.ideaDocument, doc);
    await sql`delete from planning.ideas where id=${iid}`;
    assert.equal(
      (
        await sql`select count(*) n from account_private.attachments where id=${aid}`
      )[0].n,
      "1",
    );
    await sql`delete from planning.projects where id=${pid}`;
    assert.equal(
      (
        await sql`select count(*) n from account_private.attachments where id=${aid}`
      )[0].n,
      "0",
    );
    assert(
      (await sql`select public.collect_attachment_garbage() d`)[0].d.includes(
        a + "/" + aid,
      ),
    );
    await sql`select public.ack_attachment_garbage(${sql.json([a + "/" + aid])})`;
    await assert.rejects(
      upload(),
      "Removed object IDs must not be resurrected during cleanup",
    );
  } finally {
    await sql`delete from auth.users where id in (${a},${b})`;
    await sql.end();
  }
});

test("saved JSONB object ordering does not dirty a rich document", async () => {
  const { stableJson } = await import("../packages/domain/src/stableJson");
  const original = withIdeaBlocks(emptyIdeaDocument(), [
    textBlock("p", "A quiet game."),
  ]);
  const reordered = JSON.parse(JSON.stringify(original), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  assert.notEqual(JSON.stringify(original), JSON.stringify(reordered));
  assert.equal(stableJson(original), stableJson(reordered));
});

test("question title clears only when its last question is deleted and prompts return", () => {
  const first = openIdeaWritingPrompt(
    "My idea",
    emptyIdeaDocument(),
    "purpose",
    "one",
  ).document;
  const second = openIdeaWritingPrompt("", first, "audience", "two").document;
  const heading = second.blocks.find((block) => block.type === "heading")!;
  const remaining = second.blocks.filter((block) => block.id !== "one");
  assert.deepEqual(emptiedQuestionHeadings(second.blocks, remaining), []);
  const removed = remaining.filter((block) => block.id !== "two");
  assert.deepEqual(emptiedQuestionHeadings(remaining, removed), [heading.id]);
  assert.deepEqual(
    emptiedQuestionHeadings(second.blocks, [...second.blocks].reverse()),
    [],
  );
  assert.equal(
    availableIdeaWritingPrompts("", second).includes("purpose"),
    false,
  );
  assert.equal(
    availableIdeaWritingPrompts("", withIdeaBlocks(second, remaining)).includes(
      "purpose",
    ),
    true,
  );
  let full = second;
  for (const field of availableIdeaWritingPrompts("", full))
    full = openIdeaWritingPrompt("", full, field, field).document;
  assert.deepEqual(availableIdeaWritingPrompts("", full), []);
});
