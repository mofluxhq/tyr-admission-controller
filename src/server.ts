import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  LLMBulkheadRejectedError,
  type LLMRejectReason,
  type LLMRequest,
  type TokenUsage,
} from "async-bulkhead-llm";
import { createPools, parsePriority, type PoolConfig, type Pools } from "./pools.js";
import { createSSEUsageExtractor } from "./sse.js";

export type GatewayOptions = {
  /** Upstream provider base URL, e.g. "https://api.anthropic.com". */
  upstreamUrl: string;
  pools: PoolConfig[];
};

/** Headers forwarded verbatim to the upstream (auth passthrough — the
 * gateway holds no provider keys in v0). */
const FORWARD_HEADERS = [
  "content-type",
  "x-api-key",
  "authorization",
  "anthropic-version",
  "anthropic-beta",
] as const;

function rejectStatus(reason: LLMRejectReason): number {
  switch (reason) {
    case "shutdown":
      return 503;
    case "timeout":
      return 504;
    default:
      return 429; // budget_limit, concurrency_limit, queue_limit, aborted
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createGateway(opts: GatewayOptions) {
  const pools: Pools = createPools(opts.pools);
  const upstream = opts.upstreamUrl.replace(/\/$/, "");

  async function handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: { type: "invalid_json" } });
      return;
    }

    const model = typeof body["model"] === "string" ? body["model"] : "";
    const pool = pools.select(model);
    if (!pool) {
      sendJson(res, 404, {
        error: { type: "no_pool_for_model", model },
      });
      return;
    }

    // Minimal admission view of the request. Malformed messages fall back
    // to an empty list (estimator sees 0 input chars; max_tokens/outputCap
    // still reserves output).
    const llmRequest: LLMRequest = {
      model,
      messages: Array.isArray(body["messages"])
        ? (body["messages"] as LLMRequest["messages"])
        : [],
      ...(typeof body["max_tokens"] === "number"
        ? { max_tokens: body["max_tokens"] }
        : {}),
    };
    const priority = parsePriority(
      typeof req.headers["x-priority"] === "string"
        ? req.headers["x-priority"]
        : undefined,
    );
    const wantsStream = body["stream"] === true;

    // Abort upstream work if the client disconnects.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const headers: Record<string, string> = {};
    for (const h of FORWARD_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }

    try {
      await pool.bulkhead.run(
        llmRequest,
        async (signal, ctx) => {
          const upstreamRes = await fetch(`${upstream}/v1/messages`, {
            method: "POST",
            headers,
            body: raw,
            ...(signal !== undefined ? { signal } : {}),
          });

          if (wantsStream && upstreamRes.body) {
            res.writeHead(upstreamRes.status, {
              "content-type":
                upstreamRes.headers.get("content-type") ?? "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const extractor = createSSEUsageExtractor((usage) => {
              ctx?.reportUsage(usage);
            });
            const decoder = new TextDecoder();
            for await (const chunk of upstreamRes.body) {
              extractor.push(decoder.decode(chunk, { stream: true }));
              res.write(chunk);
            }
            res.end();
            // release() falls back to the last reported usage for refund.
            return { usage: extractor.current() };
          }

          const text = await upstreamRes.text();
          res.writeHead(upstreamRes.status, {
            "content-type":
              upstreamRes.headers.get("content-type") ?? "application/json",
          });
          res.end(text);

          let usage: TokenUsage | undefined;
          try {
            const parsed = JSON.parse(text) as {
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (
              typeof parsed.usage?.input_tokens === "number" &&
              typeof parsed.usage?.output_tokens === "number"
            ) {
              usage = {
                input: parsed.usage.input_tokens,
                output: parsed.usage.output_tokens,
              };
            }
          } catch {
            // non-JSON upstream response: no usage to report
          }
          return { usage };
        },
        {
          priority,
          signal: abort.signal,
          getUsage: (r) => r.usage,
        },
      );
    } catch (err) {
      if (res.headersSent) {
        // Stream already started; nothing safe to send. Terminate.
        res.destroy();
        return;
      }
      if (err instanceof LLMBulkheadRejectedError) {
        const status = rejectStatus(err.reason);
        res.setHeader("x-admission-reason", err.reason);
        sendJson(res, status, {
          error: {
            type: "admission_rejected",
            reason: err.reason,
            pool: pool.name,
            detail: err.detail ?? null,
          },
        });
        return;
      }
      sendJson(res, 502, {
        error: {
          type: "upstream_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/v1/messages") {
      void handleMessages(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (req.method === "GET" && url === "/stats") {
      sendJson(res, 200, pools.stats());
      return;
    }
    if (req.method === "GET" && url === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: { type: "not_found" } });
  });

  return { server, pools };
}
