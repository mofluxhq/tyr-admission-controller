import {
  createModelAwareTokenEstimator,
  type LLMRequest,
  type TokenEstimator,
} from "async-bulkhead-llm";

/**
 * Conservative minimum charged for each opaque media/document block whose
 * provider-side token cost cannot be derived from the JSON request alone.
 */
export const OPAQUE_MEDIA_INPUT_TOKENS = 2_048;

const OPAQUE_INPUT_TOKENS = Symbol("tyr.opaqueInputTokens");

type AdmissionRequest = LLMRequest & {
  [OPAQUE_INPUT_TOKENS]?: number;
};

type ProjectionState = {
  opaqueInputTokens: number;
};

const MEDIA_BLOCK_TYPES = new Set([
  "audio",
  "document",
  "file",
  "image",
  "image_url",
  "input_audio",
  "input_file",
  "input_image",
  "video",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInlineBinary(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("file:");
}

/**
 * Produces a JSON-safe prompt projection while omitting inline binary payloads.
 * Media/document blocks receive a fixed token surcharge instead. Object keys
 * are sorted to keep estimates deterministic for semantically identical input.
 */
function normalizePromptValue(
  value: unknown,
  state: ProjectionState,
  insideMedia = false,
  key = "",
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (
      insideMedia &&
      (key === "data" || key === "bytes" || key === "file_data" || isInlineBinary(value))
    ) {
      return `[opaque binary omitted: ${value.length} characters]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePromptValue(item, state, insideMedia));
  }
  if (!isPlainObject(value)) return undefined;

  const type = typeof value["type"] === "string" ? value["type"] : undefined;
  const isMediaBlock = type !== undefined && MEDIA_BLOCK_TYPES.has(type);
  if (isMediaBlock) state.opaqueInputTokens += OPAQUE_MEDIA_INPUT_TOKENS;

  const normalized: Record<string, unknown> = {};
  for (const childKey of Object.keys(value).sort()) {
    const child = normalizePromptValue(
      value[childKey],
      state,
      insideMedia || isMediaBlock,
      childKey,
    );
    if (child !== undefined) normalized[childKey] = child;
  }
  return normalized;
}

export function createAdmissionRequest(opts: {
  model: string;
  maxTokens?: number;
  prompt: Record<string, unknown>;
}): LLMRequest {
  const state: ProjectionState = { opaqueInputTokens: 0 };
  const normalizedPrompt = normalizePromptValue(opts.prompt, state);
  const estimationText = JSON.stringify(normalizedPrompt ?? {});
  const request: AdmissionRequest = {
    model: opts.model,
    // The library estimator counts message content. A single normalized
    // projection avoids silently dropping system prompts, tool schemas,
    // tool-call arguments, and other provider-specific prompt material.
    messages: [{ role: "user", content: estimationText }],
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
  };
  Object.defineProperty(request, OPAQUE_INPUT_TOKENS, {
    value: state.opaqueInputTokens,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return request;
}

/**
 * Wraps async-bulkhead-llm's model-aware text estimator with the gateway's
 * conservative surcharge for opaque media/document blocks.
 */
export function createAdmissionTokenEstimator(
  defaultModel: string,
  outputCap?: number,
): TokenEstimator {
  const base = createModelAwareTokenEstimator({
    defaultModel,
    ...(outputCap !== undefined ? { outputCap } : {}),
  });

  return (request) => {
    const estimate = base(request);
    const opaqueInputTokens =
      (request as AdmissionRequest)[OPAQUE_INPUT_TOKENS] ?? 0;
    return {
      input: estimate.input + opaqueInputTokens,
      maxOutput: estimate.maxOutput,
    };
  };
}
