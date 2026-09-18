import { projectPlanning } from "../../apps/api/src/projectPlanning";

export const authoredScopeInterpretation = {
  language: "en",
  intent: "authored_update",
  resolvedThoughtIds: [],
  reclassifiedThoughtIds: [],
} as const;

export const scopeFixtureCost = 36; // 30 input + 25 output tokens on Luna.
export function syntheticScopeResponse(
  body: string,
  value: unknown = { decision: "allow", reply: "" },
) {
  const request = JSON.parse(body);
  return Response.json({
    id: "resp_synthetic_scope",
    model: request.model,
    service_tier: "default",
    status: "completed",
    usage: {
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 25,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        type: "function_call",
        name: "check_project_scope",
        arguments: JSON.stringify(
          value && typeof value === "object"
            ? { planning: authoredScopeInterpretation, ...value }
            : value,
        ),
      },
    ],
  });
}

// Existing lifecycle/transport tests use a fixed allow decision so their
// scripted planner calls stay independent. Scope enforcement has its own
// handler tests using projectPlanning directly. Every check is still metered.
export const planningWithAllowedScope: typeof projectPlanning = (...args) => {
  const send =
    args[5] ||
    (async () => {
      throw new Error("Unexpected fixture provider call.");
    });
  args[5] = async (url, init) => {
    const body = init?.body as string;
    if (JSON.parse(body || "{}").tool_choice?.name === "check_project_scope")
      return syntheticScopeResponse(body);
    return send(url, init);
  };
  return projectPlanning(...args);
};
