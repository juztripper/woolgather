import assert from "node:assert/strict";
import type { Item, Project } from "../packages/domain/src";
import { emptyThinking } from "../packages/domain/src/projectPlanning";

// Curated synthetic cases, not an account export. These test model choices as
// well as the schema/validator; prompt-string assertions cannot establish either.
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const thought = (
  n: number,
  title: string,
  body: string,
  category: Item["category"] = "feature",
): Item => ({
  id: id(n),
  title,
  body,
  category,
  certainty: "stated",
  status: "open",
  answer: "",
  links: [],
  removed: false,
  source: "From your conversation",
  promotedFrom: null,
  evidence: { turnId: id(1), quote: body },
});
function project(authored: string, reply: string, items: Item[] = []): Project {
  const thinking = emptyThinking();
  thinking.turns.push({
    id: id(1),
    text: authored,
    reply,
    status: "complete",
    focusId: null,
    changedIds: [],
    createdAt: "2026-09-17T09:00:00Z",
  });
  return {
    id: id(100),
    name: "Meadow journal",
    description: "A gentle nature exploration game with a discovery journal.",
    items,
    thinking,
    revision: 3,
    updatedAt: "2026-09-17T09:00:00Z",
  };
}
type MeaningCase = {
  project: Project;
  text: string;
  check: (project: Project) => void;
};
const active = (p: Project) => p.items.filter((i) => !i.removed);
export function planningMeaningCase(name: string): MeaningCase {
  if (name === "selection") {
    const p = project(
      "How should missing preparation be communicated?",
      "1. Display a red warning.\n2. Make the creature flee.\n3. Keep the creature calm and show an incomplete journal clue.",
      [
        thought(
          10,
          "Missing preparation feedback",
          "How should missing preparation be communicated?",
          "question",
        ),
      ],
    );
    return {
      project: p,
      text: "3 sounds the best for me, let's go for it",
      check(p) {
        const item = active(p).find((i) => i.id === id(10))!;
        assert.equal(item.category, "question");
        assert.equal(item.status, "answered");
        assert.match(item.answer, /calm/i);
        assert.match(item.answer, /clue/i);
        assert.equal(
          active(p).length,
          1,
          "Answer the existing question without a duplicate decision",
        );
        assert.equal(item.evidence?.turnId, p.thinking!.turns.at(-1)!.id);
      },
    };
  }
  if (name === "adoption") {
    const p = project(
      "The journal uses a silhouette that becomes colourful. I have not decided whether this survives losing trust.",
      "I suggest keeping the colourful journal entry after trust is lost. It records the discovery; current trust remains separate.",
    );
    const item = thought(
      10,
      "Journal progress survives trust loss",
      "Keep the colourful journal entry after trust is lost; current trust remains separate.",
      "decision",
    );
    p.thinking!.proposals.push({
      id: id(20),
      itemId: item.id,
      item: { ...item, certainty: "tentative" },
      reason: "Suggested persistence rule",
      turnId: id(1),
    });
    return {
      project: p,
      text: "Yes, let's use that persistence rule. Anything else to decide here?",
      check(p) {
        assert.equal(
          p.thinking!.proposals.some((s) => s.itemId === id(10)),
          false,
        );
        const item = active(p).find((i) => i.id === id(10));
        assert.ok(item);
        assert.equal(
          item.evidence?.turnId,
          p.thinking!.turns.at(-1)!.id,
          "Cite adoption, not the earlier visual description",
        );
        assert.match(item.body, /trust/i);
        assert.equal(item.category, "decision");
        assert.equal(
          active(p).length,
          1,
          "Do not author a generic next-step question or duplicate on adoption",
        );
      },
    };
  }
  if (name === "opinion") {
    const p = project(
      "Maybe simple voxel creatures would fit; I have not chosen the art direction.",
      "A small prototype could test their expression and readability.",
      [
        {
          ...thought(
            10,
            "Possible voxel creatures",
            "Maybe simple voxel creatures would fit; I have not chosen the art direction.",
            "decision",
          ),
          certainty: "tentative",
        },
      ],
    );
    const before = structuredClone(p.items);
    return {
      project: p,
      text: "Do you believe voxel would be a good art style for this game?",
      check(p) {
        assert.deepEqual(
          p.items,
          before,
          "An opinion question does not author the assistant's rationale or prototype requirement",
        );
      },
    };
  }
  if (name === "connections") {
    const p = project(
      "Release and the accessibility review are separate planning items. A startled creature fleeing and a calm preparation stall are different situations, not competing choices.",
      "We can record their relationships when you specify them.",
      [
        thought(10, "Release", "Release the game.", "feature"),
        thought(
          11,
          "Accessibility review",
          "Check accessibility before release.",
          "feature",
        ),
        thought(
          12,
          "Startled retreat",
          "A startled creature retreats.",
          "feature",
        ),
        thought(
          13,
          "Preparation stall",
          "An unprepared player receives a calm hint.",
          "feature",
        ),
      ],
    );
    return {
      project: p,
      text: "Release requires the accessibility review first. Connect those. The startled retreat and preparation stall coexist; don't treat them as alternatives.",
      check(p) {
        assert.ok(
          p.thinking!.relations.some(
            (r) =>
              (r.from === id(10) && r.to === id(11) && r.kind === "requires") ||
              (r.from === id(11) && r.to === id(10) && r.kind === "enables"),
          ),
        );
        assert.equal(
          p.thinking!.relations.some((r) => r.kind === "alternative_to"),
          false,
        );
      },
    };
  }
  if (name === "language") {
    const p = project(
      "Can you help me compare possible working titles?",
      "Yes. We can compare tone and meaning while treating availability as unverified.",
    );
    return {
      project: p,
      text: 'Would this reference change how we should approach naming?\n\n"Este nome já é usado por um estúdio criativo. A empresa trabalha com design e software. Existem aplicações publicadas com esse nome. Ainda não foi consultada uma base oficial de marcas. Não sabemos se há direitos exclusivos nem em que países estão protegidos."',
      check(p) {
        const reply = p.thinking!.turns.at(-1)!.reply;
        assert.match(reply, /\b(the|this|name|naming|would|should|could)\b/i);
        assert.doesNotMatch(
          reply,
          /\b(você|poderia|pesquisa|registad[oa]s?|sim|nome)\b/i,
        );
        assert.match(reply, /verif|check|confirm|unverified|not.*clear/i);
      },
    };
  }
  if (name === "trigger") {
    const p = project(
      "I have not decided what gameplay action completes a journal entry.",
      "What completes it?",
      [
        thought(
          10,
          "Journal completion trigger",
          "I have not decided what gameplay action completes a journal entry.",
          "question",
        ),
      ],
    );
    return {
      project: p,
      text: "The entry changes from a silhouette into a colourful icon! I need help with what the player actually has to do.",
      check(p) {
        const question = active(p).find((i) => i.id === id(10))!;
        assert.equal(
          question.status,
          "open",
          "Visible reward does not answer the gameplay trigger",
        );
        assert.equal(question.answer, "");
        assert.ok(
          active(p).some(
            (i) =>
              i.id !== id(10) &&
              /silhouette/i.test(i.body) &&
              /colou?r/i.test(i.body),
          ),
          "Capture the authored visual fact while leaving the gameplay trigger open",
        );
        assert.equal(
          p.thinking!.proposals.some(
            (s) => s.item.category === "question" && s.itemId !== id(10),
          ),
          false,
          "Develop the existing question rather than adding a duplicate",
        );
        assert.ok(
          !active(p).some((i) => i.certainty === "confirmed"),
          "The assistant's proposed trigger is still unchosen",
        );
      },
    };
  }
  if (name === "consolidation") {
    const body =
      "A creature stays calm when the player lacks preparation; a journal clue shows what is missing.";
    const p = project(
      body,
      "The calm hint is already saved. No new decisions are needed to recap it.",
      [thought(10, "Calm preparation hint", body, "decision")],
    );
    p.thinking!.proposals.push({
      id: id(20),
      itemId: id(21),
      item: {
        title: "Show a clue when unprepared",
        body,
        category: "decision",
        certainty: "tentative",
        status: "open",
        answer: "",
        links: [],
      },
      reason: "An old duplicate suggestion of the saved decision",
      turnId: id(1),
    });
    return {
      project: p,
      text: "Please consolidate that duplicate suggestion into the saved decision and recap it. Keep all the meaning; don't add new mechanics.",
      check(p) {
        assert.equal(active(p).length, 1);
        assert.equal(active(p)[0].id, id(10));
        assert.equal(p.thinking!.proposals.length, 0);
        assert.match(active(p)[0].body, /calm/i);
        assert.match(active(p)[0].body, /clue/i);
      },
    };
  }
  throw new Error("Unknown planning meaning case.");
}
