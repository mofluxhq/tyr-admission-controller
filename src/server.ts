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
  /**
   * Timeout in milliseconds for the upstream to send response headers
   * (i.e. for the `fetch()` call to resolve). Covers "upstream never
   * responds at all" — a stalled connection attempt or a hung server that
   * never sends a status line. Cancelled the moment headers arrive; it has
   * no effect on how long a streaming body may subsequently take (see
   * `idleTimeoutMs` for that). Combined with the client-disconnect abort
   * signal — whichever fires first aborts the upstream call. Omit for no
   * response timeout (client disconnect is still honored).
   */
  responseTimeoutMs?: number;
  /**
   * Timeout in milliseconds for the gap between consecutive chunks of a
   * streaming upstream response body. Guards against a stream that starts
   * fine but then stalls mid-flight (e.g. a hung upstream connection that
   * never sends more data and never closes). The timer resets on every
   * chunk received, so a healthy long-running stream that keeps sending
   * data — no matter how long the overall stream lasts — is never killed
   * by this timeout. Only applies to streaming responses. Omit for no
   * idle timeout.
   */
  idleTimeoutMs?: number;
  /**
   * Maximum number of bytes buffered from a request body before it is
   * rejected with `413`. Guards against unbounded memory growth from
   * oversized or malicious payloads. Defaults to 1 MiB (1_048_576 bytes).
   */
  maxRequestBodyBytes?: number;
  pools: PoolConfig[];
};


/** Default cap on buffered request-body bytes: 1 MiB. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

class PayloadTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`request body exceeded ${limitBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

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

// Reads the request body up to `maxBytes`. On overflow we stop buffering and
// reject with PayloadTooLargeError, but we deliberately do NOT destroy the
// socket: in HTTP/1.1 keep-alive, the request and response share the same
// underlying TCP connection, so destroying it here would prevent the 413
// response from ever reaching the client. Instead we drain (discard) the
// remainder of the incoming body so the connection stays usable for writing
// the response, and the client's request write can complete normally.
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return; // still drains via 'data' events, just discarded
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        chunks.length = 0; // release already-buffered memory immediately
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
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

// Resolves once the response's write buffer has drained below its
// highWaterMark, or once the response closes — whichever comes first.
// Resolving on 'close' prevents hanging forever if the client disconnects
// while we're waiting for backpressure to release; the caller's abort
// signal (wired to res "close") then terminates upstream reading on the
// next loop iteration.
// Exported for direct unit testing; not part of the GatewayOptions API.
export function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const onDrain = () => {
      res.removeListener("close", onClose);
      resolve();
    };
    const onClose = () => {
      res.removeListener("drain", onDrain);
      resolve();
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}


export function createGateway(opts: GatewayOptions) {
  const pools: Pools = createPools(opts.pools);
  const anthropicUpstream = opts.upstreamUrl?.replace(/\/$/, "");
  const openaiUpstream = opts.openaiUpstreamUrl?.replace(/\/$/, "");
  const responseTimeoutMs = opts.responseTimeoutMs;
  const idleTimeoutMs = opts.idleTimeoutMs;
  const maxRequestBodyBytes =
    opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;



  function makeHandler(adapter: Adapter, upstream: string) {
    return async function handle(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      let raw: Buffer;
      try {
        raw = await readBody(req, maxRequestBodyBytes);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          if (!res.headersSent) {
            res.setHeader("connection", "close");
            sendJson(res, 413, {
              error: {
                type: "payload_too_large",
                limitBytes: err.limitBytes,
              },
            });
          }
          return;
        }
        throw err;
      }
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

      // Abort upstream work if the client disconnects. Response-timeout and
      // idle-timeout are layered on top of the same controller below, so
      // whichever fires first — client disconnect, response timeout, or
      // stream stall — aborts the in-flight upstream call.
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const admissionSignal: AbortSignal = abort.signal;

      // Tracks which timeout (if any) triggered the abort, so the catch
      // block can report the right error type.
      let timeoutKind: "response" | "idle" | undefined;

      const headers: Record<string, string> = {};
      for (const h of adapter.forwardHeaders) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }

      try {
        await pool.bulkhead.run(
          llmRequest,
          async (signal, ctx) => {
            // Response timeout: bounds how long we wait for the upstream to
            // send response headers (i.e. for fetch() to resolve). Cleared
            // the instant headers arrive — it has no bearing on how long a
            // streaming body may subsequently run.
            let responseTimer: ReturnType<typeof setTimeout> | undefined;
            if (responseTimeoutMs !== undefined) {
              responseTimer = setTimeout(() => {
                timeoutKind = "response";
                abort.abort();
              }, responseTimeoutMs);
            }

            let upstreamRes: Response;
            try {
              upstreamRes = await fetch(`${upstream}${adapter.path}`, {
                method: "POST",
                headers,
                body: raw,
                ...(signal !== undefined ? { signal } : {}),
              });
            } finally {
              if (responseTimer !== undefined) clearTimeout(responseTimer);
            }

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

              // Idle timeout: bounds the gap between consecutive chunks.
              // Resets on every chunk, so a stream that keeps sending data
              // — regardless of total duration — is never killed by this.
              let idleTimer: ReturnType<typeof setTimeout> | undefined;
              const armIdleTimer = () => {
                if (idleTimeoutMs === undefined) return;
                if (idleTimer !== undefined) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                  timeoutKind = "idle";
                  abort.abort();
                }, idleTimeoutMs);
              };

              try {
                armIdleTimer();
                for await (const chunk of upstreamRes.body) {
                  armIdleTimer();
                  extractor.push(decoder.decode(chunk, { stream: true }));
                  // Backpressure: if the client's write buffer is full,
                  // pause pulling further chunks from upstream until it
                  // drains (or the response closes). Without this, a slow
                  // client reading a fast upstream stream would let Node
                  // buffer the entire response in memory unbounded.
                  if (!res.write(chunk)) {
                    await waitForDrain(res);
                  }
                }
              } finally {
                if (idleTimer !== undefined) clearTimeout(idleTimer);
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
            signal: admissionSignal,
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
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError")
        ) {
          if (timeoutKind === "response") {
            sendJson(res, 504, {
              error: {
                type: "response_timeout",
                message: `upstream did not respond within ${responseTimeoutMs}ms`,
              },
            });
            return;
          }
          if (timeoutKind === "idle") {
            sendJson(res, 504, {
              error: {
                type: "idle_timeout",
                message: `upstream stream stalled for ${idleTimeoutMs}ms`,
              },
            });
            return;
          }
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

  let shuttingDown: Promise<void> | undefined;

  /**
   * Gracefully shuts down the gateway: stops accepting new TCP
   * connections, then drains every pool's bulkhead (new requests are
   * rejected with reason "shutdown" while in-flight requests are
   * allowed to complete). Safe to call multiple times — subsequent
   * calls resolve when the first shutdown finishes.
   */
  function shutdown(): Promise<void> {
    if (shuttingDown) return shuttingDown;
    shuttingDown = new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) {
          reject(err);
          return;
        }
        pools.drain().then(resolve, reject);
      });
    });

    return shuttingDown;
  }

  return { server, pools, shutdown };
}

