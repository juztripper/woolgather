import {
  emptyIdeaDocument,
  materializeIdea,
  withIdeaBlocks,
} from "../packages/domain/src/ideaDocument";
import { textBlock, blocksText } from "../packages/domain/src/ideaBlocks";
import type { Idea } from "../packages/domain/src/library";
import type {
  IdeaGuidance,
  GuidanceDisposition,
} from "../packages/domain/src/ideaGuidance";
export const evaluationVersion = "focused-review-v4-usefulness-1";
const doc = withIdeaBlocks(materializeIdea("", emptyIdeaDocument()).document, [
  textBlock(
    "cooking",
    "I was thinking on an AI cooking app that would help the user to find recipes that he may like and guide him on the cooking.",
  ),
  textBlock(
    "audience",
    "For people who never know what to eat and want to try new food out.",
    "ideaAnswer",
    { field: "audience", prompt: "Who might it be for?" },
  ),
  textBlock(
    "feedback",
    "The user choices over time and feedback over food tasted would make the algorithm more accurate and provide better options.",
    "ideaAnswer",
    { field: "purpose", prompt: "What could it make possible?" },
  ),
]);
export const cookingIdea = {
  id: "00000000-0000-4000-8000-000000000041",
  revision: 1,
  body: blocksText(doc.blocks),
  document: { ...doc, title: "Cooking App" },
} as Idea;
const resolvedDoc = withIdeaBlocks(doc, [
  ...doc.blocks,
  textBlock(
    "first-use",
    "For a new user, ask for three foods they like and ingredients they have, then suggest three recipes. They pick one and read one cooking step at a time. No voice guidance in the first version. We can test with a paper walkthrough before choosing technology.",
  ),
]);
const deferredDoc = withIdeaBlocks(doc, [
  ...doc.blocks,
  textBlock(
    "deferred",
    "I know a new user has no feedback history. Leave the initial recommendation method undecided for now; I want to explore how the cooking guidance feels. Do not ask about the initial recommendations again.",
  ),
]);
export const guidanceEvaluationCases: {
  name: string;
  idea: Idea;
  question: "ask" | "either";
  language: string;
  dispositions: GuidanceDisposition[];
}[] = [
  {
    name: "cooking-first-feedback",
    idea: cookingIdea,
    question: "ask",
    language: "en",
    dispositions: [],
  },
  {
    name: "cooking-resolved-first-use",
    idea: {
      ...cookingIdea,
      body: blocksText(resolvedDoc.blocks),
      document: resolvedDoc,
    },
    question: "either",
    language: "en",
    dispositions: [],
  },
  {
    name: "cooking-deferred-choice",
    idea: {
      ...cookingIdea,
      body: blocksText(deferredDoc.blocks),
      document: deferredDoc,
    },
    question: "either",
    language: "en",
    dispositions: [
      {
        question:
          "How should the app choose recipes before it has any feedback?",
        disposition: "dismissed",
      },
    ],
  },
];
// These checks do not grade semantic usefulness; inspect each result separately.
export function evaluateReview(
  result: IdeaGuidance,
  expected: "ask" | "either",
) {
  return {
    questionPolicyPassed: expected === "either" || !!result.question,
    findingPresent: !!result.finding,
    recognitionCount: result.recognition.length,
    hasNextStep: !!result.question || !!result.finding?.nextStep,
    semanticReview: "pending",
  };
}
