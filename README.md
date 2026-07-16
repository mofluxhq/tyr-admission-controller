# torii-gateway (private)

An **admission-first** AI gateway. Unlike gateways that do windowed rate
limiting and after-the-fact spend tracking, this one enforces a true in-flight
**token-budget ceiling** at admission: every request reserves its estimated
input + `max_tokens` before it runs, refunds the surplus as real usage arrives
(including mid-stream), and **fails fast** the moment the ceiling is hit — no
retry storms, no queue collapse.

Built on [`async-bulkhead-llm`](https://www.npmjs.com/package/async-bulkhead-llm)
(≥ 3.2.0), which provides the reserve → report → refund → release lifecycle,
priority admission, and rejection detail.

> **Status:** v0.2, single-process. Cluster-wide budget coordination is
> designed but not implemented — see `DESIGN-distributed-token-budget.md`.
> **Private / UNLICENSED.** Not for redistribution.

## What it does

- **Proxies** `POST /v1/messages` (Anthropic-shaped) and
  `POST /v1/chat/completions` (OpenAI-shaped) to their respective upstreams,
  passing auth headers through verbatim. The gateway holds no provider keys.
  Each route proxies to its own upstream and wire shape — there is no
  cross-format translation between the two.
- **Admits** each request against a model-routed pool with a fail-fast token
  budget and concurrency limit. Both endpoints share the same pool/bulkhead
  admission machinery, so a pool can serve models from either provider.
- **Reports usage mid-stream** by parsing SSE events as they arrive, so a
  long-running stream's budget hold is corrected live:
  - Anthropic: `message_start` / `message_delta` events (partial usage
    available early — see `src/sse.ts`).
  - OpenAI: cumulative `usage` on the final `chat.completion.chunk`, present
    only when the client sets `stream_options: { include_usage: true }` (see
    `src/sse-openai.ts`). Without it, no mid-stream signal is available and
    the pre-admission reservation is used at release.
- **Caps request body buffering.** Incoming request bodies are buffered up to
  `maxRequestBodyBytes` (default 1 MiB); anything larger is rejected with
  `413 Payload Too Large` before it consumes further memory.
- **Applies streaming backpressure.** When proxying a streaming response, the
  gateway honors `res.write()`'s return value and pauses pulling further
  chunks from the upstream body whenever the client's write buffer is full,
  resuming once it drains. A fast upstream paired with a slow-reading client
  can no longer force the gateway to buffer an entire response in memory.
- **Rejects** with `429`/`503`/`504` plus an `x-admission-reason` header and a

  JSON `detail` capacity snapshot — no fabricated `Retry-After`.
- **Routes** by longest model-prefix match across pools.
- **Shuts down gracefully.** `SIGTERM`/`SIGINT` stop the server from accepting
  new connections and drain every pool's bulkhead — in-flight requests finish
  normally while new admissions are rejected with `503` (`x-admission-reason:
  shutdown`) until drain completes.


## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Admission-gated proxy to the Anthropic-shaped upstream |
| POST | `/v1/chat/completions` | Admission-gated proxy to the OpenAI-shaped upstream |
| GET | `/stats` | Per-pool live stats (budget, slots, refunds) |
| GET | `/healthz` | Liveness |

Each route is enabled only when its corresponding upstream URL is configured
(`UPSTREAM_URL` for Anthropic, `OPENAI_UPSTREAM_URL` for OpenAI). Requesting a
route with no configured upstream returns `404`.

Request headers: `x-priority: high` opts a request into the high-priority
budget tier (see `highPriorityReserve`). Provider auth headers are forwarded
as-is: `x-api-key` / `authorization` / `anthropic-version` / `anthropic-beta`
for Anthropic, `authorization` / `openai-organization` / `openai-project` for
OpenAI.

## Run

```bash
npm install
npm test          # mock upstreams, no network
npm run build
UPSTREAM_URL=https://api.anthropic.com \
OPENAI_UPSTREAM_URL=https://api.openai.com \
TOKEN_BUDGET=500000 MAX_CONCURRENT=50 \
npm start
```

See `.env.example` for configuration. At least one of `UPSTREAM_URL` /
`OPENAI_UPSTREAM_URL` must be set.

## Configuration

`src/index.ts` wires a single "default" pool from env vars for convenience.
For real deployments, define pools explicitly in code — one pool per model (or
model family) is the intended pattern, since the token estimator is
model-aware:

```ts
createGateway({
  upstreamUrl: "https://api.anthropic.com",
  openaiUpstreamUrl: "https://api.openai.com",
  responseTimeoutMs: 30_000, // optional — upstream must send headers within 30s
  idleTimeoutMs: 30_000,     // optional — stream must not stall for 30s between chunks
  maxRequestBodyBytes: 1_048_576, // optional, defaults to 1 MiB
  pools: [

    { name: "sonnet", modelPrefixes: ["claude-sonnet-4"], model: "claude-sonnet-4-5",
      maxConcurrent: 40, budget: 400_000, highPriorityReserve: 80_000 },
    { name: "haiku",  modelPrefixes: ["claude-haiku-4"],  model: "claude-haiku-4-5",
      maxConcurrent: 80, budget: 200_000 },
    { name: "gpt",    modelPrefixes: ["gpt-4o", "gpt-5"], model: "gpt-4o",
      maxConcurrent: 60, budget: 300_000 },
  ],
});
```

`upstreamUrl` and `openaiUpstreamUrl` are both optional — omit either to
disable its route entirely (e.g. an Anthropic-only or OpenAI-only deployment).

`maxRequestBodyBytes` caps how much of an incoming request body the gateway
will buffer into memory before responding `413 Payload Too Large`; it defaults
to 1 MiB (1,048,576 bytes) and can be overridden via the `MAX_REQUEST_BODY_BYTES`
env var when using the default `src/index.ts` entrypoint.

## Known limitations (v0.2)

- **Single-process budget.** N replicas enforce N × budget. Divide by replica
  count manually until the distributed ledger lands.
- **SSE parsing is unverified against live APIs.** The `message_start`/
  `message_delta` usage shapes in `src/sse.ts` (Anthropic) and the
  `chat.completion.chunk` usage shape in `src/sse-openai.ts` (OpenAI) are
  based on documented formats; confirm against the current provider APIs
  before relying on mid-stream refunds in production. If a shape is wrong,
  streams still proxy correctly — only the mid-stream refund is missed, and
  release-time usage still applies.
- **No format translation.** The gateway does not convert between Anthropic
  and OpenAI wire shapes — each route proxies verbatim to its own upstream.
  A client speaking the OpenAI shape must hit `/v1/chat/completions`, and an
  Anthropic-shaped client must hit `/v1/messages`.
- **No auth, no persistence, no Gemini adapter yet.**
- **`wouldAdmit` / stats are per-process** snapshots.

## Layout

```
src/
  index.ts       entrypoint (env-configured single pool)
  server.ts       HTTP server, proxy, admission, adapter wiring
  pools.ts        model→pool routing + bulkhead construction
  adapters.ts     per-provider request/response/usage translation
  sse.ts          incremental SSE usage extractor (Anthropic)
  sse-openai.ts   incremental SSE usage extractor (OpenAI)
test/
  gateway.test.ts   end-to-end tests against mock upstreams
```
