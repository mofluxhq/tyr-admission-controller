/**
 * Provider adapters: translate between each upstream's wire shape and the
 * gateway's admission/proxy pipeline. The gateway never converts between
 * shapes (e.g. it will not turn an OpenAI request into an Anthropic one) —
 * each adapter proxies verbatim to its own upstream and route, sharing only
 * the pool/bulkhead admission machinery.
 */
import type { LLMRequest, TokenUsage } from "async-bulkhead-llm";
import { createAdmissionRequest } from "./admission.js";
import { createSSEUsageExtractor, type UsageObservation } from "./sse.js";
import { createOpenAISSEUsageExtractor } from "./sse-openai.js";
import {
  isNonEmptyString,
  isPlainObject,
  validateMessages,
  validateOptionalBoolean,
  validateOutputLimit,
  validateStreamOptions,
  validateSystemPrompt,
  validateTools,
} from "./validation.js";

export type ApiShape = "anthropic" | "openai";

export type StreamExtractor = {
  push(chunk: string): void;
  current(): UsageObservation | undefined;
};

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] };

export type Adapter = {
  shape: ApiShape;
  /** Route path this adapter serves, e.g. "/v1/messages". */
  path: string;
  /** Headers forwarded verbatim to the upstream (auth passthrough — the
   * gateway holds no provider keys). */
  forwardHeaders: readonly string[];
  /**
   * Validates the parsed JSON body against this provider's required shape.
   * Must be called — and must return `ok: true` — before `toAdmissionRequest` /
   * `isStreamRequested` are trusted with the body; those functions assume
   * a validated shape and use defensive fallbacks only as a last resort.
   */
  validate(body: unknown, opts: { maxOutputTokens: number }): ValidationResult;
  /** Build the complete token-bearing admission projection. */
  toAdmissionRequest(body: Record<string, unknown>): LLMRequest;
  /** Whether the client requested a streaming response. */
  isStreamRequested(body: Record<string, unknown>): boolean;
  /** Parse actual usage from a complete (non-streaming) JSON response body. */
  parseUsage(json: unknown): TokenUsage | undefined;
  /** Create an incremental usage extractor for a streaming response body. */
  createStreamExtractor(
    onUsage: (usage: UsageObservation) => void,
  ): StreamExtractor;
};

function isAnthropicTool(tool: unknown): boolean {
  if (!isPlainObject(tool)) return false;
  return isNonEmptyString(tool["name"]) && isPlainObject(tool["input_schema"]);
}

function isOpenAITool(tool: unknown): boolean {
  if (!isPlainObject(tool)) return false;
  if (tool["type"] !== "function") return false;
  const fn = tool["function"];
  return isPlainObject(fn) && isNonEmptyString(fn["name"]);
}

const ANTHROPIC_ROLES = ["user", "assistant"] as const;
const OPENAI_ROLES = ["system", "user", "assistant", "tool", "function"] as const;
// OpenAI assistant turns issuing tool calls (and tool-result turns) may
// carry `content: null`.
const OPENAI_NULLABLE_CONTENT_ROLES = ["assistant", "tool", "function"] as const;

export const anthropicAdapter: Adapter = {
  shape: "anthropic",
  path: "/v1/messages",
  forwardHeaders: [
    "content-type",
    "x-api-key",
    "authorization",
    "anthropic-version",
    "anthropic-beta",
  ],
  validate(body, opts) {
    const errors: string[] = [];
    if (!isPlainObject(body)) {
      return { ok: false, errors: ["request body must be a JSON object"] };
    }
    if (!isNonEmptyString(body["model"])) {
      errors.push("model must be a non-empty string");
    }
    errors.push(
      ...validateMessages(body["messages"], { allowedRoles: ANTHROPIC_ROLES }),
    );
    // Anthropic requires max_tokens.
    if (body["max_tokens"] === undefined) {
      errors.push("max_tokens is required");
    } else {
      errors.push(
        ...validateOutputLimit(body["max_tokens"], "max_tokens", opts.maxOutputTokens),
      );
    }
    errors.push(...validateOptionalBoolean(body["stream"], "stream"));
    errors.push(...validateSystemPrompt(body["system"]));
    errors.push(...validateTools(body["tools"], isAnthropicTool));
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: body };
  },
  toAdmissionRequest(body) {
    const model = typeof body["model"] === "string" ? body["model"] : "";
    return createAdmissionRequest({
      model,
      ...(typeof body["max_tokens"] === "number"
        ? { maxTokens: body["max_tokens"] }
        : {}),
      messages: body["messages"],
      ...(body["system"] !== undefined ? { system: body["system"] } : {}),
      promptExtras: {
        tools: body["tools"],
        tool_choice: body["tool_choice"],
      },
    });
  },
  isStreamRequested(body) {
    return body["stream"] === true;
  },
  parseUsage(json) {
    if (json === null || typeof json !== "object") return undefined;
    const parsed = json as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (
      typeof parsed.usage?.input_tokens === "number" &&
      typeof parsed.usage?.output_tokens === "number"
    ) {
      return {
        input: parsed.usage.input_tokens,
        output: parsed.usage.output_tokens,
      };
    }
    return undefined;
  },
  createStreamExtractor(onUsage) {
    return createSSEUsageExtractor(onUsage);
  },
};

export const openaiAdapter: Adapter = {
  shape: "openai",
  path: "/v1/chat/completions",
  forwardHeaders: [
    "content-type",
    "authorization",
    "openai-organization",
    "openai-project",
  ],
  validate(body, opts) {
    const errors: string[] = [];
    if (!isPlainObject(body)) {
      return { ok: false, errors: ["request body must be a JSON object"] };
    }
    if (!isNonEmptyString(body["model"])) {
      errors.push("model must be a non-empty string");
    }
    errors.push(
      ...validateMessages(body["messages"], {
        allowedRoles: OPENAI_ROLES,
        nullableContentRoles: OPENAI_NULLABLE_CONTENT_ROLES,
      }),
    );
    // Both are optional in OpenAI's API; validate bounds when present.
    errors.push(
      ...validateOutputLimit(body["max_tokens"], "max_tokens", opts.maxOutputTokens),
    );
    errors.push(
      ...validateOutputLimit(
        body["max_completion_tokens"],
        "max_completion_tokens",
        opts.maxOutputTokens,
      ),
    );
    errors.push(...validateOptionalBoolean(body["stream"], "stream"));
    errors.push(...validateStreamOptions(body["stream_options"]));
    errors.push(...validateTools(body["tools"], isOpenAITool));
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: body };
  },
  toAdmissionRequest(body) {
    const model = typeof body["model"] === "string" ? body["model"] : "";
    // Newer OpenAI models use max_completion_tokens; older ones use
    // max_tokens. Prefer the former when both are present.
    const maxTokens =
      typeof body["max_completion_tokens"] === "number"
        ? body["max_completion_tokens"]
        : typeof body["max_tokens"] === "number"
          ? body["max_tokens"]
          : undefined;
    return createAdmissionRequest({
      model,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      messages: body["messages"],
      promptExtras: {
        tools: body["tools"],
        tool_choice: body["tool_choice"],
        functions: body["functions"],
        function_call: body["function_call"],
        response_format: body["response_format"],
        prediction: body["prediction"],
      },
    });
  },
  isStreamRequested(body) {
    return body["stream"] === true;
  },
  parseUsage(json) {
    if (json === null || typeof json !== "object") return undefined;
    const parsed = json as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (
      typeof parsed.usage?.prompt_tokens === "number" &&
      typeof parsed.usage?.completion_tokens === "number"
    ) {
      return {
        input: parsed.usage.prompt_tokens,
        output: parsed.usage.completion_tokens,
      };
    }
    return undefined;
  },
  createStreamExtractor(onUsage) {
    return createOpenAISSEUsageExtractor(onUsage);
  },
};
