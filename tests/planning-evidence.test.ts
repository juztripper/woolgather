import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Project } from "../packages/domain/src";
import {
  emptyThinking,
  preparePlanningResult,
  thinkingOf,
} from "../packages/domain/src/projectPlanning";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import {
  appendToolResult,
  readConversation,
} from "../apps/api/src/planningAgents";
import {
  planningEvidence,
  requestEvidence,
  resolvePlanningEvidence,
} from "../apps/api/src/planningEvidence";

function fixture(
  text = "The journal goes from a black silhouette to a colourful icon. Maybe extra notes later.",
): Project {
  const thinking = emptyThinking();
  thinking.turns.push({
    id: crypto.randomUUID(),
    text,
    reply: "",
    status: "pending",
    focusId: null,
    changedIds: [],
    createdAt: new Date().toISOString(),
  });
  return {
    id: crypto.randomUUID(),
    name: "Journal",
    description: "",
    revision: 1,
    updatedAt: new Date().toISOString(),
    items: [],
    thinking,
  };
}
const result = (evidenceRef: string | null = "a1") => ({
  concepts: [
    {
      ref: "new:journal",
      title: "Journal reveal",
      body: "A silhouette becomes a colourful icon. Extra notes remain tentative.",
      category: "feature",
      certainty: "stated",
      status: "open",
      answer: "",
      origin: "author",
      evidenceRef,
      reason: "Preserve the authored rule and qualifier.",
    },
  ],
  remove: [],
  relations: [],
  removeRelations: [],
  dismissProposals: [],
  sourceReferences: [],
  sourceUpdates: [],
  focus: "new:journal",
  view: "map",
  reply: "The reveal is recorded; extra notes remain tentative.",
});
const schemaFor = (request: any) =>
  z.fromJSONSchema(
    request.tools.find((tool: any) => tool.name === "develop_project")
      .parameters,
  );

test("wire evidence selection attaches the original authored passage without model-authored quotes", () => {
  const project = fixture();
  const request = JSON.parse(planningRequest(project));
  const wire = result();
  assert.equal(schemaFor(request).safeParse(wire).success, true);
  const decoded = resolvePlanningEvidence(request, wire);
  const prepared = preparePlanningResult(
    project,
    thinkingOf(project).turns[0].id,
    decoded,
  );
  assert.deepEqual(prepared.items[0].evidence, {
    turnId: thinkingOf(project).turns[0].id,
    quote: thinkingOf(project).turns[0].text,
  });
  assert.equal(prepared.thinking.turns[0].status, "complete");
  assert.equal(
    project.items.length,
    0,
    "preparation remains atomic and does not mutate the saved Plan",
  );
  for (const evidenceRef of [
    null,
    "designer",
    "t1",
    "a999",
    "assistant-reply",
  ]) {
    assert.equal(
      schemaFor(request).safeParse(result(evidenceRef)).success,
      false,
    );
    assert.throws(
      () =>
        preparePlanningResult(
          project,
          thinkingOf(project).turns[0].id,
          resolvePlanningEvidence(request, result(evidenceRef)),
        ),
      /authored source/,
    );
  }
  const inventedQuote = {
    ...wire,
    concepts: [
      {
        ...wire.concepts[0],
        quote: "The author never said this",
        sourceTurn: "t1",
      },
    ],
  };
  assert.equal(
    schemaFor(request).safeParse(inventedQuote).success,
    false,
    "the model cannot supply source text alongside an evidence ID",
  );
  const suggestion = {
    ...wire,
    concepts: [
      {
        ...wire.concepts[0],
        origin: "suggestion",
        certainty: "tentative",
        evidenceRef: null,
      },
    ],
  };
  assert.equal(schemaFor(request).safeParse(suggestion).success, true);
  const suggested = preparePlanningResult(
    project,
    thinkingOf(project).turns[0].id,
    resolvePlanningEvidence(request, suggestion),
  );
  assert.equal(suggested.items.length, 0);
  assert.equal(suggested.thinking.proposals.length, 1);
});

test("generation schema enforces status and removal invariants before the save validator", () => {
  const project = fixture();
  const request = JSON.parse(planningRequest(project));
  const schema = schemaFor(request);
  for (const patch of [
    { category: "feature", status: "deferred" },
    { category: "feature", answer: "An unchosen answer" },
    { category: "question", status: "resolved", answer: "Something" },
    { category: "question", status: "answered", answer: "" },
    { category: "gap", status: "answered", answer: "Something" },
    { category: "gap", status: "resolved", answer: "   " },
  ])
    assert.equal(
      schema.safeParse({
        ...result(),
        concepts: [{ ...result().concepts[0], ...patch }],
      }).success,
      false,
      JSON.stringify(patch),
    );
  for (const patch of [
    { category: "question", status: "answered", answer: "A colourful icon" },
    { category: "gap", status: "resolved", answer: "A colourful icon" },
    { category: "feature", status: "open", answer: "" },
  ]) {
    const output = {
      ...result(),
      concepts: [{ ...result().concepts[0], ...patch }],
    };
    assert.equal(schema.safeParse(output).success, true);
    assert.doesNotThrow(() =>
      preparePlanningResult(
        project,
        thinkingOf(project).turns[0].id,
        resolvePlanningEvidence(request, output),
      ),
    );
  }
  for (const patch of [
    { dismissProposals: ["s1"] },
    { removeRelations: ["e1"] },
    { sourceReferences: [{ sourceId: crypto.randomUUID(), quote: null }] },
  ])
    assert.equal(schema.safeParse({ ...result(), ...patch }).success, false);
});

test("evidence retains Unicode, long passages and verified older sources, excluding assistant text", () => {
  const project = fixture(
    "Maybe later—not now. 🌿 Café\n" + "A long authored line. ".repeat(600),
  );
  const turns = thinkingOf(project).turns;
  turns[0].reply = "Invented assistant-only decision";
  const entries = planningEvidence(project, turns);
  assert.ok(entries.length > 1);
  assert.equal(entries.map((entry) => entry.quote).join(""), turns[0].text);
  assert.ok(entries.every((entry) => entry.quote.length <= 6000));
  assert.ok(entries.every((entry) => !entry.quote.includes("assistant-only")));
  for (const entry of entries) assert.ok(turns[0].text.includes(entry.quote));
  const request = JSON.parse(planningRequest(project));
  for (const entry of requestEvidence(request))
    assert.doesNotThrow(() =>
      preparePlanningResult(
        project,
        turns[0].id,
        resolvePlanningEvidence(request, result(entry.ref)),
      ),
    );
});

test("retrieved authored history extends evidence IDs without admitting its assistant reply", () => {
  const project = fixture();
  const thinking = thinkingOf(project);
  thinking.conversations.push({
    id: "other",
    title: "Earlier discussion",
    agentIds: [],
    archived: false,
    branch: null,
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  });
  thinking.turns.push({
    ...thinking.turns[0],
    id: crypto.randomUUID(),
    conversationId: "other",
    status: "complete",
    text: "Keep discovered knowledge when trust is lost.",
    reply: "Assistant-only theory",
  });
  const body = planningRequest(project);
  assert.equal(
    requestEvidence(JSON.parse(body)).some((entry) =>
      entry.quote.includes("Keep discovered"),
    ),
    false,
  );
  const args = { conversationId: "other", beforeTurnId: null };
  const history = readConversation(project, args);
  const request = JSON.parse(
    appendToolResult(body, "read_conversation", args, history),
  );
  const selected = requestEvidence(request).find((entry) =>
    entry.quote.startsWith("Keep discovered"),
  )!;
  assert.ok(selected);
  assert.equal(
    requestEvidence(request).some((entry) =>
      entry.quote.includes("Assistant-only"),
    ),
    false,
  );
  const wire = result(selected.ref);
  assert.equal(schemaFor(request).safeParse(wire).success, true);
  const prepared = preparePlanningResult(
    project,
    thinking.turns[0].id,
    resolvePlanningEvidence(request, wire),
  );
  assert.equal(prepared.items[0].evidence?.turnId, thinking.turns[1].id);
});

test("short corrections remain visible even when too short to serve as evidence", () => {
  const project = fixture("no");
  const request = JSON.parse(planningRequest(project));
  assert.equal(requestEvidence(request)[0].quote, "no");
  assert.equal(schemaFor(request).safeParse(result()).success, false);
  assert.equal(
    schemaFor(request).safeParse({
      ...result(),
      concepts: [
        {
          ...result().concepts[0],
          origin: "suggestion",
          certainty: "tentative",
          evidenceRef: null,
        },
      ],
    }).success,
    true,
  );
});

test("source decisions require an actual change and evidence from their active conversation", () => {
  const project = fixture(
    "Use the notes as a reference; leave their current note alone.",
  );
  const sourceId = crypto.randomUUID();
  project.sources = [
    {
      id: sourceId,
      attachmentId: crypto.randomUUID(),
      name: "Notes",
      mime: "text/plain",
      size: 10,
      note: "",
      meaning: "undecided",
      archived: false,
      createdAt: project.updatedAt,
      updatedAt: project.updatedAt,
    },
  ];
  const thinking = thinkingOf(project);
  thinking.conversations.push({
    id: "other",
    title: "Other",
    agentIds: [],
    archived: false,
    branch: null,
    createdAt: project.updatedAt,
    updatedAt: project.updatedAt,
  });
  thinking.turns.push({
    ...thinking.turns[0],
    id: crypto.randomUUID(),
    conversationId: "other",
    status: "complete",
    text: "Avoid the notes.",
    reply: "",
  });
  const body = planningRequest(project);
  const historyArgs = { conversationId: "other", beforeTurnId: null };
  const request = JSON.parse(
    appendToolResult(
      body,
      "read_conversation",
      historyArgs,
      readConversation(project, historyArgs),
    ),
  );
  const other = requestEvidence(request).find(
    (entry) => entry.quote === "Avoid the notes.",
  )!;
  const update = {
    sourceId,
    note: null,
    meaning: "use",
    origin: "author",
    evidenceRef: "a1",
  };
  const wire = { ...result(), sourceUpdates: [update] };
  assert.equal(schemaFor(request).safeParse(wire).success, true);
  const decoded = resolvePlanningEvidence(request, wire) as any;
  // Production strips wire nulls before invoking the domain schema.
  delete decoded.sourceUpdates[0].note;
  const prepared = preparePlanningResult(
    project,
    thinking.turns[0].id,
    decoded,
  );
  assert.equal(prepared.sourceUpdates[0].quote, thinking.turns[0].text);
  for (const patch of [
    { meaning: null },
    { evidenceRef: other.ref },
    { sourceId: crypto.randomUUID() },
  ])
    assert.equal(
      schemaFor(request).safeParse({
        ...wire,
        sourceUpdates: [{ ...update, ...patch }],
      }).success,
      false,
      JSON.stringify(patch),
    );
});

test("verified evidence of older saved thoughts is available, while assistant or stale evidence is not", () => {
  const project = fixture("Keep the original rule.");
  const thinking = thinkingOf(project);
  const old = {
    ...thinking.turns[0],
    id: crypto.randomUUID(),
    text: "Knowledge remains after trust is lost.",
    reply: "A trust meter is mandatory.",
    status: "complete" as const,
  };
  thinking.turns.unshift(old);
  project.items = [
    {
      id: crypto.randomUUID(),
      title: "Knowledge",
      body: "Knowledge persists",
      category: "feature",
      certainty: "stated",
      status: "open",
      answer: "",
      links: [],
      removed: false,
      promotedFrom: null,
      source: "From your conversation",
      evidence: { turnId: old.id, quote: old.text },
    },
  ];
  const entries = planningEvidence(project, [thinking.turns[1]]);
  assert.ok(
    entries.some(
      (entry) => entry.sourceTurn === old.id && entry.quote === old.text,
    ),
  );
  project.items[0].evidence!.quote = old.reply;
  assert.equal(
    planningEvidence(project, [thinking.turns[1]]).some(
      (entry) => entry.quote === old.reply,
    ),
    false,
  );
});
