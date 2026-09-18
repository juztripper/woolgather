import { resolvePlanningEvidence } from "../apps/api/src/planningEvidence";
import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { z } from "zod";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import {
  emptyThinking,
  preparePlanningResult,
  thinkingOf,
  type PlanningToolResult,
} from "../packages/domain/src/projectPlanning";
import { exportMarkdown, type Project } from "../packages/domain/src";
const makeCommand = (
  projectId: string,
  expectedRevision: number,
  action: unknown,
) => ({ id: crypto.randomUUID(), projectId, expectedRevision, action });

function fixture(
  text = "Maybe a reminder later. No messages in the first version.",
): Project {
  const thinking = emptyThinking();
  thinking.turns.push({
    id: crypto.randomUUID(),
    text,
    reply: "",
    status: "pending",
    focusId: null,
    createdAt: new Date().toISOString(),
    changedIds: [],
  });
  return {
    id: crypto.randomUUID(),
    name: "Untitled Project",
    description: "",
    revision: 2,
    updatedAt: new Date().toISOString(),
    items: [],
    thinking,
  };
}
function output(project: Project): PlanningToolResult {
  return {
    reply: "We can keep reminders as a possibility for later.",
    concepts: [
      {
        ref: "new:reminders",
        title: "Possible reminders later",
        body: "Maybe add reminders later. No messages in the first version.",
        category: "feature",
        certainty: "tentative",
        status: "open",
        answer: "",
        origin: "author",
        sourceTurn: thinkingOf(project).turns[0].id,
        quote: "Maybe a reminder later. No messages in the first version.",
        reason: "Preserves the explicit scope boundary.",
      },
    ],
    remove: [],
    relations: [],
    removeRelations: [],
    dismissProposals: [],
    focus: "new:reminders",
    view: "map",
  };
}

test("planning captures preserve source and uncertainty; invented evidence and foreign concepts cannot change the plan", () => {
  const p = fixture(),
    original = structuredClone(p),
    result = output(p);
  const prepared = preparePlanningResult(p, p.thinking!.turns[0].id, result);
  assert.equal(prepared.items[0].certainty, "tentative");
  assert.match(prepared.items[0].body, /No messages in the first version/);
  assert.deepEqual(prepared.items[0].evidence, {
    turnId: p.thinking!.turns[0].id,
    quote: result.concepts[0].quote,
  });
  assert.deepEqual(p, original);
  assert.throws(
    () =>
      preparePlanningResult(p, p.thinking!.turns[0].id, {
        ...result,
        concepts: [
          { ...result.concepts[0], quote: "Send messages immediately." },
        ],
      }),
    /authored source/,
  );
  assert.throws(
    () =>
      preparePlanningResult(p, p.thinking!.turns[0].id, {
        ...result,
        concepts: [{ ...result.concepts[0], ref: crypto.randomUUID() }],
      }),
    /Unknown concept/,
  );
});

test("replacing a suggestion can retire its old version while preserving the updated concept and focus", () => {
  const p = fixture(),
    itemId = crypto.randomUUID(),
    proposalId = crypto.randomUUID();
  p.thinking!.proposals.push({
    id: proposalId,
    itemId,
    item: {
      title: "Old suggestion",
      body: "An older option",
      category: "feature",
      certainty: "tentative",
      status: "open",
      answer: "",
      links: [],
    },
    reason: "Exploration",
    turnId: p.thinking!.turns[0].id,
  });
  const result = output(p);
  result.concepts = [
    {
      ...result.concepts[0],
      ref: itemId,
      title: "Revised suggestion",
      origin: "suggestion",
      quote: "",
      sourceTurn: "",
    },
  ];
  result.dismissProposals = [proposalId];
  result.focus = itemId;
  const prepared = preparePlanningResult(p, p.thinking!.turns[0].id, result);
  assert.equal(prepared.items.length, 0);
  assert.equal(prepared.thinking.proposals.length, 1);
  assert.equal(prepared.thinking.proposals[0].item.title, "Revised suggestion");
  assert.equal(prepared.thinking.focusId, itemId);
});

test("provider reference constraints match saved concepts, proposal concepts and new thoughts", () => {
  const p = fixture();
  const seeded = preparePlanningResult(p, p.thinking!.turns[0].id, output(p));
  p.items = seeded.items;
  p.items.push({ ...p.items[0], id: crypto.randomUUID(), removed: true });
  p.thinking!.proposals = [
    {
      id: crypto.randomUUID(),
      itemId: p.items[0].id,
      item: p.items[0],
      reason: "An alternative for the existing thought",
      turnId: p.thinking!.turns[0].id,
    },
    {
      id: crypto.randomUUID(),
      itemId: crypto.randomUUID(),
      item: p.items[0],
      reason: "A separate suggestion",
      turnId: p.thinking!.turns[0].id,
    },
  ];
  const request = JSON.parse(planningRequest(p));
  const schema = z.fromJSONSchema(request.tools[0].parameters);
  const {
    sourceTurn: _source,
    quote: _quote,
    ...concept
  } = output(p).concepts[0];
  const valid = {
    ...output(p),
    concepts: [{ ...concept, evidenceRef: "a1" }],
    sourceReferences: [],
    sourceUpdates: [],
  };
  for (const ref of ["c1", "p2", "new:habitat", `new:${"a".repeat(70)}`]) {
    const update = {
      ...valid,
      concepts: [{ ...valid.concepts[0], ref }],
      focus: ref,
    };
    assert.equal(schema.safeParse(update).success, true, ref);
    assert.doesNotThrow(() =>
      preparePlanningResult(
        p,
        p.thinking!.turns[0].id,
        resolvePlanningEvidence(request, update),
      ),
    );
  }
  for (const ref of [
    "c2",
    "c999",
    "p1",
    "p3",
    "s1",
    "habitat",
    "new:Habitat",
    "new:habitat_space",
    "new:",
    `new:${"a".repeat(71)}`,
    crypto.randomUUID(),
    p.items[1].id,
  ]) {
    assert.equal(
      schema.safeParse({ ...valid, concepts: [{ ...valid.concepts[0], ref }] })
        .success,
      false,
      `Do not generate an unavailable or malformed concept ref: ${ref}`,
    );
    assert.equal(
      schema.safeParse({ ...valid, focus: ref }).success,
      false,
      ref,
    );
    assert.equal(
      schema.safeParse({
        ...valid,
        relations: [
          { from: "c1", to: ref, kind: "affects", reason: "Context" },
        ],
      }).success,
      false,
      ref,
    );
  }
  assert.equal(
    schema.safeParse({
      ...valid,
      remove: [
        {
          ref: "new:habitat",
          sourceTurn: "t1",
          quote: "Maybe a reminder later.",
        },
      ],
    }).success,
    false,
  );
  const empty = JSON.parse(planningRequest(fixture()));
  const emptySchema = z.fromJSONSchema(empty.tools[0].parameters);
  assert.equal(emptySchema.safeParse(valid).success, true);
  assert.equal(emptySchema.safeParse({ ...valid, focus: "c1" }).success, false);
  assert.equal(
    emptySchema.safeParse({
      ...valid,
      remove: [{ ref: "c1", sourceTurn: "t1", quote: "Maybe later" }],
    }).success,
    false,
  );
});

test("saved failed replies are not presented to the planner as applied Plan changes", () => {
  const p = fixture();
  p.thinking!.turns[0].status = "failed";
  p.thinking!.turns[0].reply = "Here are the remaining gaps.";
  const request = JSON.parse(planningRequest(p));
  const reply = request.input.find(
    (entry: { role: string }) => entry.role === "assistant",
  );
  assert.match(reply.content, /Here are the remaining gaps/);
  assert.match(reply.content, /Plan changes were not applied/);
});

test("the real project database preserves conversation, atomic changes, explicit adoption, undo and stale-edit protection", async () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    pid = crypto.randomUUID();
  const as = async <T>(
    who: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ) =>
    sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub',${who},true)`;
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ session_id: who, aal: "aal1" })},true)`;
      return fn(tx);
    });
  const command = async (
    c: Record<string, unknown>,
    who = owner,
  ): Promise<Project> =>
    as(
      who,
      async (tx) =>
        (
          await tx`select public.project_planning_command(${tx.json(c as postgres.JSONValue)}) p`
        )[0].p,
    ) as Promise<Project>;
  const native = async (c: unknown): Promise<Project> =>
    as(
      owner,
      async (tx) =>
        (
          await tx`select public.execute_command(${tx.json(c as postgres.JSONValue)}) p`
        )[0].p,
    ) as Promise<Project>;
  try {
    await sql`insert into auth.users(id) values(${owner}),(${other})`;
    await sql`insert into auth.sessions(id,user_id) values(${owner},${owner}),(${other},${other})`;
    let p = await native(
      makeCommand(pid, 0, {
        type: "create_project",
        name: "",
        description: "A workshop with a drop box.",
      }),
    );
    const noteId = crypto.randomUUID(),
      note = {
        id: noteId,
        action: "turn",
        projectId: pid,
        revision: p.revision,
        turnId: noteId,
        text: "Returns in the drop box still need inspection.",
        mode: "note",
        focusId: null,
      };
    p = await command(note);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].body, note.text);
    assert.deepEqual(
      await command(note),
      p,
      "lost acknowledgement is idempotent",
    );
    await assert.rejects(
      command(
        { ...note, id: crypto.randomUUID(), revision: p.revision },
        other,
      ),
      /Project not found/,
    );
    const turnId = crypto.randomUUID();
    p = await command({
      id: turnId,
      projectId: pid,
      revision: p.revision,
      action: "turn",
      turnId,
      text: "Maybe a reminder later. No messages in the first version.",
      mode: "assist",
    });
    const raw = output({
      ...p,
      thinking: { ...p.thinking!, turns: [p.thinking!.turns.at(-1)!] },
    });
    const prepared = preparePlanningResult(p, turnId, raw);
    const finish = {
      id: crypto.randomUUID(),
      projectId: pid,
      revision: p.revision,
      action: "complete",
      turnId,
      ...prepared,
    };
    p = await command(finish);
    assert.equal(p.items.length, 2);
    assert.equal(p.thinking!.turns.at(-1)!.status, "complete");
    assert.equal(p.thinking!.undo!.revision, p.revision);
    assert.deepEqual(await command(finish), p);
    assert.match(exportMarkdown(p), /Project conversation/);
    assert.match(exportMarkdown(p), /No messages in the first version/);
    p = await command({
      id: crypto.randomUUID(),
      projectId: pid,
      revision: p.revision,
      action: "undo",
    });
    assert.equal(p.items.filter((i) => !i.removed).length, 1);
    assert.equal(
      p.thinking!.turns.at(-1)!.text,
      "I undid the last project changes. Keep the earlier plan.",
    );
    const pending = crypto.randomUUID();
    p = await command({
      id: pending,
      projectId: pid,
      revision: p.revision,
      action: "turn",
      turnId: pending,
      text: "Maybe a reminder later. No messages in the first version.",
      mode: "assist",
    });
    const base = p;
    const nextRaw = output({
      ...base,
      thinking: { ...base.thinking!, turns: [base.thinking!.turns.at(-1)!] },
    });
    const next = preparePlanningResult(base, pending, nextRaw);
    p = await native(
      makeCommand(pid, p.revision, {
        type: "rename_project",
        name: "Workshop loans",
      }),
    );
    p = await command({
      id: crypto.randomUUID(),
      projectId: pid,
      revision: base.revision,
      action: "complete",
      turnId: pending,
      ...next,
    });
    assert.equal(p.name, "Workshop loans");
    assert.equal(p.items.filter((i) => !i.removed).length, 1);
    assert.equal(
      p.thinking!.turns.find((t) => t.id === pending)!.status,
      "stale",
    );
    assert.match(
      p.thinking!.turns.find((t) => t.id === pending)!.reply,
      /possibility/,
    );
    const snapshot = await as(
      owner,
      async (tx) => (await tx`select public.project_snapshot(${pid}) p`)[0].p,
    );
    assert.deepEqual(snapshot, p);
    assert.equal(
      await as(
        other,
        async (tx) => (await tx`select public.project_snapshot(${pid}) p`)[0].p,
      ),
      null,
    );
  } finally {
    await sql`delete from auth.users where id in (${owner},${other})`;
    await sql.end();
  }
});

test("discussion-only replies accept absent or stale focus without changing the Plan", () => {
  for (const focus of [null, "c999", "new:unused"]) {
    const project = fixture("Would this platform suit the project?");
    const before = structuredClone(project);
    const result = preparePlanningResult(
      project,
      project.thinking!.turns[0].id,
      {
        ...output(project),
        concepts: [],
        focus,
      },
    );
    assert.equal(result.thinking.turns[0].status, "complete");
    assert.deepEqual(result.thinking.turns[0].changedIds, []);
    assert.deepEqual(result.items, before.items);
    assert.deepEqual(result.thinking.proposals, before.thinking!.proposals);
    assert.equal(result.thinking.focusId, null);
    assert.deepEqual(project, before);
  }
});
