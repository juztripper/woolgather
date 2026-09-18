import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Project } from "../packages/domain/src";
import { preparePlanningResult } from "../packages/domain/src/projectPlanning";
import { planningInterpretationSchema } from "../packages/domain/src/planningMeaning";
import { planningRequest } from "../apps/api/src/openaiPlanning";
import { requestEvidence } from "../apps/api/src/planningEvidence";
import { planningMeaningCase } from "../scripts/planningMeaningCases";
import captures from "../scripts/fixtures/planning-meaning.json";

for (const capture of captures)
  test(`live meaning replay: ${capture.name}`, () => {
    const project = structuredClone(capture.project) as Project;
    const interpretation = planningInterpretationSchema.parse(
      capture.interpretation,
    );
    const request = JSON.parse(
      planningRequest(
        project,
        "gpt-5.6-luna",
        "none",
        3000,
        "",
        interpretation,
      ),
    );
    const evidence = requestEvidence(request);
    const wire = {
      ...capture.result,
      concepts: capture.result.concepts.map(
        ({ sourceTurn, quote, ...concept }) => ({
          ...concept,
          evidenceRef:
            concept.origin === "author"
              ? evidence.find(
                  (entry) =>
                    entry.sourceTurn === sourceTurn && entry.quote === quote,
                )?.ref
              : null,
        }),
      ),
    };
    assert.equal(
      z.fromJSONSchema(request.tools[0].parameters).safeParse(wire).success,
      true,
      "Captured output still fits the current production schema",
    );
    const turnId = project.thinking!.turns.at(-1)!.id;
    const prepared = preparePlanningResult(project, turnId, capture.result);
    planningMeaningCase(capture.name).check({
      ...project,
      items: prepared.items,
      thinking: prepared.thinking,
    });
    assert.equal(prepared.thinking.turns.at(-1)!.status, "complete");
  });
