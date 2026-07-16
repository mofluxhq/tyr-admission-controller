import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  LLMBulkheadRejectedError,
  type LLMRejectReason,
  type LLMRequest,
} from "async-bulkhead-llm";
import { createPools, parsePriority, type PoolConfig, type Pools } from "./pools.js";
import { anthropicAdapter, openaiAdapter, type Adapter } from "./adapters.js";

export type GatewayOptions = {
  /**
   * Anthropic-shaped upstream base URL, e.g. "https://api.anthropic.com".
   * Powers `POST /v1/messages`. Omit to disable that route.
   */
  upstreamUrl?: string;
  /**
   * OpenAI-shaped upstream base URL, e.g. "https://api.openai.com".
   * Powers `POST /v1/chat/completions`. Omit to disable that route.
   */
  openaiUpstreamUrl?: string;
  pools: PoolConfig[];
};

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
  const anthropicUpstream = opts.upstreamUrl?.replace(/\/$/, "");
  const openaiUpstream = opts.openaiUpstreamUrl?.replace(/\/$/, "");

  function makeHandler(adapter: Adapter, upstream: string) {
    return async function handle(
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

      // Minimal admission view of the request. Malformed messages fall
      // back to an empty list (estimator sees 0 input chars; max_tokens/
      // outputCap still reserves output).
      const llmRequest: LLMRequest = adapter.toLLMRequest(body);
      const priority = parsePriority(
        typeof req.headers["x-priority"] === "string"
          ? req.headers["x-priority"]
          : undefined,
      );
      const wantsStream = adapter.isStreamRequested(body);

      // Abort upstream work if the client disconnects.
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });

      const headers: Record<string, string> = {};
      for (const h of adapter.forwardHeaders) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }

      try {
        await pool.bulkhead.run(
          llmRequest,
          async (signal, ctx) => {
            const upstreamRes = await fetch(`${upstream}${adapter.path}`, {
              method: "POST",
              headers,
              body: raw,
              ...(signal !== undefined ? { signal } : {}),
            });

            if (wantsStream && upstreamRes.body) {
              res.writeHead(upstreamRes.status, {
                "content-type":
                  upstreamRes.headers.get("content-type") ??
                  "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              });
              const extractor = adapter.createStreamExtractor((usage) => {
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
                upstreamRes.headers.get("content-type") ??
                "application/json",
            });
            res.end(text);

            let usage;
            try {
              usage = adapter.parseUsage(JSON.parse(text));
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
    };
  }

  const handleAnthropic = anthropicUpstream
    ? makeHandler(anthropicAdapter, anthropicUpstream)
    : undefined;
  const handleOpenAI = openaiUpstream
    ? makeHandler(openaiAdapter, openaiUpstream)
    : undefined;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (req.method === "POST" && url === anthropicAdapter.path) {
      if (!handleAnthropic) {
        sendJson(res, 404, { error: { type: "route_not_configured" } });
        return;
      }
      void handleAnthropic(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (req.method === "POST" && url === openaiAdapter.path) {
      if (!handleOpenAI) {
        sendJson(res, 404, { error: { type: "route_not_configured" } });
        return;
      }
      void handleOpenAI(req, res).catch(() => {
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
