import { z } from "zod";
import {
  guidanceProviderSchema,
  guidancePrompt,
  guidanceSource,
  validateGuidance,
  type IdeaGuidance,
  type GuidanceDisposition,
} from "../../../packages/domain/src/ideaGuidance";
import {
  emptyIdeaDocument,
  ideaDocumentSchema,
} from "../../../packages/domain/src/ideaDocument";
import type { Idea } from "../../../packages/domain/src/library";

// Official standard rates verified 2026-09-10; refresh before 2026-11-21.
// Units are micro-USD per token, equivalent to USD per million tokens.
export const openaiModels = {
  "gpt-5.6-luna": {
    input: 0.2,
    cached: 0.02,
    write: 0.25,
    output: 1.2,
    effort: "none",
  },
  "gpt-5.6-terra": {
    input: 2,
    cached: 0.2,
    write: 2.5,
    output: 12,
    effort: "low",
  },
  "gpt-5.6-sol": { input: 4, cached: 0.4, write: 5, output: 20, effort: "low" },
  "gpt-6-astra": {
    input: 10,
    cached: 1,
    write: 12.5,
    output: 50,
    effort: "low",
  },
} as const;
export type OpenAIModel = keyof typeof openaiModels;
export const defaultGuidanceModel: OpenAIModel = "gpt-5.6-sol";
export const isOpenAIModel = (model: string): model is OpenAIModel =>
  Object.hasOwn(openaiModels, model);
export const maxGuidanceOutputTokens = 2000;
export const guidancePriceVersion = "2026-09-11";
// Admission pins the source/schema, accounting and output-cap contract.
// Full request fingerprints also include prompt wording and model settings.
// Accounting/admission contract stays v3; the prompt revision and request
// fingerprint independently invalidate older generation results.
export const guidanceConfigVersion = "focused-review-v3";
export type GuidanceUsage = {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costMicrousd: number;
  model: OpenAIModel;
  responseId: string;
  requestId: string | null;
  serviceTier: "default" | "flex";
  latencyMs: number;
  priceVersion: string;
  responseModel: string;
  outputLimitExceeded: boolean;
};
export function providerRequest(
  idea: Idea,
  model: string,
  options: {
    tier?: "default" | "flex";
    cacheKey?: string;
    effort?: "none" | "low";
    dispositions?: GuidanceDisposition[];
    language?: string;
    maxOutputTokens?: number;
    continuationBlockId?: string;
  } = {},
) {
  if (!isOpenAIModel(model))
    throw new Error("Choose a supported OpenAI model.");
  if (model === "gpt-6-astra" && options.effort === "none")
    throw new Error("This model requires reasoning.");
  const doc = ideaDocumentSchema.parse(idea.document || emptyIdeaDocument());
  const source = guidanceSource(
    idea.body,
    doc,
    options.dispositions,
    options.language,
    options.continuationBlockId,
  );
  if (!source.passages.length)
    throw new Error("Add some writing before reviewing your idea.");
  const outputLimit = options.maxOutputTokens ?? maxGuidanceOutputTokens;
  if (!Number.isInteger(outputLimit) || outputLimit < 200 || outputLimit > 3000)
    throw new Error("Invalid review output limit.");
  const body = JSON.stringify({
    model,
    store: false,
    service_tier: options.tier || "default",
    reasoning: { effort: options.effort || openaiModels[model].effort },
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    ...(options.cacheKey ? { prompt_cache_key: options.cacheKey } : {}),
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: guidancePrompt,
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(source),
          },
        ],
      },
    ],
    max_output_tokens: outputLimit,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "idea_guidance",
        strict: true,
        schema: z.toJSONSchema(guidanceProviderSchema),
      },
    },
  });
  if (new TextEncoder().encode(body).length > 64000)
    throw new Error(
      "This idea is too long for a single review. Keep developing it manually, or move a focused section into another idea to review it.",
    );
  return body;
}
export function reservationMicrousd(body: string) {
  const request = JSON.parse(body);
  const model: string = request.model;
  if (!isOpenAIModel(model)) throw new Error("Unsupported model");
  const price = openaiModels[model];
  // Conservative visible-token byte bound plus protocol/hidden-instruction room.
  // Assume cache writes for all input, no cache discount, and the full output cap.
  // The provider hard project cap is an independent billing backstop.
  return Math.ceil(
    (new TextEncoder().encode(body).length + 4096) * price.write +
      request.max_output_tokens * price.output,
  );
}
const count = z.number().int().nonnegative().max(100000000);
const usageSchema = z.object({
  input_tokens: count,
  input_tokens_details: z.object({
    cached_tokens: count,
    cache_write_tokens: count,
  }),
  output_tokens: count,
  output_tokens_details: z
    .object({ reasoning_tokens: count.optional() })
    .optional(),
});
export function responseUsage(
  value: unknown,
  model: OpenAIModel,
  meta: {
    responseId: string;
    requestId: string | null;
    tier: "default" | "flex";
    latencyMs: number;
    responseModel?: string;
    outputLimit?: number;
  },
): GuidanceUsage {
  const u = usageSchema.parse(value),
    p = openaiModels[model];
  const cached = u.input_tokens_details.cached_tokens;
  // Modern Responses reports reads and writes separately. Missing billing
  // detail requires reconciliation; an estimate is not a settled actual cost.
  const writes = u.input_tokens_details.cache_write_tokens;
  const ordinary = u.input_tokens - cached - writes;
  if (
    ordinary < 0 ||
    (u.output_tokens_details?.reasoning_tokens || 0) > u.output_tokens
  )
    throw new Error("Invalid usage accounting");
  return {
    inputTokens: u.input_tokens,
    cachedTokens: cached,
    cacheWriteTokens: writes,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens || 0,
    costMicrousd: Math.ceil(
      (ordinary * p.input +
        cached * p.cached +
        writes * p.write +
        u.output_tokens * p.output) *
        (meta.tier === "flex" ? 0.5 : 1),
    ),
    model,
    responseId: meta.responseId,
    requestId: meta.requestId,
    serviceTier: meta.tier,
    latencyMs: meta.latencyMs,
    priceVersion: guidancePriceVersion,
    responseModel: meta.responseModel || model,
    outputLimitExceeded:
      u.output_tokens > (meta.outputLimit ?? maxGuidanceOutputTokens),
  };
}
export class GuidanceFailure extends Error {
  constructor(
    public code: string,
    public usage?: GuidanceUsage,
  ) {
    super(
      "Guidance could not be completed. Your writing is saved; continue manually or try again later.",
    );
  }
}
export async function fetchGuidance(
  body: string,
  key: string,
  idea: Idea,
  send: typeof fetch = fetch,
  project?: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    dispositions?: GuidanceDisposition[];
  } = {},
): Promise<{ result: IdeaGuidance; usage: GuidanceUsage }> {
  const request = JSON.parse(body),
    started = Date.now();
  if (!isOpenAIModel(request.model))
    throw new GuidanceFailure("unsupported_model");
  const response = await send("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(project ? { "OpenAI-Project": project } : {}),
    },
    body,
    signal: AbortSignal.any([
      AbortSignal.timeout(
        options.timeoutMs ?? (request.service_tier === "flex" ? 120000 : 40000),
      ),
      ...(options.signal ? [options.signal] : []),
    ]),
  });
  if (!response.body) throw new GuidanceFailure("empty_response");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = "",
    size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128000) {
      await reader.cancel();
      throw new GuidanceFailure("response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GuidanceFailure("invalid_json");
  }
  if (!response.ok)
    throw new GuidanceFailure(
      typeof data.error?.code === "string"
        ? data.error.code
        : `http_${response.status}`,
    );
  const tier = data.service_tier === "flex" ? "flex" : "default";
  if (data.service_tier && !["flex", "default"].includes(data.service_tier))
    throw new GuidanceFailure("unexpected_service_tier");
  let usage: GuidanceUsage;
  try {
    usage = responseUsage(data.usage, request.model, {
      responseId: data.id,
      requestId: response.headers.get("x-request-id"),
      tier,
      latencyMs: Date.now() - started,
      responseModel:
        typeof data.model === "string" ? data.model : request.model,
      outputLimit: request.max_output_tokens,
    });
  } catch {
    throw new GuidanceFailure("invalid_usage");
  }
  if (
    usage.responseModel !== request.model &&
    !usage.responseModel.startsWith(request.model + "-")
  )
    throw new GuidanceFailure("unexpected_model");
  if (usage.outputLimitExceeded)
    throw new GuidanceFailure("output_limit_exceeded", usage);
  if (data.status !== "completed")
    throw new GuidanceFailure(`response_${data.status || "unknown"}`, usage);
  if (!Array.isArray(data.output))
    throw new GuidanceFailure("invalid_guidance", usage);
  const contents = data.output
    .filter((o: { type: string }) => o.type === "message")
    .flatMap((o: { content: unknown[] }) => o.content || []);
  if (contents.some((c: { type: string }) => c.type === "refusal"))
    throw new GuidanceFailure("refusal", usage);
  const output = contents
    .filter((c: { type: string }) => c.type === "output_text")
    .map((c: { text: string }) => c.text)
    .join("");
  try {
    return {
      result: validateGuidance(
        JSON.parse(output),
        idea.body,
        idea.document || emptyIdeaDocument(),
        options.dispositions,
      ),
      usage,
    };
  } catch {
    throw new GuidanceFailure("invalid_guidance", usage);
  }
}
