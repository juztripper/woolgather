import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guidanceProviderSchema,
  validateGuidance,
} from "../packages/domain/src/ideaGuidance";
import { buildIdeaBrief } from "../packages/domain/src/ideaDocument";
import {
  continuationIdea,
  answerText,
} from "../scripts/guidanceContinuationEvaluation";
import { guidanceEvaluationCases } from "../scripts/guidanceIdeaBriefEvaluation";
import corpus from "./fixtures/idea-brief-results.json";

const ready = {
  outcome: "ready" as const,
  finding: null,
  question: null,
  recognition: [],
};
const vague = guidanceEvaluationCases.find(
  (sample) => sample.name === "ambiguous-companion",
)!.idea;
const clarify = {
  ...ready,
  outcome: "clarify" as const,
  question: {
    text: "What would this companion help someone do?",
    why: "This gives the project a direction to start from.",
    evidence: [
      { sourceId: "block:original-writing", quote: "a companion app" },
    ],
  },
};

test("captured idea reviews stop for clear intent and clarify an ambiguous purpose", () => {
  for (const sample of corpus.cases) {
    const before = buildIdeaBrief(
      sample.idea.body,
      sample.idea.document as any,
    );
    const result = validateGuidance(
      sample.result,
      sample.idea.body,
      sample.idea.document as any,
      sample.dispositions as any,
    );
    assert.doesNotThrow(() => guidanceProviderSchema.parse(result));
    assert.equal(result.outcome, sample.question);
    assert.equal(!!result.question, sample.question === "clarify");
    assert.ok(!result.finding?.nextStep);
    assert.equal(
      buildIdeaBrief(sample.idea.body, sample.idea.document as any),
      before,
    );
  }
});

test("idea review can stop after an answer without losing detail from the project brief", () => {
  const before = JSON.stringify(continuationIdea.document);
  assert.deepEqual(
    validateGuidance(ready, continuationIdea.body, continuationIdea.document!),
    ready,
  );
  assert.doesNotThrow(() => guidanceProviderSchema.parse(ready));
  const brief = buildIdeaBrief(
    continuationIdea.body,
    continuationIdea.document!,
  );
  assert.ok(brief.includes(answerText));
  assert.equal(JSON.stringify(continuationIdea.document), before);
});

test("idea review distinguishes clarification from a ready outcome and rejects mixed signals", () => {
  assert.deepEqual(
    validateGuidance(clarify, vague.body, vague.document!),
    clarify,
  );
  assert.doesNotThrow(() => guidanceProviderSchema.parse(clarify));
  assert.throws(
    () =>
      validateGuidance(
        { ...clarify, outcome: "ready" },
        vague.body,
        vague.document!,
      ),
    /Invalid idea review outcome/,
  );
  assert.throws(
    () =>
      validateGuidance(
        { ...ready, outcome: "clarify" },
        vague.body,
        vague.document!,
      ),
    /Invalid idea review outcome/,
  );
  assert.throws(
    () =>
      validateGuidance(
        {
          ...clarify,
          finding: {
            title: "Choose a method",
            detail: "Compare two implementations.",
            nextStep: "Run an experiment with five people.",
            evidence: clarify.question.evidence,
          },
        },
        vague.body,
        vague.document!,
      ),
    /Invalid idea review outcome/,
  );
  const { outcome: _outcome, ...legacy } = clarify;
  assert.doesNotThrow(() =>
    validateGuidance(legacy, vague.body, vague.document!),
  );
  assert.throws(() => guidanceProviderSchema.parse(legacy));
});

test("a handled clarification can be displayed again without reviving its question", () => {
  const presented = validateGuidance(clarify, vague.body, vague.document!, [
    { question: clarify.question.text, disposition: "dismissed" },
  ]);
  assert.equal(presented.question, null);
  assert.equal(
    presented.outcome,
    "clarify",
    "dismissal does not imply readiness",
  );
  assert.deepEqual(
    validateGuidance(presented, vague.body, vague.document!, [], {
      allowHandledQuestion: true,
    }),
    presented,
  );
  assert.throws(
    () => validateGuidance(presented, vague.body, vague.document!),
    /Invalid idea review outcome/,
    "a new provider review still needs a clarification question",
  );
});
