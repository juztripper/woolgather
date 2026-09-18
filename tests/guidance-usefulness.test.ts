import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateGuidance,
  guidanceSchema,
} from "../packages/domain/src/ideaGuidance";
import { buildIdeaBrief } from "../packages/domain/src/ideaDocument";
import corpus from "./fixtures/guidance-usefulness-results.json";

test("historical usefulness replay keeps findings grounded and out of the accepted document", () => {
  for (const sample of corpus.cases) {
    const before = JSON.stringify(sample.idea.document);
    const result = validateGuidance(
      sample.result,
      sample.idea.body,
      sample.idea.document as any,
      sample.dispositions as any,
    );
    assert.doesNotThrow(() => guidanceSchema.parse(result));
    assert.ok(result.finding);
    assert.ok(result.question || result.finding.nextStep);
    assert.equal(result.recognition.length, 0);
    const brief = buildIdeaBrief(sample.idea.body, sample.idea.document as any);
    assert.ok(
      !brief.includes(result.finding.detail),
      "inference is not silently copied into project intent",
    );
    assert.equal(JSON.stringify(sample.idea.document), before);
  }
});
