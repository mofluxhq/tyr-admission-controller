/**
 * Incremental SSE usage extractor for Anthropic-messages-shaped streams.
 *
 * Shape assumptions (based on the documented Anthropic streaming format;
 * verify against the live API before production use — see README):
 *   - `message_start` event carries `message.usage.input_tokens`
 *   - `message_delta` events carry cumulative `usage.output_tokens`
 *
 * The parser is passthrough-safe: it never modifies bytes, only observes.
 * Unknown or malformed events are ignored.
 */
export type UsageObservation = {
  input: number;
  output: number;
};

export function createSSEUsageExtractor(
  onUsage: (usage: UsageObservation) => void,
) {
  let buffer = "";
  let input = 0;
  let output = 0;
  let sawAny = false;

  function handleDataLine(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const evt = parsed as Record<string, unknown>;

    if (evt["type"] === "message_start") {
      const msg = evt["message"] as Record<string, unknown> | undefined;
      const usage = msg?.["usage"] as Record<string, unknown> | undefined;
      const it = usage?.["input_tokens"];
      if (typeof it === "number" && Number.isFinite(it) && it >= 0) {
        input = Math.floor(it);
        sawAny = true;
        onUsage({ input, output });
      }
    } else if (evt["type"] === "message_delta") {
      const usage = evt["usage"] as Record<string, unknown> | undefined;
      const ot = usage?.["output_tokens"];
      if (typeof ot === "number" && Number.isFinite(ot) && ot >= 0) {
        output = Math.max(output, Math.floor(ot));
        sawAny = true;
        onUsage({ input, output });
      }
    }
  }

  return {
    /** Feed a decoded chunk. Call with every chunk, in order. */
    push(chunk: string): void {
      buffer += chunk;
      // Process complete lines; keep the trailing partial line buffered.
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
