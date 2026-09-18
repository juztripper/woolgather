import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Project } from "../packages/domain/src";
import {
  emptyThinking,
  preparePlanningResult,
  retainPlanningUndo,
  planningChangeSummary,
  type PlanningToolResult,
} from "../packages/domain/src/projectPlanning";
import { planningMeaningContext } from "../packages/domain/src/planningMeaning";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import { resolvePlanningEvidence } from "../apps/api/src/planningEvidence";

function fixture(text = "3 sounds the best for me, let's go for it"): Project {
  const thinking = emptyThinking();
  thinking.turns = [
    {
      id: crypto.randomUUID(),
      text: "How should we show an unavailable workshop tool?",
      reply:
        "1. Hide it.\n2. Show a warning.\n3. Show a calm preparation hint.",
      status: "complete",
      focusId: null,
      changedIds: [],
      createdAt: "2026-09-17T09:00:00Z",
    },
    {
      id: crypto.randomUUID(),
      text,
      reply: "",
      status: "pending",
      focusId: null,
      changedIds: [],
      createdAt: "2026-09-17T09:01:00Z",
    },
  ];
  return {
    id: crypto.randomUUID(),
    name: "Workshop",
    description: "",
    items: [],
    revision: 3,
    updatedAt: "2026-09-17T09:01:00Z",
    thinking,
  };
}
function capture(p: Project): PlanningToolResult {
  return {
    concepts: [
      {
        ref: "new:hint",
        title: "Preparation hint",
        body: "Show a calm preparation hint.",
        category: "decision",
        status: "open",
        certainty: "confirmed",
        answer: "",
        origin: "author",
        sourceTurn: p.thinking!.turns.at(-1)!.id,
        quote: p.thinking!.turns.at(-1)!.text,
        reason: "The author chose the third option.",
      },
    ],
    remove: [],
    relations: [],
    removeRelations: [],
    dismissProposals: [],
    focus: "new:hint",
    view: "outline",
    reply: "We will use the preparation hint.",
  };
}

test("numbered selection context binds one option to its actual preceding reply, including retries", () => {
  for (const text of [
    "3 sounds the best for me, let's go for it",
    "The third option please",
    "I choose option 3 please",
    "Let's go with the third option please",
  ]) {
    const p = fixture(text);
    const selected = planningMeaningContext(
      p,
      p.thinking!.turns[1],
    )?.selectedOption;
    assert.equal(selected?.number, 3);
    assert.equal(selected?.text, "Show a calm preparation hint.");
    assert.equal(selected?.evidenceTurnId, p.thinking!.turns[1].id);
    p.thinking!.turns.push({
      ...p.thinking!.turns[0],
      id: crypto.randomUUID(),
      reply: "1. A later option.\n2. Something else.\n3. Do not select this.",
    });
    assert.deepEqual(
      planningMeaningContext(p, p.thinking!.turns[1])?.selectedOption,
      selected,
    );
  }
  for (const text of [
    "3 sounds best or maybe 2",
    "not the third option",
    "All three please",
    "3 days sounds best",
    "3 sounds best, except for the hint",
    "What does option 3 mean?",
  ]) {
    const p = fixture(text);
    assert.equal(
      planningMeaningContext(p, p.thinking!.turns[1])?.selectedOption,
      undefined,
      text,
    );
  }
  const p = fixture();
  p.thinking!.turns[0].reply += "\n1. Another list.\n2. Ambiguous.";
  assert.equal(
    planningMeaningContext(p, p.thinking!.turns[1])?.selectedOption,
    undefined,
  );
});

test("foreign pasted text does not displace the author's language cue or become a selected choice", () => {
  const p = fixture(
    'Would this name work?\n\n"Uma referência portuguesa muito longa."',
  );
  assert.equal(
    planningMeaningContext(p, p.thinking!.turns[1])?.authorLanguageSamples.at(
      -1,
    ),
    "Would this name work?",
  );
  assert.equal(
    planningMeaningContext(p, p.thinking!.turns[1])?.selectedOption,
    undefined,
  );
});

test("unchanged captures preserve provenance and Undo instead of reporting phantom updates", () => {
  const p = fixture();
  const seeded = preparePlanningResult(p, p.thinking!.turns[1].id, capture(p));
  p.items = seeded.items;
  p.thinking = seeded.thinking;
  const originalEvidence = structuredClone(p.items[0].evidence);
  const originalUndo = structuredClone(p.thinking.undo);
  p.thinking.turns.push({
    ...p.thinking.turns[1],
    id: crypto.randomUUID(),
    text: "Sounds good. Please recap it.",
    reply: "",
    status: "pending",
    changedIds: [],
  });
  const raw = capture(p);
  raw.concepts[0].ref = "c1";
  raw.focus = "c1";
  const next = preparePlanningResult(p, p.thinking.turns.at(-1)!.id, raw);
  assert.deepEqual(next.items[0].evidence, originalEvidence);
  assert.deepEqual(next.thinking.undo, originalUndo);
  assert.deepEqual(next.thinking.turns.at(-1)!.changedIds, []);
  assert.deepEqual(next.items, p.items);
  assert.equal(next.thinking.turns.at(-1)!.status, "complete");
});

test("adoption consumes its proposal once; unrelated alternatives remain and malformed aliases reject atomically", () => {
  const p = fixture();
  const raw = capture(p);
  const itemId = crypto.randomUUID();
  const {
    ref: _ref,
    origin: _origin,
    sourceTurn: _source,
    quote: _quote,
    reason: _reason,
    ...item
  } = raw.concepts[0];
  p.thinking!.proposals.push({
    id: crypto.randomUUID(),
    itemId,
    item: { ...item, certainty: "tentative", links: [] },
    turnId: p.thinking!.turns[0].id,
    reason: "Possible hint",
  });
  const alternative = {
    ...structuredClone(p.thinking!.proposals[0]),
    id: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    reason: "Another possibility",
    item: {
      ...item,
      title: "A quiet sound",
      body: "Play a soft sound.",
      certainty: "tentative" as const,
      links: [],
    },
  };
  p.thinking!.proposals.push(alternative);
  raw.concepts[0].ref = "p1";
  raw.focus = "p1";
  const next = preparePlanningResult(p, p.thinking!.turns[1].id, raw);
  assert.equal(next.items[0].id, itemId);
  assert.equal(next.items[0].evidence?.turnId, p.thinking!.turns[1].id);
  assert.deepEqual(next.thinking.proposals, [alternative]);
  assert.equal(next.thinking.undo?.proposals.length, 2);
  const before = structuredClone(p);
  raw.concepts.push({ ...raw.concepts[0], ref: itemId });
  assert.throws(
    () => preparePlanningResult(p, p.thinking!.turns[1].id, raw),
    /Duplicate concept/,
  );
  assert.deepEqual(p, before);
});

test("invalid focus cannot discard valid changes; suggestion-only concepts cannot be removed as authored items", () => {
  const p = fixture();
  const raw = capture(p);
  raw.focus = "new:undeclared-display-hint";
  assert.equal(
    preparePlanningResult(p, p.thinking!.turns[1].id, raw).items.length,
    1,
  );
  const { sourceTurn: _s, quote: _q, ...concept } = raw.concepts[0];
  p.thinking!.proposals.push({
    id: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    item: {
      title: "Another option",
      body: "Maybe",
      category: "feature",
      certainty: "tentative",
      status: "open",
      answer: "",
      links: [],
    },
    turnId: p.thinking!.turns[0].id,
    reason: "An option",
  });
  const request = JSON.parse(planningRequest(p));
  const schema = z.fromJSONSchema(request.tools[0].parameters);
  const wire = {
    ...raw,
    concepts: [{ ...concept, evidenceRef: "a2" }],
    sourceReferences: [],
    sourceUpdates: [],
  };
  assert.equal(
    schema.safeParse({ ...wire, remove: [{ ref: "p1", evidenceRef: "a2" }] })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({
      ...wire,
      concepts: [
        {
          ...concept,
          origin: "suggestion",
          evidenceRef: null,
          certainty: "confirmed",
        },
      ],
    }).success,
    false,
  );
  assert.doesNotThrow(() =>
    preparePlanningResult(
      p,
      p.thinking!.turns[1].id,
      resolvePlanningEvidence(request, wire),
    ),
  );
});

test("discussion and existing adoption constrain what the provider can save", () => {
  const p = fixture("Do you think this would work?");
  const interpretation = {
    language: "en",
    intent: "discussion" as const,
    resolvedThoughtIds: [],
    reclassifiedThoughtIds: [],
  };
  const schemaFor = (overrides = {}) =>
    z.fromJSONSchema(
      JSON.parse(
        planningRequest(p, "gpt-5.6-luna", "none", 3000, "", {
          ...interpretation,
          ...overrides,
        }),
      ).tools[0].parameters,
    );
  const raw = capture(p);
  const { sourceTurn: _source, quote: _quote, ...concept } = raw.concepts[0];
  const wire = {
    ...raw,
    concepts: [{ ...concept, evidenceRef: "a2" }],
    sourceReferences: [],
    sourceUpdates: [],
  };
  assert.equal(
    schemaFor().safeParse(wire).success,
    false,
    "Advice cannot become authored meaning",
  );
  assert.equal(
    schemaFor().safeParse({
      ...wire,
      concepts: [
        {
          ...concept,
          origin: "suggestion",
          certainty: "tentative",
          evidenceRef: null,
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    schemaFor({ intent: "adopt_existing" }).safeParse(wire).success,
    false,
    "A pure adoption cannot invent a new authored next-step question",
  );
});

test("existing question identity, unresolved state and explicit recategorization are enforced together", () => {
  const p = fixture(
    "The icon turns colourful; help me decide what the player does.",
  );
  p.items = [
    {
      id: crypto.randomUUID(),
      title: "Completion trigger",
      body: "What completes a journal entry?",
      category: "question",
      certainty: "stated",
      status: "open",
      answer: "",
      links: [],
      removed: false,
      source: "From your conversation",
      promotedFrom: null,
      evidence: {
        turnId: p.thinking!.turns[0].id,
        quote: p.thinking!.turns[0].text,
      },
    },
  ];
  const interpretation = {
    language: "en",
    intent: "authored_update" as const,
    resolvedThoughtIds: [] as string[],
    reclassifiedThoughtIds: [] as string[],
  };
  const schemaFor = (overrides = {}) =>
    z.fromJSONSchema(
      JSON.parse(
        planningRequest(p, "gpt-5.6-luna", "none", 3000, "", {
          ...interpretation,
          ...overrides,
        }),
      ).tools[0].parameters,
    );
  const raw = capture(p);
  const { sourceTurn: _source, quote: _quote, ...concept } = raw.concepts[0];
  const answer = {
    ...concept,
    ref: "c1",
    category: "question",
    status: "answered",
    answer: "Observe a creature",
    evidenceRef: "a2",
  };
  const wire = {
    ...raw,
    concepts: [answer],
    focus: "c1",
    sourceReferences: [],
    sourceUpdates: [],
  };
  assert.equal(schemaFor().safeParse(wire).success, false);
  assert.equal(
    schemaFor({ resolvedThoughtIds: [p.items[0].id] }).safeParse(wire).success,
    true,
  );
  const recategorized = {
    ...wire,
    concepts: [{ ...answer, category: "decision", status: "open", answer: "" }],
  };
  assert.equal(
    schemaFor().safeParse(recategorized).success,
    false,
    "Cannot evade the unresolved question by changing its category",
  );
  assert.equal(
    schemaFor({ reclassifiedThoughtIds: [p.items[0].id] }).safeParse(
      recategorized,
    ).success,
    true,
    "The author can explicitly change category",
  );
  assert.equal(
    schemaFor().safeParse({
      ...wire,
      concepts: [
        {
          ...answer,
          ref: "new:visual",
          category: "feature",
          status: "open",
          answer: "",
        },
      ],
    }).success,
    true,
    "The stated visual fact remains capturable",
  );
});

test("duplicate cleanup cannot author housekeeping text or silently remove an authored thought", () => {
  const p = fixture("Consolidate this duplicate without changing meaning.");
  const raw = capture(p);
  const { sourceTurn: _source, quote: _quote, ...concept } = raw.concepts[0];
  p.thinking!.proposals.push({
    id: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    item: {
      title: "Duplicate",
      body: "A calm hint",
      category: "decision",
      certainty: "tentative",
      status: "open",
      answer: "",
      links: [],
    },
    turnId: p.thinking!.turns[0].id,
    reason: "Duplicate",
  });
  const schema = z.fromJSONSchema(
    JSON.parse(
      planningRequest(p, "gpt-5.6-luna", "none", 3000, "", {
        language: "en",
        intent: "prune_duplicates",
        resolvedThoughtIds: [],
        reclassifiedThoughtIds: [],
      }),
    ).tools[0].parameters,
  );
  const wire = {
    ...raw,
    concepts: [],
    dismissProposals: ["s1"],
    focus: null,
    sourceReferences: [],
    sourceUpdates: [],
  };
  assert.equal(schema.safeParse(wire).success, true);
  assert.equal(
    schema.safeParse({ ...wire, concepts: [{ ...concept, evidenceRef: "a2" }] })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...wire, remove: [{ ref: "c1", evidenceRef: "a2" }] })
      .success,
    false,
  );
});

test("discussion can keep Undo usable across bookkeeping revisions, never across changed meaning", () => {
  const p = fixture();
  const saved = preparePlanningResult(p, p.thinking!.turns[1].id, capture(p));
  const before = {
    ...p,
    items: saved.items,
    thinking: saved.thinking,
    revision: p.revision + 1,
  };
  const after = structuredClone(before.thinking);
  after.turns.push({
    ...after.turns[1],
    id: crypto.randomUUID(),
    changedIds: [],
    text: "A recap please",
  });
  const retained = retainPlanningUndo(
    before,
    before.items,
    after,
    before.revision + 4,
  )!;
  assert.equal(retained.revision, before.revision + 4);
  assert.deepEqual(retained.items, before.thinking.undo!.items);
  const edited = structuredClone(before.items);
  edited[0].body = "A concurrent manual correction.";
  assert.deepEqual(
    retainPlanningUndo(before, edited, after, before.revision + 4),
    after.undo,
  );
  assert.deepEqual(
    retainPlanningUndo(
      { ...before, revision: before.revision + 1 },
      before.items,
      after,
      before.revision + 4,
    ),
    after.undo,
  );
});

test("acknowledged change summary counts proposal retirement and graph changes without inventing thought edits", () => {
  const p = fixture();
  const raw = capture(p);
  const suggestion = {
    ...raw.concepts[0],
    origin: "suggestion" as const,
    certainty: "tentative" as const,
    sourceTurn: "",
    quote: "",
  };
  const updated = preparePlanningResult(p, p.thinking!.turns[1].id, {
    ...raw,
    concepts: [suggestion],
  });
  assert.equal(
    planningChangeSummary(
      p.thinking!,
      updated.thinking,
      p.thinking!.turns[1].id,
    ),
    "1 suggestion",
  );
  assert.equal(
    planningChangeSummary(
      updated.thinking,
      updated.thinking,
      p.thinking!.turns[1].id,
    ),
    "",
  );
  const after = structuredClone(updated.thinking);
  after.proposals = [];
  assert.equal(
    planningChangeSummary(updated.thinking, after, p.thinking!.turns[1].id),
    "1 suggestion",
  );
});
