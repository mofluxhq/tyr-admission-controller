import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  LLMBulkheadRejectedError,
  type LLMRejectReason,
  type LLMPriority,
} from "async-bulkhead-llm";
import {
  createPools,
  parsePriority,
  type AdmissionProvenance,
  type PoolConfig,
  type PoolLimitsUpdate,
  type PoolsApplyLimitsResult,
  type PoolsDrainResult,
  type TyrPoolStats,
} from "./pools.js";
import type { LLMAdmissionLimits } from "async-bulkhead-llm";
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
   * Timeout in milliseconds bounding how long the gateway will wait for a
   * backpressured client to drain before giving up on it. Guards against a
   * client that stops reading entirely (TCP connection stays open, but no
   * `drain` and no `close` ever fires) — without this bound, the handler
   * parks in `waitForDrain` forever, pinning its bulkhead slot and token
   * budget reservation indefinitely. On timeout, the response socket is
   * destroyed, which cascades through `close` to unwind the handler and
   * release its admission hold. Defaults to `idleTimeoutMs` when omitted;
   * if both are omitted, a stalled client is never bounded (matching prior
   * behavior).
   */
  clientStallTimeoutMs?: number;
  /**
   * Maximum number of bytes buffered from a request body before it is
   * rejected with `413`. Guards against unbounded memory growth from
   * oversized or malicious payloads. Defaults to 1 MiB (1_048_576 bytes).
   */
  maxRequestBodyBytes?: number;
  /**
   * Ceiling for output-limit fields (`max_tokens` / `max_completion_tokens`).
   * Requests specifying a value above this are rejected with `400` before
   * admission. This is a sanity bound against malformed/malicious input,
   * not a business policy — actual per-pool output reservation defaults
   * are controlled by `PoolConfig.outputCap`. Defaults to 200,000.
   */
  maxOutputTokens?: number;
  /**
   * Maximum graceful-drain wait during shutdown. When the deadline expires,
   * Tyr reports outstanding work and closes remaining HTTP connections.
   * Omit for the previous unbounded drain behavior.
   */
  shutdownDrainTimeoutMs?: number;
  /**
   * Resolve admission priority from an authenticated/trusted request context.
   * This is the preferred way to grant high-priority capacity.
   */
  resolvePriority?: (
    req: IncomingMessage,
  ) => LLMPriority | Promise<LLMPriority>;
  /**
   * Trust the raw client-supplied `x-priority` header. Disabled by default
   * because an unauthenticated caller could otherwise self-assign the
   * reserved high-priority tier. Enable only behind a trusted proxy that
   * strips client copies and injects the header itself.
   */
  trustPriorityHeader?: boolean;
  pools: PoolConfig[];
};

/**
 * Narrow runtime surface intended for an embedded or remote control-plane
 * agent. Request forwarding remains encapsulated inside the gateway.
 */
export type TyrControlPlane = {
  /** Current per-pool admission snapshots. */
  limits(): Record<string, LLMAdmissionLimits>;
  /** Current operational statistics, including the applied limits revision. */
  stats(): Record<string, TyrPoolStats>;
  /**
   * Apply complete higher-revision snapshots as one Tyr-local transaction.
   * Preflight failure leaves every pool unchanged.
   */
  applyLimits(updates: readonly PoolLimitsUpdate[]): PoolsApplyLimitsResult;
};



/** Default cap on buffered request-body bytes: 1 MiB. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

/** Default ceiling for output-limit fields (max_tokens / max_completion_tokens). */
const DEFAULT_MAX_OUTPUT_TOKENS = 200_000;


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

/**
 * Emits grant-attribution headers under both the legacy `x-korrx-*` names and
 * the current `x-latchflo-*` names.
 *
 * Both pairs carry identical values. Emitting both lets downstream consumers
 * migrate on their own schedule instead of being cut over in lockstep with a
 * Tyr deploy. Drop the `x-korrx-*` pair only once no consumer reads it.
 */
function setGrantProvenanceHeaders(
  res: ServerResponse,
  provenance: AdmissionProvenance | undefined,
): void {
  if (provenance === undefined) return;
  const epoch = String(provenance.controllerEpoch);
  res.setHeader("x-latchflo-grant-id", provenance.grantId);
  res.setHeader("x-latchflo-controller-epoch", epoch);
  // Deprecated aliases, retained for the Latchflo rebrand transition.
  res.setHeader("x-korrx-grant-id", provenance.grantId);
  res.setHeader("x-korrx-controller-epoch", epoch);
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
//
// A stalled-but-connected client (TCP connection open, but the client
// simply stops reading) produces neither 'drain' nor 'close' — without a
// bound, this would park forever, pinning the caller's admission hold
// (bulkhead slot + token budget) indefinitely. When `timeoutMs` is
// provided, a timer races the drain/close listeners; on expiry it calls
// `res.destroy()`, which synchronously/asynchronously emits 'close',
// resolving this promise via the normal onClose path and letting the
// caller's loop unwind and release its hold.
// Exported for direct unit testing; not part of the GatewayOptions API.
export function waitForDrain(
  res: ServerResponse,
  timeoutMs?: number,
): Promise<void> {
  if (res.destroyed) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    res.once("drain", onDrain);
    res.once("close", onClose);

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // Does not resolve directly — destroying triggers 'close' above,
        // which is the single source of truth for "give up" resolution.
        res.destroy();
      }, timeoutMs);
    }
  });
}


function assertOptionalInteger(
  value: number | undefined,
  field: string,
  min: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${field} must be a safe integer >= ${min}`);
  }
}

function normalizeUpstreamUrl(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new Error(`${field} must not be empty`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http: or https:`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${field} must not include a query string or fragment`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function validateGatewayOptions(opts: GatewayOptions): void {
  assertOptionalInteger(opts.responseTimeoutMs, "responseTimeoutMs", 0);
  assertOptionalInteger(opts.idleTimeoutMs, "idleTimeoutMs", 0);
  assertOptionalInteger(opts.clientStallTimeoutMs, "clientStallTimeoutMs", 0);
  assertOptionalInteger(opts.maxRequestBodyBytes, "maxRequestBodyBytes", 1);
  assertOptionalInteger(opts.maxOutputTokens, "maxOutputTokens", 0);
  assertOptionalInteger(
    opts.shutdownDrainTimeoutMs,
    "shutdownDrainTimeoutMs",
    0,
  );
  if (
    opts.resolvePriority !== undefined &&
    typeof opts.resolvePriority !== "function"
  ) {
    throw new Error("resolvePriority must be a function");
  }
  if (
    opts.trustPriorityHeader !== undefined &&
    typeof opts.trustPriorityHeader !== "boolean"
  ) {
    throw new Error("trustPriorityHeader must be a boolean");
  }
}

export function createGateway(opts: GatewayOptions) {
  validateGatewayOptions(opts);
  const pools = createPools(opts.pools);
  const control: TyrControlPlane = Object.freeze({
    limits: () => pools.limits(),
    stats: () => pools.stats(),
    applyLimits: (updates) => pools.applyLimits(updates),
  });
  const anthropicUpstream = normalizeUpstreamUrl(opts.upstreamUrl, "upstreamUrl");
  const openaiUpstream = normalizeUpstreamUrl(
    opts.openaiUpstreamUrl,
    "openaiUpstreamUrl",
  );
  const responseTimeoutMs = opts.responseTimeoutMs;
  const idleTimeoutMs = opts.idleTimeoutMs;
  // Bounds how long the gateway waits for a backpressured client to drain
  // before giving up on it (see waitForDrain). Falls back to idleTimeoutMs
  // when not explicitly configured — a stalled client is conceptually the
  // same failure mode as an idle upstream, just on the other side of the
  // pipe, so it's reasonable to reuse the same bound by default.
  const clientStallTimeoutMs = opts.clientStallTimeoutMs ?? idleTimeoutMs;
  const maxRequestBodyBytes =
    opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const shutdownDrainTimeoutMs = opts.shutdownDrainTimeoutMs;
  const resolvePriority = opts.resolvePriority;
  const trustPriorityHeader = opts.trustPriorityHeader ?? false;





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
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: { type: "invalid_json" } });
        return;
      }

      const validation = adapter.validate(parsed, { maxOutputTokens });
      if (!validation.ok) {
        sendJson(res, 400, {
          error: { type: "invalid_request", errors: validation.errors },
        });
        return;
      }
      const body = validation.value;

      const model = typeof body["model"] === "string" ? body["model"] : "";
      const pool = pools.select(model);
      if (!pool) {
        sendJson(res, 422, {
          error: { type: "unsupported_model", model },
        });
        return;
      }

      // Complete token-bearing admission projection of the validated request.
      const llmRequest = adapter.toAdmissionRequest(body);

      let priority: LLMPriority = "normal";
      if (resolvePriority !== undefined) {
        priority = await resolvePriority(req);
        if (priority !== "normal" && priority !== "high") {
          throw new Error(
            `resolvePriority returned invalid priority: ${String(priority)}`,
          );
        }
      } else if (trustPriorityHeader) {
        priority = parsePriority(
          typeof req.headers["x-priority"] === "string"
            ? req.headers["x-priority"]
            : undefined,
        );
      }

      // Calculate one immutable reservation and pass it verbatim to both the
      // detailed advisory check and the authoritative v3.11 admission path.
      const preparation = pool.prepare(llmRequest, priority);
      res.setHeader("x-admission-mode", preparation.mode);
      res.setHeader(
        "x-admission-preview-revision",
        String(preparation.limitRevision),
      );
      // Immediate rejections never enter the run callback, so seed the
      // authoritative header with the preview revision. Queued requests may
      // overwrite it in the callback if a newer snapshot is active when they
      // actually begin execution.
      res.setHeader("x-admission-revision", String(preparation.limitRevision));
      res.setHeader(
        "x-admission-preview",
        preparation.advisory.admit ? "admit" : "reject",
      );
      if (preparation.advisory.reason !== undefined) {
        res.setHeader("x-admission-preview-reason", preparation.advisory.reason);
      }
      if (preparation.reservation !== null) {
        res.setHeader(
          "x-admission-reserved-tokens",
          String(preparation.reservation.reserved),
        );
      }

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
        await pool.run(
          llmRequest,
          preparation,
          async (signal, ctx) => {
            if (ctx !== undefined) {
              // Stable v3.11 identity and native observe-mode outcome.
              res.setHeader("x-admission-id", ctx.admissionId);
              res.setHeader("x-admission-outcome", ctx.admission);
              res.setHeader("x-admission-revision", String(ctx.limitRevision));
              setGrantProvenanceHeaders(res, ctx.provenance);
              if (ctx.bypassReason !== undefined) {
                res.setHeader("x-admission-bypass-reason", ctx.bypassReason);
              }
            }

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
                    await waitForDrain(res, clientStallTimeoutMs);
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
            // Explicit content-length (rather than relying on Node's
            // chunked-encoding fallback) since we've already buffered the
            // full upstream body here — this keeps response framing
            // deterministic for any client relying on content-length to
            // know where one response ends and the next begins, e.g. a
            // pipelined HTTP/1.1 client reading two responses off a
            // single socket back-to-back.
            res.writeHead(upstreamRes.status, {
              "content-type":
                upstreamRes.headers.get("content-type") ??
                "application/json",
              "content-length": Buffer.byteLength(text),
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
            getUsage: (result) => result.usage,
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
          const rejectionRevision =
            err.detail?.limitRevision ?? pool.controller.limits().revision;
          res.setHeader(
            "x-admission-revision",
            String(rejectionRevision),
          );
          setGrantProvenanceHeaders(
            res,
            pool.controller.provenance(rejectionRevision),
          );
          res.setHeader("x-admission-reason", err.reason);
          if (err.reason === "shutdown") {
            // Tell the client (and Node's keep-alive machinery) to close
            // this connection rather than keep it alive: the gateway is
            // shutting down, so there's no point idling the socket for a
            // pipelined/future request that would only be rejected again.
            // This also lets server.close()'s callback (and therefore
            // shutdown()) resolve promptly instead of waiting out the
            // keep-alive timeout on an otherwise-idle connection.
            res.setHeader("connection", "close");
          }
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
    // Route matching compares only the pathname, not the complete raw
    // URL — a request like "/v1/messages?x=1" must still match the
    // "/v1/messages" route; comparing req.url verbatim would incorrectly
    // 404 any request carrying a query string.
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (req.method === "POST" && pathname === anthropicAdapter.path) {
      if (!handleAnthropic) {
        sendJson(res, 404, { error: { type: "route_not_configured" } });
        return;
      }
      void handleAnthropic(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (req.method === "POST" && pathname === openaiAdapter.path) {
      if (!handleOpenAI) {
        sendJson(res, 404, { error: { type: "route_not_configured" } });
        return;
      }
      void handleOpenAI(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (req.method === "GET" && pathname === "/stats") {
      sendJson(res, 200, pools.stats());
      return;
    }
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: { type: "not_found" } });
  });

  let shuttingDown: Promise<PoolsDrainResult> | undefined;

  /**
   * Stops new admissions immediately, closes the HTTP listener, and drains
   * pool work. With `shutdownDrainTimeoutMs`, the library returns an outstanding-work
   * snapshot at the deadline; Tyr then closes remaining connections so process
   * termination is bounded instead of waiting forever on a dead stream.
   */
  function shutdown(): Promise<PoolsDrainResult> {
    if (shuttingDown) return shuttingDown;

    pools.close();
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    shuttingDown = (async () => {
      const drainResult = await pools.drain(shutdownDrainTimeoutMs);
      if (!drainResult.drained) {
        server.closeAllConnections();
      }
      await serverClosed;
      return drainResult;
    })();

    return shuttingDown;
  }

  return { server, control, shutdown };
}

