import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  LLMBorrowedConcurrencyDeadlineError,
  LLMBulkheadRejectedError,
  type LLMRejectReason,
  type LLMPriority,
  type TokenUsage,
} from "async-bulkhead-llm";
import { normalizeAdmissionClassId } from "./admission-policy.js";
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
import {
  RetryHintEstimator,
  retryAfterSeconds,
  type RetryHintOptions,
} from "./retry-hint.js";
import {
  anthropicAdapter,
  openaiAdapter,
  openaiResponsesAdapter,
  type Adapter,
} from "./adapters.js";
import {
  hasAnyRole,
  normalizeRequestIdentity,
  requireAnyRole,
  TyrIdentityError,
  type TyrIdentityOptions,
  type TyrRequestIdentity,
} from "./identity.js";
import {
  TyrTelemetry,
  type TyrAdmissionAuditEvent,
  type TyrAuditSettlement,
  type TyrRequestOutcome,
  type TyrTelemetryOptions,
} from "./telemetry.js";
import {
  CapacityAwareRouter,
  TYR_ROUTING_CAPACITY_PATH,
  type CapacityRoutingOptions,
  type CapacityRoutingTopology,
  type InternalRouteClassification,
} from "./routing.js";

export type GatewayOptions = {
  /**
   * Anthropic-shaped upstream base URL, e.g. "https://api.anthropic.com".
   * Powers `POST /v1/messages`. Omit to disable that route.
   */
  upstreamUrl?: string;
  /**
   * OpenAI-shaped upstream base URL, e.g. "https://api.openai.com".
   * Powers `POST /v1/chat/completions` and `POST /v1/responses`. Omit to
   * disable both OpenAI routes.
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
   * Omit for an unbounded drain, which waits for final token settlement even
   * after a borrowed local slot was returned by deadline abandonment.
   */
  shutdownDrainTimeoutMs?: number;
  /**
   * Resolve admission priority from an authenticated/trusted request context.
   * This is the preferred way to grant high-priority capacity.
   */
  resolvePriority?: (
    req: IncomingMessage,
    identity?: TyrRequestIdentity,
  ) => LLMPriority | Promise<LLMPriority>;
  /**
   * Override per-pool identity rules with a trusted bounded admission-class ID.
   * Return undefined to use the pool's configured default class.
   */
  resolveAdmissionClass?: (
    req: IncomingMessage,
    identity: TyrRequestIdentity | undefined,
    pool: string,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Trust the raw client-supplied `x-priority` header. Disabled by default
   * because an unauthenticated caller could otherwise self-assign the
   * reserved high-priority tier. Enable only behind a trusted proxy that
   * strips client copies and injects the header itself.
   */
  trustPriorityHeader?: boolean;
  /** Optional process-level readiness gate, such as managed control-plane state. */
  isReady?: () => boolean;
  /** Authenticated request identity, role authorization, and role priority. */
  identity?: TyrIdentityOptions;
  /** Prometheus and structured admission-audit configuration. */
  telemetry?: TyrTelemetryOptions;
  /**
   * Tuning for the `Retry-After` hint returned on capacity rejections.
   *
   * Tyr estimates the wait from observed upstream completion intervals for
   * the pool. Until it has enough samples it emits no hint rather than a
   * fabricated one. Omit to accept the defaults; set `enabled: false` to
   * suppress the headers entirely.
   */
  retryHint?: RetryHintOptions;
  /** Optional bearer token protecting /stats and /metrics. */
  operatorBearerToken?: string;
  /** Optional Tyr-to-Tyr capacity-aware request routing. */
  capacityRouting?: CapacityRoutingOptions;
  pools: PoolConfig[];
};

/**
 * Narrow runtime surface intended for an embedded or remote control-plane
 * agent. Request forwarding remains encapsulated inside the gateway.
 */
export type TyrRoutingControlPlane = {
  /** Applies a complete higher-revision routing-membership snapshot. */
  applyTopology(topology: CapacityRoutingTopology): boolean;
};

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

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function bearerTokenMatches(
  req: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (expectedToken === undefined) return true;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requestOutcomeForStatus(status: number): TyrRequestOutcome {
  if (status >= 500) return "upstream_5xx";
  if (status >= 400) return "upstream_4xx";
  return "success";
}

function upstreamOutcomeForStatus(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
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
  onTimeout?: () => void,
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
        onTimeout?.();
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

function validateRoleList(roles: readonly string[] | undefined, field: string): void {
  if (roles === undefined) return;
  if (!Array.isArray(roles)) throw new Error(`${field} must be a string array`);
  for (const role of roles) {
    if (typeof role !== "string" || role.trim().length === 0) {
      throw new Error(`${field} must contain only non-empty strings`);
    }
  }
}

function identityFailure(error: unknown): TyrIdentityError {
  if (error instanceof TyrIdentityError) return error;
  return new TyrIdentityError(
    "identity_unavailable",
    error instanceof Error ? error.message : "identity authentication failed",
    503,
  );
}

function sendIdentityFailure(res: ServerResponse, error: TyrIdentityError): void {
  if (error.status === 401) {
    res.setHeader("www-authenticate", 'Bearer realm="tyr-identity"');
  }
  sendJson(res, error.status, { error: { type: error.code } });
}

function effectiveIdentityCredentialHeader(
  identity: TyrIdentityOptions | undefined,
): string | undefined {
  return (
    identity?.credentialHeader ?? identity?.authenticate.credentialHeader
  )?.trim().toLowerCase();
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
  if (opts.isReady !== undefined && typeof opts.isReady !== "function") {
    throw new Error("isReady must be a function");
  }
  if (opts.identity !== undefined) {
    if (typeof opts.identity.authenticate !== "function") {
      throw new Error("identity.authenticate must be a function");
    }
    const effectiveHeader = effectiveIdentityCredentialHeader(opts.identity);
    if (effectiveHeader !== undefined) {
      const header = effectiveHeader;
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)) {
        throw new Error("identity.credentialHeader must be a valid HTTP header name");
      }
      const providerHeaders = new Set([
        "authorization",
        "content-type",
        "x-api-key",
        "anthropic-version",
        "anthropic-beta",
        "openai-organization",
        "openai-project",
      ]);
      if (providerHeaders.has(header)) {
        throw new Error(
          `identity.credentialHeader conflicts with provider header ${header}`,
        );
      }
    }
    validateRoleList(opts.identity.invokeRoles, "identity.invokeRoles");
    validateRoleList(opts.identity.operatorRoles, "identity.operatorRoles");
    validateRoleList(
      opts.identity.highPriorityRoles,
      "identity.highPriorityRoles",
    );
  }
  if (
    opts.operatorBearerToken !== undefined &&
    (typeof opts.operatorBearerToken !== "string" ||
      opts.operatorBearerToken.trim().length === 0)
  ) {
    throw new Error("operatorBearerToken must be a non-empty string");
  }
  if (
    opts.telemetry?.metricsEnabled !== undefined &&
    typeof opts.telemetry.metricsEnabled !== "boolean"
  ) {
    throw new Error("telemetry.metricsEnabled must be a boolean");
  }
  if (
    opts.telemetry?.auditEnabled !== undefined &&
    typeof opts.telemetry.auditEnabled !== "boolean"
  ) {
    throw new Error("telemetry.auditEnabled must be a boolean");
  }
  if (
    opts.telemetry?.auditSink !== undefined &&
    typeof opts.telemetry.auditSink !== "function"
  ) {
    throw new Error("telemetry.auditSink must be a function");
  }
}

export function createGateway(opts: GatewayOptions) {
  validateGatewayOptions(opts);
  const telemetry = new TyrTelemetry(opts.telemetry);
  const pools = createPools(opts.pools, {
    onAdmissionDecisionTiming: (event) =>
      telemetry.recordAdmissionDecisionTiming(event),
  });
  const retryHints = new RetryHintEstimator(opts.retryHint);
  const operatorBearerToken = opts.operatorBearerToken;
  const identityOptions = opts.identity;
  const identityCredentialHeader =
    effectiveIdentityCredentialHeader(identityOptions) ??
    "x-tyr-identity-token";
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
  const resolveAdmissionClass = opts.resolveAdmissionClass;
  const trustPriorityHeader = opts.trustPriorityHeader ?? false;
  const isReady = opts.isReady ?? (() => true);
  const capacityRouter =
    opts.capacityRouting === undefined
      ? undefined
      : new CapacityAwareRouter({
          options: opts.capacityRouting,
          pools,
          ready: isReady,
        });
  capacityRouter?.start();

  async function authenticateIdentity(
    req: IncomingMessage,
  ): Promise<TyrRequestIdentity> {
    if (identityOptions === undefined) {
      throw new TyrIdentityError(
        "identity_required",
        "request identity is not configured",
        401,
      );
    }
    try {
      return normalizeRequestIdentity(await identityOptions.authenticate(req));
    } catch (error) {
      throw identityFailure(error);
    }
  }

  async function proxyToCapacityPeer(input: {
    req: IncomingMessage;
    res: ServerResponse;
    raw: Buffer;
    adapter: Adapter;
    baseUrl: string;
    targetInstanceId: string;
    priority: LLMPriority;
    admissionClass?: string;
  }): Promise<void> {
    if (capacityRouter === undefined) {
      throw new Error("capacity router is not configured");
    }

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, capacityRouter.forwardTimeoutMs);
    const onClose = () => {
      if (!input.res.writableEnded) abort.abort();
    };
    input.res.once("close", onClose);
    input.res.setHeader("x-tyr-routed-by", capacityRouter.instanceId);
    input.res.setHeader("x-tyr-routed-to", input.targetInstanceId);

    try {
      const response = await fetch(`${input.baseUrl}${input.adapter.path}`, {
        method: "POST",
        headers: capacityRouter.forwardedHeaders(
          input.req.headers,
          input.priority,
          input.admissionClass,
        ),
        body: input.raw,
        redirect: "error",
        signal: abort.signal,
      });
      clearTimeout(timer);

      for (const [name, value] of response.headers) {
        const lower = name.toLowerCase();
        if (
          lower === "connection" ||
          lower === "keep-alive" ||
          lower === "transfer-encoding"
        ) {
          continue;
        }
        input.res.setHeader(name, value);
      }
      input.res.writeHead(response.status);

      if (response.body === null) {
        input.res.end();
        return;
      }
      for await (const chunk of response.body) {
        if (!input.res.write(chunk)) {
          await waitForDrain(input.res, clientStallTimeoutMs);
        }
      }
      input.res.end();
    } catch (error) {
      if (input.res.destroyed || input.res.headersSent) {
        input.res.destroy();
        return;
      }
      sendJson(input.res, timedOut ? 504 : 502, {
        error: {
          type: timedOut ? "routing_peer_timeout" : "routing_peer_unavailable",
          peer: input.targetInstanceId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      clearTimeout(timer);
      input.res.removeListener("close", onClose);
    }
  }

  function makeHandler(adapter: Adapter, upstream: string) {
    return async function handle(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      const requestStartedAt = performance.now();
      const routeClassification: InternalRouteClassification =
        capacityRouter?.classify(req) ?? { kind: "external" };
      if (routeClassification.kind === "invalid") {
        req.resume();
        res.setHeader("connection", "close");
        sendJson(res, 401, { error: { type: "routing_unauthorized" } });
        return;
      }
      let requestIdentity: TyrRequestIdentity | undefined;
      if (identityOptions !== undefined) {
        try {
          requestIdentity = await authenticateIdentity(req);
          requireAnyRole(requestIdentity, identityOptions.invokeRoles);
        } catch (error) {
          // Do not buffer unauthorized payloads. Drain only to keep Node's HTTP
          // parser in a defined state, then close this connection after the
          // response so unread request bytes cannot contaminate keep-alive.
          req.resume();
          res.setHeader("connection", "close");
          sendIdentityFailure(res, identityFailure(error));
          return;
        }
      }

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
      if (routeClassification.kind === "internal") {
        priority = routeClassification.priority;
      } else if (resolvePriority !== undefined) {
        priority = await resolvePriority(req, requestIdentity);
        if (priority !== "normal" && priority !== "high") {
          throw new Error(
            `resolvePriority returned invalid priority: ${String(priority)}`,
          );
        }
      } else if (requestIdentity !== undefined && identityOptions !== undefined) {
        priority = hasAnyRole(
          requestIdentity,
          identityOptions.highPriorityRoles,
        )
          ? "high"
          : "normal";
      } else if (trustPriorityHeader) {
        priority = parsePriority(
          typeof req.headers["x-priority"] === "string"
            ? req.headers["x-priority"]
            : undefined,
        );
      }

      let admissionClass =
        routeClassification.kind === "internal" &&
        routeClassification.admissionClass !== undefined
          ? routeClassification.admissionClass
          : pool.resolveAdmissionClass(requestIdentity);
      if (
        routeClassification.kind === "external" &&
        resolveAdmissionClass !== undefined
      ) {
        const resolved = await resolveAdmissionClass(
          req,
          requestIdentity,
          pool.name,
        );
        if (resolved !== undefined) {
          admissionClass = normalizeAdmissionClassId(
            resolved,
            "resolveAdmissionClass result",
          );
        }
      }

      const configuredAdmissionClasses =
        pool.controller.limits().admissionClasses;
      if (
        admissionClass !== undefined &&
        (configuredAdmissionClasses === undefined ||
          !Object.hasOwn(configuredAdmissionClasses, admissionClass))
      ) {
        throw new Error(
          `admission class ${JSON.stringify(admissionClass)} is not configured for pool ${JSON.stringify(pool.name)}`,
        );
      }

      if (
        capacityRouter !== undefined &&
        routeClassification.kind === "external"
      ) {
        const reservation = pool.estimate(llmRequest);
        const route = capacityRouter.select({
          poolName: pool.name,
          priority,
          ...(admissionClass === undefined ? {} : { admissionClass }),
          reservation,
        });
        if (!route.local && route.baseUrl !== undefined) {
          await proxyToCapacityPeer({
            req,
            res,
            raw,
            adapter,
            baseUrl: route.baseUrl,
            targetInstanceId: route.instanceId,
            priority,
            ...(admissionClass === undefined ? {} : { admissionClass }),
          });
          return;
        }
      }

      // Calculate one immutable reservation and pass it verbatim to both the
      // detailed advisory check and the authoritative admission path.
      const preparation = pool.prepare(llmRequest, priority, admissionClass);
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
      if (preparation.admissionClass !== undefined) {
        res.setHeader("x-admission-class", preparation.admissionClass);
      }
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
      const abort = new AbortController();
      const admissionSignal: AbortSignal = abort.signal;
      let failureKind:
        | "borrowed_admission_deadline"
        | "response_timeout"
        | "idle_timeout"
        | "client_disconnect"
        | "client_stall"
        | undefined;
      let observedUsage: TokenUsage | undefined;
      let requestRecorded = false;
      let admissionAudit:
        | Omit<
            TyrAdmissionAuditEvent,
            "schema" | "timestamp" | "event" | "settlement" | "usage"
          >
        | undefined;

      const recordRequest = (outcome: TyrRequestOutcome): void => {
        if (requestRecorded) return;
        requestRecorded = true;
        telemetry.recordRequest({
          pool: pool.name,
          provider: adapter.shape,
          outcome,
          durationSeconds: (performance.now() - requestStartedAt) / 1_000,
        });
      };

      const emitAdmissionAudit = (
        settlement: TyrAuditSettlement,
        usage?: TokenUsage,
        restoration?: TyrAdmissionAuditEvent["restoration"],
      ): void => {
        if (admissionAudit === undefined) return;
        telemetry.emitAdmissionAudit({
          ...admissionAudit,
          settlement,
          ...(usage === undefined ? {} : { usage }),
          ...(restoration === undefined ? {} : { restoration }),
        });
        admissionAudit = undefined;
      };

      res.on("close", () => {
        if (!res.writableEnded) {
          failureKind ??= "client_disconnect";
          abort.abort();
        }
      });

      const headers: Record<string, string> = {};
      for (const header of adapter.forwardHeaders) {
        if (identityOptions !== undefined && header === identityCredentialHeader) {
          continue;
        }
        const value = req.headers[header];
        if (typeof value === "string") headers[header] = value;
      }

      try {
        const result = await pool.run(
          llmRequest,
          preparation,
          async (signal, ctx) => {
            if (ctx !== undefined) {
              // Stable admission identity and native observe-mode outcome.
              res.setHeader("x-admission-id", ctx.admissionId);
              res.setHeader("x-admission-outcome", ctx.admission);
              res.setHeader("x-admission-revision", String(ctx.limitRevision));
              res.setHeader(
                "x-admission-slot-borrowed",
                String(ctx.resources.borrowedConcurrency),
              );
              res.setHeader(
                "x-admission-borrowed-tokens",
                String(ctx.resources.borrowedTokens),
              );
              if (ctx.borrowedAdmissionSlot !== undefined) {
                res.setHeader(
                  "x-admission-slot-deadline-ms",
                  String(ctx.borrowedAdmissionSlot.deadlineMs),
                );
              }
              if (ctx.admissionClass !== undefined) {
                res.setHeader("x-admission-class", ctx.admissionClass);
              }
              setGrantProvenanceHeaders(res, ctx.provenance);
              if (ctx.bypassReason !== undefined) {
                res.setHeader("x-admission-bypass-reason", ctx.bypassReason);
              }

              telemetry.recordAdmissionStart({
                pool: pool.name,
                priority,
                ...(ctx.admissionClass === undefined
                  ? {}
                  : { admissionClass: ctx.admissionClass }),
                outcome: ctx.admission,
              });
              admissionAudit = {
                outcome: ctx.admission,
                pool: pool.name,
                provider: adapter.shape,
                priority,
                ...(ctx.admissionClass === undefined
                  ? {}
                  : { admissionClass: ctx.admissionClass }),
                ...(requestIdentity === undefined
                  ? {}
                  : { identity: requestIdentity }),
                model,
                admissionId: ctx.admissionId,
                limitRevision: ctx.limitRevision,
                ...(ctx.bypassReason === undefined
                  ? {}
                  : { reason: ctx.bypassReason }),
                ...(ctx.reservation === null
                  ? {}
                  : { reservedTokens: ctx.reservation.reserved }),
                resources: ctx.resources,
                ...(ctx.provenance === undefined
                  ? {}
                  : { grant: ctx.provenance }),
              };
            }

            const upstreamStartedAt = performance.now();
            let upstreamMetricOutcome = "upstream_error";
            const noteBorrowedDeadline = (): void => {
              if (
                signal?.aborted === true &&
                signal.reason instanceof LLMBorrowedConcurrencyDeadlineError
              ) {
                failureKind = "borrowed_admission_deadline";
              }
            };
            if (signal?.aborted === true) noteBorrowedDeadline();
            else signal?.addEventListener("abort", noteBorrowedDeadline, { once: true });
            try {
              // Response timeout bounds how long fetch waits for upstream
              // response headers. It is cleared as soon as headers arrive.
              let responseTimer: ReturnType<typeof setTimeout> | undefined;
              if (responseTimeoutMs !== undefined) {
                responseTimer = setTimeout(() => {
                  failureKind = "response_timeout";
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

              telemetry.recordUpstreamResponse({
                pool: pool.name,
                provider: adapter.shape,
                status: upstreamRes.status,
              });
              upstreamMetricOutcome = upstreamOutcomeForStatus(
                upstreamRes.status,
              );

              if (wantsStream && upstreamRes.body) {
                res.writeHead(upstreamRes.status, {
                  "content-type":
                    upstreamRes.headers.get("content-type") ??
                    "text/event-stream",
                  "cache-control": "no-cache",
                  connection: "keep-alive",
                });
                const extractor = adapter.createStreamExtractor((usage) => {
                  observedUsage = usage;
                  ctx?.reportUsage(usage);
                });
                const decoder = new TextDecoder();

                let idleTimer: ReturnType<typeof setTimeout> | undefined;
                const armIdleTimer = () => {
                  if (idleTimeoutMs === undefined) return;
                  if (idleTimer !== undefined) clearTimeout(idleTimer);
                  idleTimer = setTimeout(() => {
                    failureKind = "idle_timeout";
                    abort.abort();
                  }, idleTimeoutMs);
                };

                try {
                  armIdleTimer();
                  for await (const chunk of upstreamRes.body) {
                    armIdleTimer();
                    extractor.push(decoder.decode(chunk, { stream: true }));
                    if (!res.write(chunk)) {
                      await waitForDrain(res, clientStallTimeoutMs, () => {
                        failureKind = "client_stall";
                      });
                    }
                  }
                } finally {
                  if (idleTimer !== undefined) clearTimeout(idleTimer);
                }

                res.end();
                observedUsage = extractor.current();
                return { usage: observedUsage, status: upstreamRes.status };
              }

              const text = await upstreamRes.text();
              res.writeHead(upstreamRes.status, {
                "content-type":
                  upstreamRes.headers.get("content-type") ??
                  "application/json",
                "content-length": Buffer.byteLength(text),
              });
              res.end(text);

              try {
                observedUsage = adapter.parseUsage(JSON.parse(text));
              } catch {
                // Non-JSON upstream response: no usage to report.
              }
              return { usage: observedUsage, status: upstreamRes.status };
            } finally {
              signal?.removeEventListener("abort", noteBorrowedDeadline);
              if (failureKind !== undefined) {
                upstreamMetricOutcome = failureKind;
              }
              telemetry.recordUpstreamDuration({
                pool: pool.name,
                provider: adapter.shape,
                outcome: upstreamMetricOutcome,
                durationSeconds: (performance.now() - upstreamStartedAt) / 1_000,
              });
              // Capacity returns to the pool here. Feeding the estimator from
              // the same place keeps the Retry-After hint grounded in observed
              // completions rather than in an assumed service time.
              retryHints.observeCompletion(
                pool.name,
                preparation.reservation?.reserved ?? 0,
                Date.now(),
              );
            }
          },
          {
            priority,
            ...(admissionClass === undefined ? {} : { admissionClass }),
            signal: admissionSignal,
            getUsage: (value) => value.usage,
          },
        );

        recordRequest(requestOutcomeForStatus(result.status));
        emitAdmissionAudit("completed", result.usage);
      } catch (err) {
        if (err instanceof LLMBorrowedConcurrencyDeadlineError) {
          failureKind = "borrowed_admission_deadline";
          const restoration = {
            admissionSlot: {
              releaseMechanism: "deadline_abandonment" as const,
              enforceability: "enforced" as const,
              outcome: "released" as const,
              deadlineMs: err.deadlineMs,
            },
            upstreamCapacity: {
              releaseMechanism: "abort_signal" as const,
              enforceability: "unverified" as const,
              outcome: "cancellation_requested" as const,
            },
          };
          recordRequest("borrowed_admission_deadline");
          emitAdmissionAudit(
            "borrowed_admission_deadline",
            observedUsage,
            restoration,
          );

          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.setHeader("x-admission-reason", "borrowed_admission_deadline");
          res.setHeader(
            "x-admission-slot-deadline-ms",
            String(err.deadlineMs),
          );
          sendJson(res, 504, {
            error: {
              type: "borrowed_admission_deadline",
              message: `borrowed admission slot deadline expired after ${err.deadlineMs}ms`,
              resource: "admission_slot",
              releaseMechanism: "deadline_abandonment",
              localSlotReleased: true,
              upstreamCancellation: "requested",
              upstreamReclamation: "unverified",
              resources: err.resources,
            },
          });
          return;
        }
        if (err instanceof LLMBulkheadRejectedError) {
          const status = rejectStatus(err.reason);
          const rejectionRevision =
            err.detail?.limitRevision ?? pool.controller.limits().revision;
          const provenance = pool.controller.provenance(rejectionRevision);
          telemetry.recordRejection({
            pool: pool.name,
            priority,
            ...(preparation.admissionClass === undefined
              ? {}
              : { admissionClass: preparation.admissionClass }),
            reason: err.reason,
          });
          telemetry.emitAdmissionAudit({
            outcome: "rejected",
            settlement: "rejected",
            pool: pool.name,
            provider: adapter.shape,
            priority,
            ...(preparation.admissionClass === undefined
              ? {}
              : { admissionClass: preparation.admissionClass }),
            ...(requestIdentity === undefined
              ? {}
              : { identity: requestIdentity }),
            model,
            limitRevision: rejectionRevision,
            reason: err.reason,
            ...(preparation.reservation === null
              ? {}
              : { reservedTokens: preparation.reservation.reserved }),
            ...(provenance === undefined ? {} : { grant: provenance }),
          });
          recordRequest("admission_rejected");

          if (res.headersSent) {
            res.destroy();
            return;
          }
          res.setHeader("x-admission-revision", String(rejectionRevision));
          if (preparation.admissionClass !== undefined) {
            res.setHeader("x-admission-class", preparation.admissionClass);
          }
          setGrantProvenanceHeaders(res, provenance);
          res.setHeader("x-admission-reason", err.reason);
          const retryAfterMs = retryHints.hintMs(
            pool.name,
            err.reason,
            err.detail,
            Date.now(),
          );
          if (retryAfterMs !== undefined) {
            // The precise value always; the whole-second header only when it
            // can carry the wait without badly overstating it.
            res.setHeader("x-admission-retry-after-ms", String(retryAfterMs));
            const retryAfterSecs = retryAfterSeconds(retryAfterMs);
            if (retryAfterSecs !== undefined) {
              res.setHeader("retry-after", String(retryAfterSecs));
            }
          }
          if (err.reason === "shutdown") {
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

        const settlement: Exclude<TyrAuditSettlement, "completed" | "rejected"> =
          failureKind ?? "upstream_error";
        recordRequest(settlement);
        emitAdmissionAudit(settlement, observedUsage);

        if (res.headersSent) {
          // A stream already started; no safe response body remains.
          res.destroy();
          return;
        }
        if (settlement === "client_disconnect" || settlement === "client_stall") {
          res.destroy();
          return;
        }
        if (settlement === "response_timeout") {
          sendJson(res, 504, {
            error: {
              type: "response_timeout",
              message: `upstream did not respond within ${responseTimeoutMs}ms`,
            },
          });
          return;
        }
        if (settlement === "idle_timeout") {
          sendJson(res, 504, {
            error: {
              type: "idle_timeout",
              message: `upstream stream stalled for ${idleTimeoutMs}ms`,
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
  const handleOpenAIResponses = openaiUpstream
    ? makeHandler(openaiResponsesAdapter, openaiUpstream)
    : undefined;

  async function authorizeOperator(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (
      operatorBearerToken !== undefined &&
      bearerTokenMatches(req, operatorBearerToken)
    ) {
      return true;
    }

    const operatorRoles = identityOptions?.operatorRoles;
    if (identityOptions !== undefined && operatorRoles !== undefined && operatorRoles.length > 0) {
      try {
        const identity = await authenticateIdentity(req);
        requireAnyRole(identity, operatorRoles);
        return true;
      } catch (error) {
        sendIdentityFailure(res, identityFailure(error));
        return false;
      }
    }

    if (operatorBearerToken === undefined) return true;
    res.setHeader("www-authenticate", 'Bearer realm="tyr-operator"');
    sendJson(res, 401, { error: { type: "operator_unauthorized" } });
    return false;
  }

  async function handleOperatorRoute(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: "/stats" | "/metrics",
  ): Promise<void> {
    if (!(await authorizeOperator(req, res))) return;
    if (pathname === "/stats") {
      sendJson(res, 200, pools.stats());
      return;
    }
    if (!telemetry.metricsEnabled) {
      sendJson(res, 404, { error: { type: "metrics_disabled" } });
      return;
    }
    sendText(
      res,
      200,
      telemetry.renderPrometheus(pools.stats(), opts.isReady?.() ?? true),
      "text/plain; version=0.0.4; charset=utf-8",
    );
  }

  const server = createServer((req, res) => {
    // Route matching compares only the pathname, not the complete raw
    // URL — a request like "/v1/messages?x=1" must still match the
    // "/v1/messages" route; comparing req.url verbatim would incorrectly
    // 404 any request carrying a query string.
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (req.method === "GET" && pathname === TYR_ROUTING_CAPACITY_PATH) {
      if (capacityRouter === undefined) {
        sendJson(res, 404, { error: { type: "routing_not_configured" } });
        return;
      }
      if (!capacityRouter.authorizedCapacityRequest(req)) {
        sendJson(res, 401, { error: { type: "routing_unauthorized" } });
        return;
      }
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, capacityRouter.snapshot());
      return;
    }

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
    if (req.method === "POST" && pathname === openaiResponsesAdapter.path) {
      if (!handleOpenAIResponses) {
        sendJson(res, 404, { error: { type: "route_not_configured" } });
        return;
      }
      void handleOpenAIResponses(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (
      req.method === "GET" &&
      (pathname === "/stats" || pathname === "/metrics")
    ) {
      void handleOperatorRoute(req, res, pathname).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { type: "internal" } });
      });
      return;
    }
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && pathname === "/readyz") {
      const ready = isReady();
      sendJson(
        res,
        ready ? 200 : 503,
        ready
          ? { ok: true }
          : { ok: false, reason: "control_plane_not_ready" },
      );
      return;
    }
    sendJson(res, 404, { error: { type: "not_found" } });
  });

  let shuttingDown: Promise<PoolsDrainResult> | undefined;

  /**
   * Stops new admissions immediately, closes the HTTP listener, and drains
   * pool work, including token settlement after borrowed-slot abandonment.
   * With `shutdownDrainTimeoutMs`, the library returns an outstanding-work
   * snapshot at the deadline; Tyr then closes remaining connections so process
   * termination is bounded instead of waiting forever on a dead stream.
   */
  function shutdown(): Promise<PoolsDrainResult> {
    if (shuttingDown) return shuttingDown;

    capacityRouter?.stop();
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

  const routing: TyrRoutingControlPlane | undefined =
    capacityRouter === undefined
      ? undefined
      : Object.freeze({
          applyTopology: (topology: CapacityRoutingTopology) =>
            capacityRouter.applyTopology(topology),
        });

  return { server, control, telemetry, routing, shutdown };
}
