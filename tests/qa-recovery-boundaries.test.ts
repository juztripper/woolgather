import test from "node:test";
import assert from "node:assert/strict";
import { orderPendingUploads } from "../apps/web/src/projects/composerUploads";
import {
  blocksText,
  flatBlocks,
  maxIdeaDocumentBytes,
  maxIdeaText,
} from "../packages/domain/src/ideaBlocks";
import {
  buildProjectBrief,
  ideaDocumentSchema,
} from "../packages/domain/src/ideaDocument";
import type { Item } from "../packages/domain/src";
import {
  preparePlanningResult,
  projectOpeningText,
  thinkingOf,
} from "../packages/domain/src/projectPlanning";
import {
  qaStressSamples,
  qaStressProject,
} from "../scripts/fixtures/qa-stress-samples";

test("large synthetic Idea stays below document limits and keeps its bounded brief", () => {
  const { idea, project } = qaStressSamples();
  assert.equal(idea.document?.version, 2);
  if (idea.document?.version !== 2) return;
  assert.equal(flatBlocks(idea.document.blocks).length, 500);
  assert.equal(blocksText(idea.document.blocks), idea.body);
  assert.equal(idea.body.length, 90_000);
  assert(idea.body.length < maxIdeaText);
  assert(
    new TextEncoder().encode(JSON.stringify(idea.document)).length <
      maxIdeaDocumentBytes,
  );
  assert.equal(ideaDocumentSchema.safeParse(idea.document).success, true);
  assert.equal(
    project.description,
    buildProjectBrief(idea.body, idea.document),
  );
  assert(project.description.length <= 12_000);
  assert.match(project.description, /Continued in Original idea/);
});

test("large synthetic Plan keeps 320 authored thoughts and 360 typed edges without creating an opening turn", () => {
  const project = qaStressProject();
  const before = structuredClone(project);
  const thinking = thinkingOf(project);
  assert.equal(project.items.length, 320);
  assert.equal(thinking.relations.length, 360);
  const itemIds = new Set(project.items.map((item) => item.id));
  assert(
    thinking.relations.every(
      (relation) =>
        relation.from !== relation.to &&
        itemIds.has(relation.from) &&
        itemIds.has(relation.to),
    ),
  );
  assert.equal(thinking.turns.length, 0);
  assert.equal(projectOpeningText(project), project.description);
  assert.deepEqual(project, before);
});

test("the planning boundary accepts 500 thoughts and rejects the 501st atomically", () => {
  const makeItem = (index: number): Item => ({
    id: crypto.randomUUID(),
    title: `Boundary thought ${index}`,
    body: "A manual thought retained for boundary recovery.",
    category: "note",
    certainty: "stated",
    status: "open",
    answer: "",
    links: [],
    removed: false,
    source: "Written by you",
    promotedFrom: null,
  });
  const pending = (count: number) => {
    const project = qaStressProject();
    project.items = [
      ...project.items,
      ...Array.from({ length: count }, (_, index) => makeItem(index)),
    ];
    const thinking = thinkingOf(project);
    const turnId = crypto.randomUUID();
    thinking.turns.push({
      id: turnId,
      conversationId: "main",
      text: "Keep this manual boundary note.",
      reply: "",
      status: "pending",
      focusId: null,
      createdAt: "2026-09-17T10:00:00.000Z",
      changedIds: [],
    });
    return { project, turnId };
  };
  const emptyResult = {
    reply: "Your manual note remains available.",
    concepts: [],
    remove: [],
    relations: [],
    removeRelations: [],
    dismissProposals: [],
    focus: null,
    view: "outline" as const,
  };
  const atLimit = pending(180);
  assert.equal(atLimit.project.items.length, 500);
  assert.equal(
    preparePlanningResult(atLimit.project, atLimit.turnId, emptyResult).items
      .length,
    500,
  );
  const overLimit = pending(181);
  const before = structuredClone(overLimit.project);
  assert.throws(
    () =>
      preparePlanningResult(overLimit.project, overLimit.turnId, emptyResult),
    /smaller planning update/,
  );
  assert.deepEqual(overLimit.project, before);
});

test("composer upload order sorts durable positions for retry/update and gives legacy records a deterministic fallback", () => {
  const file = (id: string): File => new File([id], `${id}.txt`);
  const legacy = orderPendingUploads([
    { id: "legacy-z", file: file("legacy-z") },
    { id: "legacy-a", file: file("legacy-a") },
    { id: "legacy-m", file: file("legacy-m") },
  ]);
  assert.deepEqual(
    legacy.map((entry) => entry.id),
    ["legacy-a", "legacy-m", "legacy-z"],
  );
  const initial = orderPendingUploads([
    { id: "upload-second", file: file("upload-second"), order: 0 },
    { id: "upload-first", file: file("upload-first"), order: 1 },
  ]);
  assert.deepEqual(
    initial.map((entry) => entry.id),
    ["upload-second", "upload-first"],
  );
  assert.deepEqual(
    initial.map((entry) => entry.order),
    [0, 1],
  );
  const retried = orderPendingUploads(
    initial.map((entry) =>
      entry.id === "upload-second"
        ? { ...entry, error: "Retry this file." }
        : entry,
    ),
  );
  assert.deepEqual(
    retried.map((entry) => entry.id),
    ["upload-second", "upload-first"],
  );
  assert.equal(retried[0].error, "Retry this file.");
  const mixedLegacyAndNew = orderPendingUploads([
    { id: "new-upload", file: file("new-upload"), order: 4 },
    { id: "old-upload-z", file: file("old-upload-z") },
    { id: "old-upload-a", file: file("old-upload-a") },
  ]);
  assert.deepEqual(
    mixedLegacyAndNew.map((entry) => entry.id),
    ["old-upload-a", "old-upload-z", "new-upload"],
  );
  assert.deepEqual(
    mixedLegacyAndNew.map((entry) => entry.order),
    [0, 1, 2],
  );
});
