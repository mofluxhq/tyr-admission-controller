/**
 * Incremental SSE usage extractor for OpenAI Responses API streams.
 *
 * Responses streams use semantic events. Final cumulative usage is carried on
 * the response object attached to lifecycle events such as
 * `response.completed`. The parser is deliberately tolerant: it observes any
 * event containing either `response.usage` or top-level `usage` with numeric
 * `input_tokens` / `output_tokens`, ignores unknown/malformed events, and never
 * changes proxied bytes.
 */
import type { UsageObservation } from "./sse.js";

function usageFrom(value: unknown): UsageObservation | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  return { input: Math.floor(input), output: Math.floor(output) };
}

export function createOpenAIResponsesSSEUsageExtractor(
  onUsage: (usage: UsageObservation) => void,
) {
  let buffer = "";
  let currentUsage: UsageObservation | undefined;

  function handleDataLine(payload: string): void {
    if (payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const event = parsed as Record<string, unknown>;
    const response = event["response"];
    const responseUsage =
      response !== null && typeof response === "object"
        ? (response as Record<string, unknown>)["usage"]
        : undefined;
    const observed = usageFrom(responseUsage) ?? usageFrom(event["usage"]);
    if (observed === undefined) return;
    currentUsage = observed;
    onUsage(observed);
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) {
          handleDataLine(line.slice(5).trim());
        }
      }
    },
    current(): UsageObservation | undefined {
      return currentUsage;
    },
  };
}
