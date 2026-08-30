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
import { createOpenAIResponsesSSEUsageExtractor } from "./sse-responses.js";
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

function isOpenAIResponsesTool(tool: unknown): boolean {
  if (!isPlainObject(tool) || !isNonEmptyString(tool["type"])) return false;
  // Tyr 0.29 supports request-visible tool definitions only. Provider-managed
  // retrieval/computer tools can inject input tokens that are not observable
  // at admission time and are rejected below rather than under-reserved.
  if (tool["type"] !== "function" && tool["type"] !== "custom") return false;
  return isNonEmptyString(tool["name"]);
}

const OPENAI_RESPONSES_ROLES = [
  "user",
  "assistant",
  "system",
  "developer",
] as const;

function validateResponsesContent(value: unknown, fieldName: string): string[] {
  if (typeof value === "string") return [];
  if (!Array.isArray(value)) {
    return [`${fieldName} must be a string or an array of content blocks`];
  }
  const errors: string[] = [];
  value.forEach((block, index) => {
    if (!isPlainObject(block) || !isNonEmptyString(block["type"])) {
      errors.push(`${fieldName}[${index}] must be an object with a non-empty type`);
      return;
    }
    if (
      (block["type"] === "input_text" || block["type"] === "text") &&
      typeof block["text"] !== "string"
    ) {
      errors.push(`${fieldName}[${index}].text must be a string`);
    }
  });
  return errors;
}

function validateResponsesInput(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [];
  if (!Array.isArray(value)) {
    return ["input must be a string or an array of response input items"];
  }
  const errors: string[] = [];
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`input[${index}] must be an object`);
      return;
    }
    if (item["type"] === "item_reference") {
      errors.push(
        `input[${index}] item_reference is not supported because referenced prompt tokens are hidden at admission time`,
      );
      return;
    }
    const role = item["role"];
    const isMessage = role !== undefined || item["type"] === "message";
    if (isMessage) {
      if (
        typeof role !== "string" ||
        !OPENAI_RESPONSES_ROLES.includes(
          role as (typeof OPENAI_RESPONSES_ROLES)[number],
        )
      ) {
        errors.push(
          `input[${index}].role must be one of ${OPENAI_RESPONSES_ROLES.join(", ")}`,
        );
      }
      errors.push(...validateResponsesContent(item["content"], `input[${index}].content`));
      return;
    }
    if (!isNonEmptyString(item["type"])) {
      errors.push(`input[${index}].type must be a non-empty string`);
    }
  });
  return errors;
}

function responsesContentForAdmission(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isPlainObject(block)) return block;
    if (block["type"] === "input_text" && typeof block["text"] === "string") {
      return { ...block, type: "text" };
    }
    return block;
  });
}

function projectResponsesInput(value: unknown): {
  messages: unknown[];
  extraItems: unknown[];
  messageMetadata: unknown[];
} {
  if (typeof value === "string") {
    return {
      messages: [{ role: "user", content: value }],
      extraItems: [],
      messageMetadata: [],
    };
  }
  if (!Array.isArray(value)) {
    return { messages: [], extraItems: [], messageMetadata: [] };
  }

  const messages: unknown[] = [];
  const extraItems: unknown[] = [];
  const messageMetadata: unknown[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    if (typeof item["role"] === "string" || item["type"] === "message") {
      messages.push({
        role: typeof item["role"] === "string" ? item["role"] : "",
        content: responsesContentForAdmission(item["content"]),
      });
      const metadata: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        if (key !== "role" && key !== "content") metadata[key] = child;
      }
      if (Object.keys(metadata).length > 0) messageMetadata.push(metadata);
    } else {
      extraItems.push(item);
    }
  }
  return { messages, extraItems, messageMetadata };
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

export const openaiResponsesAdapter: Adapter = {
  shape: "openai",
  path: "/v1/responses",
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
    errors.push(...validateResponsesInput(body["input"]));
    if (body["instructions"] !== undefined && typeof body["instructions"] !== "string") {
      errors.push("instructions must be a string");
    }
    errors.push(
      ...validateOutputLimit(
        body["max_output_tokens"],
        "max_output_tokens",
        opts.maxOutputTokens,
      ),
    );
    errors.push(...validateOptionalBoolean(body["stream"], "stream"));
    errors.push(...validateOptionalBoolean(body["background"], "background"));
    if (body["background"] === true) {
      errors.push(
        "background=true is not supported because provider execution continues after the HTTP response and cannot retain a bounded admission reservation",
      );
    }
    if (body["previous_response_id"] !== undefined) {
      errors.push(
        "previous_response_id is not supported because prior response tokens are hidden at admission time",
      );
    }
    if (body["conversation"] !== undefined) {
      errors.push(
        "conversation is not supported because server-side conversation tokens are hidden at admission time",
      );
    }
    if (body["prompt"] !== undefined) {
      errors.push(
        "stored prompt templates are not supported because template tokens are hidden at admission time",
      );
    }
    if (body["tools"] !== undefined) {
      if (!Array.isArray(body["tools"])) {
        errors.push("tools must be an array");
      } else {
        body["tools"].forEach((tool, index) => {
          if (!isOpenAIResponsesTool(tool)) {
            errors.push(
              `tools[${index}] must be a request-visible function or custom tool`,
            );
          }
        });
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: body };
  },
  toAdmissionRequest(body) {
    const model = typeof body["model"] === "string" ? body["model"] : "";
    const projected = projectResponsesInput(body["input"]);
    return createAdmissionRequest({
      model,
      ...(typeof body["max_output_tokens"] === "number"
        ? { maxTokens: body["max_output_tokens"] }
        : {}),
      messages: projected.messages,
      ...(typeof body["instructions"] === "string"
        ? { system: body["instructions"] }
        : {}),
      promptExtras: {
        ...(projected.extraItems.length > 0
          ? { response_input_items: projected.extraItems }
          : {}),
        ...(projected.messageMetadata.length > 0
          ? { response_input_message_metadata: projected.messageMetadata }
          : {}),
        tools: body["tools"],
        tool_choice: body["tool_choice"],
        text: body["text"],
        reasoning: body["reasoning"],
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
    return createOpenAIResponsesSSEUsageExtractor(onUsage);
  },
};
