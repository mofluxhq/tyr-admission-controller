import {
  createModelAwareTokenEstimator,
  type ContentBlock,
  type LLMMessage,
  type LLMRequest,
  type ModelAwareEstimatorOptions,
  type TokenEstimator,
} from "async-bulkhead-llm";

/**
 * Conservative minimum charged for each opaque media/document block whose
 * provider-side token cost cannot be derived from the JSON request alone.
 */
export const OPAQUE_MEDIA_INPUT_TOKENS = 2_048;

const MEDIA_BLOCK_TYPES = [
  "audio",
  "document",
  "file",
  "image",
  "image_url",
  "input_audio",
  "input_file",
  "input_image",
  "video",
] as const;

const metadataEstimator = createModelAwareTokenEstimator({ outputCap: 0 });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInlineBinary(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("file:");
}

/**
 * Produces a JSON-safe prompt value while omitting inline binary payloads.
 * Object keys are sorted to keep estimation deterministic.
 */
function normalizePromptValue(
  value: unknown,
  insideMedia = false,
  key = "",
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (
      insideMedia &&
      (key === "data" ||
        key === "bytes" ||
        key === "file_data" ||
        isInlineBinary(value))
    ) {
      return `[opaque binary omitted: ${value.length} characters]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePromptValue(item, insideMedia));
  }
  if (!isPlainObject(value)) return undefined;

  const type = typeof value["type"] === "string" ? value["type"] : undefined;
  const isMediaBlock =
    type !== undefined &&
    (MEDIA_BLOCK_TYPES as readonly string[]).includes(type);

  const normalized: Record<string, unknown> = {};
  for (const childKey of Object.keys(value).sort()) {
    const child = normalizePromptValue(
      value[childKey],
      insideMedia || isMediaBlock,
      childKey,
    );
    if (child !== undefined) normalized[childKey] = child;
  }
  return normalized;
}

function normalizeContent(value: unknown): string | ContentBlock[] {
  if (typeof value === "string") return value;
  if (value === null) return "";
  if (!Array.isArray(value)) return "";

  const blocks: ContentBlock[] = [];
  for (const block of value) {
    const normalized = normalizePromptValue(block);
    if (
      isPlainObject(normalized) &&
      typeof normalized["type"] === "string"
    ) {
      blocks.push(normalized as ContentBlock);
    }
  }
  return blocks;
}

function normalizeMessages(value: unknown): LLMMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: LLMMessage[] = [];
  for (const message of value) {
    if (!isPlainObject(message)) continue;
    messages.push({
      role: typeof message["role"] === "string" ? message["role"] : "",
      content: normalizeContent(message["content"]),
    });
  }
  return messages;
}

/**
 * Builds the portion of a provider message that the library's character-based
 * estimator cannot see: roles, tool calls, names, and opaque block payloads.
 * Text itself is intentionally removed because it is counted through the
 * first-class LLMRequest messages/system fields.
 */
function projectMessageMetadata(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((message) => {
    if (!isPlainObject(message)) return {};
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(message).sort()) {
      if (key !== "content") {
        const normalized = normalizePromptValue(message[key]);
        if (normalized !== undefined) projected[key] = normalized;
        continue;
      }

      const content = message[key];
      if (!Array.isArray(content)) continue;
      projected[key] = content.map((block) => {
        if (!isPlainObject(block)) return {};
        if (block["type"] === "text" && typeof block["text"] === "string") {
          return { type: "text" };
        }
        return normalizePromptValue(block);
      });
    }
    return projected;
  });
}

function projectSystemMetadata(value: unknown): unknown {
  if (typeof value === "string") return "";
  if (!Array.isArray(value)) return undefined;
  return value.map((block) => {
    if (!isPlainObject(block)) return {};
    if (block["type"] === "text" && typeof block["text"] === "string") {
      return { type: "text" };
    }
    return normalizePromptValue(block);
  });
}

function estimateExtraInputTokens(
  model: string,
  metadata: Record<string, unknown>,
): number {
  const serialized = JSON.stringify(metadata);
  return metadataEstimator({
    model,
    messages: [{ role: "user", content: serialized }],
    max_tokens: 0,
  }).input;
}

/**
 * Builds an async-bulkhead-llm v3.10 request using its first-class `system`,
 * `extraInputTokens`, and opaque-block estimation surfaces. Provider prompt
 * material that is not represented by message text is projected into a stable
 * metadata estimate rather than hidden on a symbol or folded into a synthetic
 * user message.
 */
export function createAdmissionRequest(opts: {
  model: string;
  maxTokens?: number;
  messages: unknown;
  system?: unknown;
  promptExtras?: Record<string, unknown>;
}): LLMRequest {
  const metadata: Record<string, unknown> = {
    messages: projectMessageMetadata(opts.messages),
  };

  if (opts.system !== undefined) {
    metadata["system"] = projectSystemMetadata(opts.system);
  }
  if (opts.promptExtras !== undefined) {
    for (const key of Object.keys(opts.promptExtras).sort()) {
      const normalized = normalizePromptValue(opts.promptExtras[key]);
      if (normalized !== undefined) metadata[key] = normalized;
    }
  }

  const request: LLMRequest = {
    model: opts.model,
    messages: normalizeMessages(opts.messages),
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.system !== undefined
      ? { system: normalizeContent(opts.system) }
      : {}),
    extraInputTokens: estimateExtraInputTokens(opts.model, metadata),
  };
  return request;
}

/**
 * Builds the model-aware estimator options shared by the static and adaptive
 * v3.10 estimators. Keeping this projection in one place guarantees that
 * previews, actual reservations, and adaptive observations use the same
 * opaque-content and output-reservation policy.
 */
export function admissionEstimatorOptions(
  defaultModel: string,
  outputCap?: number,
  opaqueMediaInputTokens = OPAQUE_MEDIA_INPUT_TOKENS,
): ModelAwareEstimatorOptions {
  const byType = Object.fromEntries(
    MEDIA_BLOCK_TYPES.map((type) => [type, opaqueMediaInputTokens]),
  );
  const options: ModelAwareEstimatorOptions = {
    defaultModel,
    ...(outputCap !== undefined ? { outputCap } : {}),
    opaqueBlockTokens: { byType },
  };
  return options;
}

/** Creates the non-adaptive estimator used when calibration is disabled. */
export function createAdmissionTokenEstimator(
  defaultModel: string,
  outputCap?: number,
  opaqueMediaInputTokens = OPAQUE_MEDIA_INPUT_TOKENS,
): TokenEstimator {
  return createModelAwareTokenEstimator(
    admissionEstimatorOptions(defaultModel, outputCap, opaqueMediaInputTokens),
  );
}
