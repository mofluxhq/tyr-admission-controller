# tyr-gateway (private)

`tyr-gateway` is an admission-first proxy for Anthropic Messages and
OpenAI Chat Completions. Before an upstream call starts, it reserves estimated
input tokens plus the request's maximum output allowance against a model-routed
bulkhead. Requests that do not fit are rejected immediately instead of queued
behind saturated capacity.

Built on [`async-bulkhead-llm@3.5`](https://www.npmjs.com/package/async-bulkhead-llm),
which provides admission, usage reporting, refunds, priority reserves,
rejection detail, and graceful draining.

> **Status:** v0.6.1, single-process, private / UNLICENSED.

## Capacity semantics

A pool's `budget` is an **admission-time in-flight ceiling**. Each admitted
request reserves estimated input plus `max_tokens` (or the pool's `outputCap`).
Actual provider usage refunds unused capacity at completion, and streaming
usage can correct the hold while the response is still running.

Usage reported after admission can exceed the original estimate. In that case,
`async-bulkhead-llm` expands the active hold, so `inFlightTokens` may temporarily
exceed `budget`. The gateway blocks new admissions until capacity releases; it
does not abort the already-running request. This is deliberate overrun
accounting, not a strict post-admission kill switch.

Admission estimation includes the provider-specific prompt material that the
gateway forwards upstream:

- Anthropic `system`, `messages`, `tools`, and `tool_choice`.
- OpenAI `messages`, tool/function definitions and calls, `response_format`,
  and `prediction`.
- Null-content OpenAI assistant/tool turns, including their tool-call arguments.
- A conservative 2,048-token minimum surcharge for each opaque image, audio,
  document, file, or video block. Inline binary payload text is not counted as
  literal prompt text.

The estimate remains a load-shedding approximation, not billing-grade token
accounting.

## Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Admission-gated proxy to the Anthropic-shaped upstream |
| POST | `/v1/chat/completions` | Admission-gated proxy to the OpenAI-shaped upstream |
| GET | `/stats` | Per-pool live stats |
| GET | `/healthz` | Liveness |

Each provider route is enabled only when its upstream URL is configured.
Malformed requests return `400`; unsupported models return `422`; admission
rejections return `429`, `503`, or `504` with `x-admission-reason` and a
capacity snapshot. The gateway never fabricates `Retry-After`.

Provider authentication headers are forwarded verbatim. The gateway stores no
provider keys.

## Priority safety

Client-supplied `x-priority` is ignored by default. This prevents an
unauthenticated caller from assigning itself the high-priority budget reserve.

For application integrations, supply `GatewayOptions.resolvePriority` and
derive priority from an authenticated identity or trusted policy:

```ts
createGateway({
  resolvePriority: async (req) => {
    const identity = await authenticate(req);
    return identity.plan === "interactive" ? "high" : "normal";
  },
  // ...upstreams and pools
});
```

The env-configured entrypoint can opt into raw-header trust with
`TRUST_X_PRIORITY_HEADER=true`. Enable that only behind a trusted proxy that
removes client-provided copies and injects its own header.

## Run

Node.js 20 or newer is supported.

```bash
npm ci
npm run release:check

UPSTREAM_URL=https://api.anthropic.com \
OPENAI_UPSTREAM_URL=https://api.openai.com \
TOKEN_BUDGET=500000 MAX_CONCURRENT=50 \
npm start
```

`npm start` runs the TypeScript build first and starts `dist/index.js`; it does
not depend on Node's experimental TypeScript stripping.

At least one of `UPSTREAM_URL` or `OPENAI_UPSTREAM_URL` must be set. Invalid
URLs, ports, numeric ranges, pool names, duplicate model prefixes, and reserve
relationships fail during startup before the server begins listening.

## Configuration

`src/index.ts` loads one default pool from environment variables. For real
deployments, define pools in code, preferably one per model or closely related
model family:

```ts
createGateway({
  upstreamUrl: "https://api.anthropic.com",
  openaiUpstreamUrl: "https://api.openai.com",
  responseTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  clientStallTimeoutMs: 30_000,
  maxRequestBodyBytes: 1_048_576,
  maxOutputTokens: 200_000,
  pools: [
    {
      name: "sonnet",
      modelPrefixes: ["claude-sonnet-4"],
      model: "claude-sonnet-4-5",
      maxConcurrent: 40,
      budget: 400_000,
      highPriorityReserve: 80_000,
    },
    {
      name: "gpt",
      modelPrefixes: ["gpt-4o", "gpt-5"],
      model: "gpt-4o",
      maxConcurrent: 60,
      budget: 300_000,
    },
  ],
});
```

`budget` is tri-state: omit it to disable token-budget admission, set it to `0`
to reject all budget-gated calls, or set a positive integer for an active
ceiling. `highPriorityReserve` requires a configured budget and cannot exceed
it. Duplicate pool names and duplicate model prefixes are rejected.

See `.env.example` for the complete env-configured entrypoint settings.

## Proxy behavior

Request bodies are buffered up to `maxRequestBodyBytes` (1 MiB by default).
Streaming responses honor downstream backpressure, abort upstream work when
the client disconnects, and support separate response-header, upstream-idle,
and client-stall timeouts. Non-streaming responses are buffered and returned
with an explicit `content-length`.

`SIGTERM` and `SIGINT` stop new admissions, close the HTTP server, and drain
in-flight bulkhead work. Requests reaching an existing keep-alive connection
during shutdown receive `503` with `x-admission-reason: shutdown`.

## Known limitations

- Budgets and stats are per process. N replicas can admit approximately N times
  a per-replica budget unless capacity is partitioned or coordinated outside
  this gateway.
- SSE usage extraction should be verified against the exact provider/API
  versions used in production. Missing usage affects refunds, not proxying.
- There is no Anthropic/OpenAI format translation.
- `/stats` and provider routes have no built-in authentication or persistence.
- There is no active-stream termination policy for usage overruns.

## Layout

```text
src/
  admission.ts    complete prompt projection and media surcharge estimator
  adapters.ts     provider validation, admission projection, usage parsing
  config.ts       validated environment configuration
  index.ts        env-configured process entrypoint
  pools.ts        pool validation, routing, and bulkhead construction
  server.ts       HTTP proxy, admission, timeouts, and shutdown
  sse.ts          Anthropic streaming usage extraction
  sse-openai.ts   OpenAI streaming usage extraction
  validation.ts   provider-agnostic request shape validation
test/
  gateway.test.ts end-to-end and configuration regression tests
```