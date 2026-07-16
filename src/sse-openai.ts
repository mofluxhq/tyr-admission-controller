/**
 * Incremental SSE usage extractor for OpenAI chat-completions-shaped streams.
 *
 * Shape assumptions (documented OpenAI streaming format):
 *   - Each `data:` line is a `chat.completion.chunk` object.
 *   - Per-chunk `usage` is normally `null`/absent; the final chunk before
 *     `data: [DONE]` carries cumulative `usage.prompt_tokens` /
 *     `usage.completion_tokens` — but only when the caller requested it
 *     (e.g. `stream_options: { include_usage: true }`). Without that,
 *     no usage is ever reported mid-stream or at stream end, and the
 *     bulkhead falls back to the pre-admission reservation at release.
 *
 * Unlike the Anthropic extractor, there is no early/partial usage signal
 * here — usage (if present at all) only ever arrives once, on the final
 * chunk. The parser is passthrough-safe: it never modifies bytes, only
 * observes. Unknown or malformed events are ignored.
 */
import type { UsageObservation } from "./sse.js";

export function createOpenAISSEUsageExtractor(
  onUsage: (usage: UsageObservation) => void,
) {
  let buffer = "";
  let input = 0;
  let output = 0;
  let sawAny = false;

  function handleDataLine(payload: string): void {
    if (payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const evt = parsed as Record<string, unknown>;
    const usage = evt["usage"] as Record<string, unknown> | null | undefined;
    if (usage == null) return;

    const pt = usage["prompt_tokens"];
    const ct = usage["completion_tokens"];
    let changed = false;
    if (typeof pt === "number" && Number.isFinite(pt) && pt >= 0) {
      input = Math.floor(pt);
      changed = true;
    }
    if (typeof ct === "number" && Number.isFinite(ct) && ct >= 0) {
      output = Math.floor(ct);
      changed = true;
    }
    if (changed) {
      sawAny = true;
      onUsage({ input, output });
    }
  }

  return {
    /** Feed a decoded chunk. Call with every chunk, in order. */
    push(chunk: string): void {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          handleDataLine(line.slice(5).trim());
        }
      }
    },
    /** Last observed cumulative usage, or undefined if none seen. */
    current(): UsageObservation | undefined {
      return sawAny ? { input, output } : undefined;
    },
  };
}
