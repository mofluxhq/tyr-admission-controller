import { describe, expect, it } from "vitest";
import type { LLMRequest } from "async-bulkhead-llm";
import { anthropicAdapter, openaiAdapter } from "../src/adapters.js";
import {
  createAdmissionTokenEstimator,
  OPAQUE_MEDIA_INPUT_TOKENS,
} from "../src/admission.js";

describe("v3.11 admission projection", () => {
  it("uses first-class system/messages and strips inline media payloads", () => {
    const request = anthropicAdapter.toAdmissionRequest({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      system: "follow policy",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "data:image/png;base64,AAAA",
              },
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });

    expect(request.system).toBe("follow policy");
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "describe this" },
      {
        source: {
          data: "[opaque binary omitted: 26 characters]",
          media_type: "image/png",
          type: "base64",
        },
        type: "image",
      },
    ]);
    expect(request.extraInputTokens).toBeGreaterThan(0);
    expect(JSON.stringify(request)).not.toContain("data:image/png;base64,AAAA");
  });

  it("accounts for null-content OpenAI tool calls through extraInputTokens", () => {
    const basic = openaiAdapter.toAdmissionRequest({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const withToolCall = openaiAdapter.toAdmissionRequest({
      model: "gpt-4o",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"weather"}' },
            },
          ],
        },
      ],
    });

    expect(withToolCall.messages[1]?.content).toBe("");
    expect(withToolCall.extraInputTokens).toBeGreaterThan(
      basic.extraInputTokens ?? 0,
    );
  });

  it("uses v3.11 opaqueBlockTokens and permits an operator override", () => {
    const baseRequest: LLMRequest = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "describe this" }],
      max_tokens: 100,
    };
    const mediaRequest: LLMRequest = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", source: { type: "url", url: "https://example.test/x" } },
          ],
        },
      ],
      max_tokens: 100,
    };

    const defaultEstimator = createAdmissionTokenEstimator("claude-sonnet-4-5");
    const disabledEstimator = createAdmissionTokenEstimator(
      "claude-sonnet-4-5",
      undefined,
      0,
    );

    expect(defaultEstimator(mediaRequest).input - defaultEstimator(baseRequest).input).toBe(
      OPAQUE_MEDIA_INPUT_TOKENS,
    );
    expect(disabledEstimator(mediaRequest).input - disabledEstimator(baseRequest).input).toBe(0);
  });
});
