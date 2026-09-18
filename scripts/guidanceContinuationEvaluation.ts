import { cookingIdea, evaluateReview } from "./guidanceUsefulnessEvaluation";
import {
  materializeIdea,
  withIdeaBlocks,
} from "../packages/domain/src/ideaDocument";
import { textBlock, blocksText } from "../packages/domain/src/ideaBlocks";
export { evaluateReview };
export const evaluationVersion = "focused-review-v4.1-followup-1";
export const answeredQuestion =
  "How should the app make its first useful suggestions without any history: a short taste quiz, reactions to sample dishes, or an intentionally varied starter set?";
export const answerText =
  "I was thinking on having a nice onboarding experience which would allow the user to choose from that kind of food that everyone has already eaten and rate them. Based on the food kind and ingredients it would be able to create a first version of his taste profile.";
const base = materializeIdea(cookingIdea.body, cookingIdea.document!).document;
const doc = withIdeaBlocks(base, [
  ...base.blocks,
  textBlock("taste-profile-answer", answerText, "reviewAnswer", {
    prompt: answeredQuestion,
  }),
]);
export const continuationIdea = {
  ...cookingIdea,
  revision: 2,
  body: blocksText(doc.blocks),
  document: doc,
};
export const guidanceEvaluationCases = [
  {
    name: "familiar-food-ratings-answer",
    idea: continuationIdea,
    continuationBlockId: "taste-profile-answer",
    question: "either" as const,
    language: "en",
    dispositions: [
      { question: answeredQuestion, disposition: "kept" as const },
    ],
  },
];
