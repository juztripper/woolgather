import { cookingIdea } from "./guidanceUsefulnessEvaluation";
import {
  continuationIdea,
  answeredQuestion,
} from "./guidanceContinuationEvaluation";
import { emptyIdeaDocument } from "../packages/domain/src/ideaDocument";
import type { Idea } from "../packages/domain/src/library";
import type {
  IdeaGuidance,
  GuidanceDisposition,
} from "../packages/domain/src/ideaGuidance";

export const evaluationVersion = "idea-brief-v5.0-boundary-1";
export const guidanceEvaluationCases: {
  name: string;
  idea: Idea;
  question: "ready" | "clarify";
  language: string;
  dispositions: GuidanceDisposition[];
  continuationBlockId?: string;
}[] = [
  {
    name: "clear-cooking-concept",
    idea: cookingIdea,
    question: "ready",
    language: "en",
    dispositions: [],
  },
  {
    name: "answered-taste-profile",
    idea: continuationIdea,
    question: "ready",
    language: "en",
    continuationBlockId: "taste-profile-answer",
    dispositions: [{ question: answeredQuestion, disposition: "kept" }],
  },
  {
    name: "ambiguous-companion",
    idea: {
      ...cookingIdea,
      body: "I want to make a companion app.",
      document: emptyIdeaDocument(),
    },
    question: "clarify",
    language: "en",
    dispositions: [],
  },
];

// Structure and the expected stopping point are measurable; inspect meaning separately.
export function evaluateReview(
  result: IdeaGuidance,
  expected: "ready" | "clarify",
) {
  return {
    outcomePassed: result.outcome === expected,
    questionPolicyPassed:
      expected === "clarify" ? !!result.question : !result.question,
    noExperiment: !result.finding?.nextStep,
    semanticReview: "pending",
  };
}
