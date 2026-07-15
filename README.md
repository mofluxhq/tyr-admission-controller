# admission-gateway (private)

An **admission-first** AI gateway. Unlike gateways that do windowed rate
limiting and after-the-fact spend tracking, this one enforces a true in-flight
**token-budget ceiling** at admission: every request reserves its estimated
input + `max_tokens` before it runs, refunds the surplus as real usage arrives
(including mid-stream), and **fails fast** the moment the ceiling is hit — no
retry storms, no queue collapse.

Built on [`async-bulkhead-llm`](https://www.npmjs.com/package/async-bulkhead-llm)
(≥ 3.2.0), which provides the reserve → report → refund → release lifecycle,
priority admission, and rejection detail.

> **Status:** v0.1, single-process. Cluster-wide budget coordination is
> designed but not implemented — see `DESIGN-distributed-token-budget.md`.
> **Private / UNLICENSED.** Not for redistribution.

## What it does

- **Proxies** `POST /v1/messages` to an upstream provider (Anthropic-shaped by
  default), passing auth headers through verbatim. The gateway holds no
  provider keys in v0.
- **Admits** each request against a model-routed pool with a fail-fast token
  budget and concurrency limit.
- **Reports usage mid-stream** by parsing SSE `message_start` / `message_delta`
  events, so a long-running stream's budget hold is corrected live.
- **Rejects** with `429`/`503`/`504` plus an `x-admission-reason` header and a
  JSON `detail` capacity snapshot — no fabricated `Retry-After`.
- **Routes** by longest model-prefix match across pools.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Admission-gated proxy to the upstream |
| GET | `/stats` | Per-pool live stats (budget, slots, refunds) |
| GET | `/healthz` | Liveness |

Request headers: `x-priority: high` opts a request into the high-priority
budget tier (see `highPriorityReserve`). Provider auth headers
(`x-api-key`, `authorization`, `anthropic-version`, …) are forwarded as-is.

## Run

```bash
npm install
npm test          # 6 tests, mock upstream, no network
npm run build
UPSTREAM_URL=https://api.anthropic.com \
TOKEN_BUDGET=500000 MAX_CONCURRENT=50 \
npm start
```

See `.env.example` for configuration.

## Configuration

`src/index.ts` wires a single "default" pool from env vars for convenience.
For real deployments, define pools explicitly in code — one pool per model (or
model family) is the intended pattern, since the token estimator is
model-aware:

```ts
createGateway({
  upstreamUrl: "https://api.anthropic.com",
  pools: [
    { name: "sonnet", modelPrefixes: ["claude-sonnet-4"], model: "claude-sonnet-4-5",
      maxConcurrent: 40, budget: 400_000, highPriorityReserve: 80_000 },
    { name: "haiku",  modelPrefixes: ["claude-haiku-4"],  model: "claude-haiku-4-5",
      maxConcurrent: 80, budget: 200_000 },
  ],
});
```

## Known limitations (v0)

- **Single-process budget.** N replicas enforce N × budget. Divide by replica
  count manually until the distributed ledger lands.
- **SSE parsing is Anthropic-shaped and unverified against the live API.** The
  `message_start`/`message_delta` usage shapes in `src/sse.ts` are based on
  documented formats; confirm against the current provider API before relying
  on mid-stream refunds in production. If the shape is wrong, streams still
  proxy correctly — only the mid-stream refund is missed, and release-time
  usage still applies.
- **No auth, no persistence, no OpenAI/Gemini adapters yet.** v0 is
  Anthropic-passthrough only.
- **`wouldAdmit` / stats are per-process** snapshots.

## Layout

```
src/
  index.ts    entrypoint (env-configured single pool)
  server.ts   HTTP server, proxy, admission, SSE wiring
  pools.ts    model→pool routing + bulkhead construction
  sse.ts      incremental SSE usage extractor
test/
  gateway.test.ts   end-to-end tests against a mock upstream
```
