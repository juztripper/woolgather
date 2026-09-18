import type { Item, Project } from "../../../../packages/domain/src";
import type { IdeaBlock } from "../../../../packages/domain/src/ideaBlocks";
import { emptyThinking } from "../../../../packages/domain/src/projectPlanning";

const exampleId = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

/** One authored story across the tour; never an account or provider fixture. */
export function exampleWriting(): IdeaBlock[] {
  const block = (id: number, text: string): IdeaBlock => ({
    id: exampleId(id),
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  });
  return [
    block(
      90101,
      "A small game about wandering through the woods and keeping a field journal. I want discoveries to feel personal.",
    ),
    block(
      90102,
      "No timers. No wrong turns. Just the pleasure of noticing something you haven't seen before.",
    ),
    block(90103, "I'm still wondering what the journal should remember."),
  ];
}

export const exampleConversation = {
  title: "Finding the first few minutes",
  prompt:
    "Keep this: players choose what to remember. How can discovery feel personal?",
  reply:
    "Start with one small discovery.\n\nGive players space to follow their curiosity. The journal can hold the moments they choose to keep.",
} as const;

export function exampleProject(): Project {
  const thought = (
    n: number,
    title: string,
    body: string,
    category: Item["category"],
    certainty: Item["certainty"],
  ): Item => ({
    id: exampleId(n),
    title,
    body,
    category,
    certainty,
    status: "open",
    answer: "",
    links: [],
    removed: false,
    source: "Written for this example",
    promotedFrom: null,
  });
  const items = [
    thought(
      90201,
      "Choose what to remember",
      "Keep the moments that matter to you.",
      "feature",
      "confirmed",
    ),
    thought(
      90202,
      "No timers. No wrong turns.",
      "Space to wander, at your own pace.",
      "constraint",
      "confirmed",
    ),
    thought(
      90203,
      "Sketches, words, or both?",
      "Try sketches and words in one scene.",
      "question",
      "tentative",
    ),
  ];
  return {
    id: exampleId(90200),
    name: "Little paths",
    description: "A small game about getting happily lost.",
    revision: 1,
    updatedAt: "2026-09-17T12:00:00.000Z",
    lifecycle: "active",
    folderId: null,
    items,
    thinking: {
      ...emptyThinking(),
      relations: [
        {
          id: exampleId(90301),
          from: items[2].id,
          to: items[0].id,
          kind: "affects",
          reason: "The format shapes how players keep their discoveries.",
        },
      ],
    },
  };
}
