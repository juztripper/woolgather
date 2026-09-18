import type { Idea } from "../../packages/domain/src/library";
import type { Item, Project } from "../../packages/domain/src";
import {
  blocksText,
  textBlock,
  type IdeaBlock,
} from "../../packages/domain/src/ideaBlocks";
import {
  buildProjectBrief,
  emptyIdeaDocument,
  withIdeaBlocks,
} from "../../packages/domain/src/ideaDocument";
import {
  emptyThinking,
  relationKinds,
} from "../../packages/domain/src/projectPlanning";

/** Stable IDs keep a stress sample linkable across isolated review reloads. */
export const qaStressIdeaId = "00000000-0000-4000-8000-000000007201";
export const qaStressProjectId = "00000000-0000-4000-8000-000000007101";

const createdAt = "2026-09-17T10:00:00.000Z";
const stressId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ideaBlockCount = 500;
const ideaTextLength = 90_000;
const planItemCount = 320;
const planRelationCount = 360;

function boundedParagraph(index: number, length: number) {
  const prefix = `Entry ${String(index + 1).padStart(3, "0")}. `;
  const sentence =
    "The player can return to this quiet shoreline after a difficult day, carry one small observation forward, and decide whether the next step should deepen the story or remain optional. ";
  let value = prefix;
  while (value.length < length) value += sentence;
  return value.slice(0, length);
}

function ideaDocument() {
  // Two extra characters account for the 499 block separators in blocksText.
  const blocks: IdeaBlock[] = Array.from(
    { length: ideaBlockCount },
    (_, index) =>
      textBlock(
        `qa-stress-block-${String(index + 1).padStart(3, "0")}`,
        boundedParagraph(index, 178 + (index < 2 ? 1 : 0)),
      ),
  );
  const document = withIdeaBlocks(
    {
      ...emptyIdeaDocument(),
      title: "The shoreline journal",
    },
    blocks,
  );
  const body = blocksText(blocks);
  if (body.length !== ideaTextLength)
    throw new Error(`Unexpected QA stress Idea length: ${body.length}`);
  return { body, document };
}

function planItems(): Item[] {
  const categories: Item["category"][] = [
    "purpose",
    "feature",
    "constraint",
    "decision",
    "question",
    "gap",
    "note",
  ];
  return Array.from({ length: planItemCount }, (_, index) => {
    const category = categories[index % categories.length];
    return {
      id: stressId(8000 + index),
      title: `Planning thread ${String(index + 1).padStart(3, "0")}`,
      body: boundedParagraph(index, 132),
      category,
      certainty: index % 5 === 0 ? "tentative" : "stated",
      status:
        category === "question" || category === "gap"
          ? index % 4 === 0
            ? "deferred"
            : "open"
          : "open",
      answer: "",
      links: [],
      removed: false,
      source: "Written by you",
      promotedFrom: null,
    } as Item;
  });
}

function planRelations(items: Item[]) {
  return Array.from({ length: planRelationCount }, (_, index) => {
    const from = items[index % items.length];
    // The first pass is a readable chain; the remaining edges add branches
    // without creating self-links or an artificial project-root hub.
    const offset = index < items.length ? 1 : 2 + (index % 5);
    const to = items[(index + offset) % items.length];
    return {
      id: stressId(9000 + index),
      from: from.id,
      to: to.id,
      kind: relationKinds[index % relationKinds.length],
      reason: `This thread gives context for the next decision in the synthetic review path (${index + 1}).`,
    };
  });
}

export type QaStressSamples = { idea: Idea; project: Project };

/**
 * Build deterministic, synthetic boundary content for the isolated browser.
 * The Idea is deliberately below its 100,000-character/1 MB and 1,000-block
 * limits; the Plan is below its 500-concept/1,000-relation thinking limits.
 */
export function qaStressSamples(): QaStressSamples {
  const source = ideaDocument();
  const idea: Idea = {
    id: qaStressIdeaId,
    body: source.body,
    document: source.document,
    revision: 1,
    updatedAt: createdAt,
    projectId: null,
    folderId: null,
    trashed: false,
  };
  const items = planItems();
  const thinking = emptyThinking();
  thinking.relations = planRelations(items);
  const project: Project = {
    id: qaStressProjectId,
    name: "The shoreline journal · large Plan",
    description: buildProjectBrief(source.body, source.document),
    originalIdea: source.body,
    ideaDocument: structuredClone(source.document),
    folderId: null,
    revision: 1,
    updatedAt: createdAt,
    lifecycle: "active",
    references: [],
    items,
    thinking,
  };
  return { idea, project };
}

export function qaStressIdea() {
  return qaStressSamples().idea;
}

export function qaStressProject() {
  return qaStressSamples().project;
}
