import test from "node:test";
import assert from "node:assert/strict";
import { defaultComposer } from "../packages/domain/src/planningComposer";
import type { Item, Project } from "../packages/domain/src";
import {
  emptyMainConversation,
  normalizeThinking,
  purgeConversation,
  purgeSourceReferences,
} from "../packages/domain/src/projectConversations";
import {
  emptyThinking,
  type PlanningTurn,
  type ThinkingState,
} from "../packages/domain/src/projectPlanning";

const at = "2026-09-14T12:00:00.000Z";
const uuid = (ordinal: number) =>
  `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

function turn(id: string, conversationId?: string): PlanningTurn {
  return {
    ...(conversationId ? { conversationId } : {}),
    id,
    text: `Author text ${id}`,
    reply: `Reply ${id}`,
    status: "complete",
    focusId: null,
    createdAt: at,
    changedIds: [],
  };
}

function item(id: string, title: string): Item {
  return {
    id,
    title,
    body: `${title} body`,
    category: "feature",
    certainty: "stated",
    status: "open",
    answer: "",
    links: [],
    removed: false,
    source: "Written by you",
    promotedFrom: null,
  };
}

function sourceUpdate(sourceId: string, sourceTurn: string) {
  return {
    sourceId,
    meaning: "use" as const,
    sourceTurn,
    quote: `Author quote for ${sourceTurn}`,
    origin: "author" as const,
  };
}

test("normalizeThinking keeps deleted main empty and restores main only for legacy data", () => {
  const explicit = normalizeThinking({
    version: 1,
    turns: [],
    conversations: [],
    agents: [],
    relations: [],
    proposals: [],
    focusId: null,
    view: "map",
    undo: null,
  });
  assert.deepEqual(explicit.conversations, []);

  const legacy = normalizeThinking({
    version: 1,
    turns: [],
    agents: [],
    relations: [],
    proposals: [],
    focusId: null,
    view: "map",
    undo: null,
  });
  assert.equal(legacy.conversations.length, 1);
  assert.equal(legacy.conversations[0].id, "main");
});

test("purgeConversation removes chat history while preserving plan identity and safe branches", () => {
  const removedConversation = "world";
  const removedFirst = uuid(1);
  const mainBefore = uuid(2);
  const removedSecond = uuid(3);
  const mainMiddle = uuid(4);
  const mainAfter = uuid(5);
  const childTurn = uuid(6);
  const planThoughtId = uuid(20);
  const removedProposalItemId = uuid(21);
  const keptRelationItemId = uuid(22);

  const state = emptyThinking();
  state.conversations.push(
    {
      ...emptyMainConversation(at),
      id: removedConversation,
      title: "World branch",
    },
    {
      ...emptyMainConversation(at),
      id: "orphan-by-conversation",
      title: "Orphaned branch",
      branch: {
        conversationId: removedConversation,
        turnId: removedFirst,
        message: "user",
        revision: 7,
      },
    },
    {
      ...emptyMainConversation(at),
      id: "orphan-by-turn",
      title: "Another orphaned branch",
      branch: {
        conversationId: "main",
        turnId: removedSecond,
        message: "assistant",
        revision: 7,
      },
    },
    {
      ...emptyMainConversation(at),
      id: "survivor",
      title: "Surviving branch",
      branch: {
        conversationId: "main",
        turnId: mainBefore,
        message: "assistant",
        revision: 7,
      },
    },
  );

  const first = turn(mainBefore);
  const second = turn(removedFirst, removedConversation);
  const third = turn(mainMiddle);
  const fourth = turn(removedSecond, removedConversation);
  const fifth = turn(mainAfter);
  fifth.changedIds = [planThoughtId];
  fifth.composer = {
    ...defaultComposer(),
    quotes: [
      { turnId: removedFirst, text: "Remove this quote." },
      { turnId: mainBefore, text: "Keep this quote." },
    ],
  };
  fifth.sourceUpdates = [
    sourceUpdate(uuid(30), "t5"),
    sourceUpdate(uuid(30), "t2"),
    sourceUpdate(uuid(30), "brief"),
  ];
  const sixth = turn(childTurn, "orphan-by-conversation");
  sixth.sourceUpdates = [sourceUpdate(uuid(30), "t3")];
  state.turns.push(first, second, third, fourth, fifth, sixth);
  state.proposals = [
    {
      id: uuid(40),
      itemId: removedProposalItemId,
      item: {
        title: "Removed suggestion",
        body: "This came from the deleted branch.",
        category: "feature",
        certainty: "tentative",
        status: "open",
        answer: "",
        links: [],
      },
      reason: "Delete with its chat.",
      turnId: removedSecond,
    },
    {
      id: uuid(41),
      itemId: planThoughtId,
      item: {
        title: "Independent plan thought",
        body: "This remains part of the project plan.",
        category: "feature",
        certainty: "stated",
        status: "open",
        answer: "",
        links: [],
      },
      reason: "Keep this project context.",
      turnId: mainAfter,
    },
  ];
  state.relations = [
    {
      id: "removed-relation",
      from: removedProposalItemId,
      to: keptRelationItemId,
      kind: "requires",
      reason: "Removed with the suggestion.",
    },
    {
      id: "kept-relation",
      from: planThoughtId,
      to: keptRelationItemId,
      kind: "enables",
      reason: "Still part of the plan.",
    },
  ];
  state.undo = {
    revision: 7,
    turnId: removedSecond,
    items: [item(removedProposalItemId, "Undo item")],
    relations: state.relations,
    proposals: state.proposals,
  };
  const original = structuredClone(state);
  const planThought = item(planThoughtId, "Independent plan thought");
  const project: Project = {
    id: uuid(50),
    name: "A project with an independent plan",
    description: "",
    revision: 7,
    updatedAt: at,
    items: [planThought],
    thinking: state,
  };

  const purged = purgeConversation(state, removedConversation);

  assert.deepEqual(
    purged.turns.map((entry) => entry.id),
    [mainBefore, mainMiddle, mainAfter, childTurn],
    "all turns owned by the deleted conversation are gone",
  );
  assert.deepEqual(
    purged.turns.find((entry) => entry.id === mainAfter)?.sourceUpdates,
    [
      { ...sourceUpdate(uuid(30), "t5"), sourceTurn: "t3" },
      sourceUpdate(uuid(30), "brief"),
    ],
    "surviving source turn ordinals rebase and deleted ordinals disappear",
  );
  assert.deepEqual(
    purged.turns.find((entry) => entry.id === childTurn)?.sourceUpdates,
    [{ ...sourceUpdate(uuid(30), "t3"), sourceTurn: "t2" }],
  );
  assert.deepEqual(
    purged.turns.find((entry) => entry.id === mainAfter)?.composer?.quotes,
    [{ turnId: mainBefore, text: "Keep this quote." }],
  );
  assert.equal(
    purged.conversations.some((entry) => entry.id === removedConversation),
    false,
  );
  assert.equal(
    purged.conversations.find((entry) => entry.id === "orphan-by-conversation")
      ?.branch,
    null,
  );
  assert.equal(
    purged.conversations.find((entry) => entry.id === "orphan-by-turn")?.branch,
    null,
  );
  assert.deepEqual(
    purged.conversations.find((entry) => entry.id === "survivor")?.branch,
    state.conversations.find((entry) => entry.id === "survivor")?.branch,
  );
  assert.equal(
    purged.proposals.some(
      (proposal) => proposal.itemId === removedProposalItemId,
    ),
    false,
  );
  assert.equal(
    purged.proposals.find((proposal) => proposal.itemId === planThoughtId)?.item
      .title,
    "Independent plan thought",
  );
  assert.deepEqual(
    purged.relations.map((relation) => relation.id),
    ["kept-relation"],
  );
  assert.equal(purged.undo, null);
  assert.deepEqual(state, original, "the helper does not mutate saved state");
  assert.equal(
    project.items[0].id,
    planThoughtId,
    "an independent project thought remains addressable",
  );
  assert.equal(project.items[0], planThought);
});

test("purgeSourceReferences removes source context and tolerates legacy composers", () => {
  const sourceId = uuid(60);
  const retainedSourceId = uuid(61);
  const attachmentId = uuid(62);
  const retainedAttachmentId = uuid(63);
  const planThoughtId = uuid(64);
  const state = emptyThinking();
  const current = turn(uuid(65));
  current.composer = {
    ...defaultComposer(),
    sourceIds: [sourceId, retainedSourceId],
    attachments: [
      { id: attachmentId, name: "deleted.png", mime: "image/png", size: 12 },
      {
        id: retainedAttachmentId,
        name: "kept.txt",
        mime: "text/plain",
        size: 12,
      },
    ],
    references: [planThoughtId],
  };
  current.sourceReferences = [
    { sourceId, quote: "Delete this source reference." },
    { sourceId: retainedSourceId, quote: "Keep this source reference." },
  ];
  current.sourceUpdates = [
    sourceUpdate(sourceId, "t1"),
    sourceUpdate(retainedSourceId, "t1"),
  ];
  const legacy = turn(uuid(66));
  legacy.composer = {
    reasoning: "auto",
    autoCeiling: "thoughtful",
    tool: "discuss",
    references: [],
    quotes: [],
  } as unknown as PlanningTurn["composer"];
  legacy.sourceReferences = [{ sourceId, quote: "Legacy source reference." }];
  legacy.sourceUpdates = [sourceUpdate(sourceId, "t1")];
  state.turns.push(current, legacy);
  state.undo = {
    revision: 2,
    turnId: current.id,
    items: [],
    relations: [],
    proposals: [],
  };
  const original = structuredClone(state);
  const purged = purgeSourceReferences(state, sourceId, attachmentId);
  const cleaned = purged.turns.find((entry) => entry.id === current.id)!;
  const cleanedLegacy = purged.turns.find((entry) => entry.id === legacy.id)!;

  assert.deepEqual(cleaned.composer?.sourceIds, [retainedSourceId]);
  assert.deepEqual(cleaned.composer?.attachments, [
    {
      id: retainedAttachmentId,
      name: "kept.txt",
      mime: "text/plain",
      size: 12,
    },
  ]);
  assert.deepEqual(cleaned.composer?.references, [planThoughtId]);
  assert.deepEqual(cleaned.sourceReferences, [
    { sourceId: retainedSourceId, quote: "Keep this source reference." },
  ]);
  assert.deepEqual(cleaned.sourceUpdates, [
    sourceUpdate(retainedSourceId, "t1"),
  ]);
  assert.equal(
    (cleanedLegacy.composer?.sourceIds || []).includes(sourceId),
    false,
    "missing legacy sourceIds do not cause a stale ID or a throw",
  );
  assert.equal(
    (cleanedLegacy.composer?.attachments || []).some(
      (attachment) => attachment.id === attachmentId,
    ),
    false,
    "missing legacy attachments do not cause a stale file or a throw",
  );
  assert.deepEqual(cleanedLegacy.sourceReferences, []);
  assert.deepEqual(cleanedLegacy.sourceUpdates, []);
  assert.equal(purged.undo, null);
  assert.deepEqual(state, original, "the helper does not mutate saved state");
});
