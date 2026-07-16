/**
 * Provider adapters: translate between each upstream's wire shape and the
 * gateway's admission/proxy pipeline. The gateway never converts between
 * shapes (e.g. it will not turn an OpenAI request into an Anthropic one) —
 * each adapter proxies verbatim to its own upstream and route, sharing only
 * the pool/bulkhead admission machinery.
 */
import type { LLMRequest, TokenUsage } from "async-bulkhead-llm";
import { createSSEUsageExtractor, type UsageObservation } from "./sse.js";
import { createOpenAISSEUsageExtractor } from "./sse-openai.js";

export type ApiShape = "anthropic" | "openai";

export type StreamExtractor = {
  push(chunk: string): void;
  current(): UsageObservation | undefined;
};

export type Adapter = {
  shape: ApiShape;
  /** Route path this adapter serves, e.g. "/v1/messages". */
  path: string;
  /** Headers forwarded verbatim to the upstream (auth passthrough — the
   * gateway holds no provider keys). */
  forwardHeaders: readonly string[];
  /** Extract the minimal admission view of the request body. */
  toLLMRequest(body: Record<string, unknown>): LLMRequest;
  /** Whether the client requested a streaming response. */
  isStreamRequested(body: Record<string, unknown>): boolean;
  /** Parse actual usage from a complete (non-streaming) JSON response body. */
  parseUsage(json: unknown): TokenUsage | undefined;
  /** Create an incremental usage extractor for a streaming response body. */
  createStreamExtractor(
    onUsage: (usage: UsageObservation) => void,
  ): StreamExtractor;
};

function toMessages(body: Record<string, unknown>): LLMRequest["messages"] {
  return Array.isArray(body["messages"])
    ? (body["messages"] as LLMRequest["messages"])
    : [];
}

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
  toLLMRequest(body) {
    const model = typeof body["model"] === "string" ? body["model"] : "";
    return {
      model,
      messages: toMessages(body),
      ...(typeof body["max_tokens"] === "number"
        ? { max_tokens: body["max_tokens"] }
        : {}),
    };
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
  toLLMRequest(body) {
    const model = typeof body["model"] === "string" ? body["model"] : "";
    // Newer OpenAI models use max_completion_tokens; older ones use
    // max_tokens. Prefer the former when both are present.
    const maxTokens =
      typeof body["max_completion_tokens"] === "number"
        ? body["max_completion_tokens"]
        : typeof body["max_tokens"] === "number"
          ? body["max_tokens"]
          : undefined;
    return {
      model,
      messages: toMessages(body),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };
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
