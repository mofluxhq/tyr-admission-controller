# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0, so minor versions may include breaking changes).

## [Unreleased]

## [0.4.0] - 2026-07-16

### Changed

- **Breaking:** `upstreamTimeoutMs` replaced by two distinct timeouts:

  - `responseTimeoutMs` bounds how long the upstream may take to send
    response headers (i.e. for `fetch()` to resolve). Cancelled the instant
    headers arrive — it does not bound how long a streaming body may
    subsequently run.
  - `idleTimeoutMs` bounds the gap between consecutive chunks of a streaming
    response body. It resets on every chunk received, so a healthy
    long-running stream that keeps sending data — no matter its total
    duration — is never killed, while a stream that stalls mid-flight is
    aborted once the gap exceeds the limit.

  Previously, a single `upstreamTimeoutMs` bounded the entire upstream call
  end-to-end, which meant a perfectly healthy long-running stream could be
  killed simply for taking a long time overall. The env vars
  `RESPONSE_TIMEOUT_MS` and `IDLE_TIMEOUT_MS` replace `UPSTREAM_TIMEOUT_MS`
  in the default `src/index.ts` entrypoint. A response-timeout expiry
  returns `504` with `error.type: "response_timeout"`; an idle-timeout
  expiry either returns `504` with `error.type: "idle_timeout"` (if headers
  were not yet sent) or terminates the connection outright (if the stream
  had already started, since a clean JSON error can no longer be sent at
  that point).

### Added

- Streaming backpressure: the proxy loop now honors `res.write()`'s return
  value and pauses pulling further chunks from the upstream body until the
  client's write buffer drains (or the connection closes). Previously, a
  fast upstream stream paired with a slow-reading client would let Node
  buffer the entire response in memory with no upper bound; now the
  gateway's own memory usage for a stream stays bounded by the client's
  actual consumption rate.
- Graceful shutdown: `createGateway()` now returns a `shutdown()` function
  that stops the HTTP server from accepting new connections and calls the

  new `Pools.drain()` (backed by `async-bulkhead-llm`'s `bulkhead.drain()`)
  to let in-flight requests finish before resolving. New admissions during
  drain are rejected with `503` and `x-admission-reason: shutdown` (already
  supported by the existing rejection mapping). The default `src/index.ts`
  entrypoint now listens for `SIGTERM`/`SIGINT` and invokes `shutdown()`
  before exiting.


## [0.3.0] - 2026-07-16


### Added

- CI workflow now auto-creates a GitHub release on version tag push.
- `maxRequestBodyBytes` gateway option (default 1 MiB) that caps how many
  bytes of an incoming request body are buffered before the gateway responds
  `413 Payload Too Large`. Configurable via `MAX_REQUEST_BODY_BYTES` in the
  default env-configured entrypoint. Previously request bodies were buffered
  with no upper bound, allowing unbounded memory growth from oversized or
  malicious payloads.

## [0.2.0] - 2026-07-16

### Added

- OpenAI-compatible endpoint: `POST /v1/chat/completions`, proxied verbatim to
  `OPENAI_UPSTREAM_URL`. Shares pool/bulkhead admission machinery with the
  existing Anthropic route, so a single pool can serve models from either
  provider.
- Incremental SSE usage extraction for OpenAI streams (`src/sse-openai.ts`),
  reading cumulative `usage` from the final `chat.completion.chunk` when the
  client sets `stream_options: { include_usage: true }`.
- `openaiUpstreamUrl` gateway option — both `upstreamUrl` and
  `openaiUpstreamUrl` are optional, allowing Anthropic-only, OpenAI-only, or
  combined deployments. A route with no configured upstream returns `404`.

### Changed

- Project renamed from its initial scaffold name to **torii-gateway**.

## [0.1.0] - 2026-07-15

### Added

- Initial scaffold: admission-first AI gateway built on
  [`async-bulkhead-llm@3.2.0`](https://www.npmjs.com/package/async-bulkhead-llm).
- `POST /v1/messages` admission-gated proxy to an Anthropic-shaped upstream,
  forwarding auth headers (`x-api-key`, `authorization`, `anthropic-version`,
  `anthropic-beta`) verbatim. The gateway holds no provider keys.
- Fail-fast token-budget admission control: every request reserves its
  estimated input + `max_tokens` before running, refunds the surplus as real
  usage arrives (including mid-stream), and rejects immediately once the
  ceiling is hit.
- Mid-stream usage reporting via incremental SSE parsing (`src/sse.ts`),
  reading Anthropic `message_start` / `message_delta` events to correct a
  long-running stream's budget hold live.
- Model-prefix routing across pools (longest-prefix match), with per-pool
  concurrency limits and an optional high-priority reserve tier via the
  `x-priority: high` request header.
- `GET /stats` for per-pool live stats (budget, slots, refunds) and
  `GET /healthz` for liveness.
- `429` / `503` / `504` rejection responses with an `x-admission-reason`
  header and a JSON `detail` capacity snapshot — no fabricated `Retry-After`.
- End-to-end test suite (`test/gateway.test.ts`) against mock upstreams.

### Fixed

- Test/build configuration: excluded `dist` from the test glob and scoped the
  build output to `src` only.

[Unreleased]: https://github.com/janbalangue/torii-gateway/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/janbalangue/torii-gateway/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/janbalangue/torii-gateway/compare/v0.2.0...v0.3.0

[0.2.0]: https://github.com/janbalangue/torii-gateway/releases/tag/v0.2.0
[0.1.0]: https://github.com/janbalangue/torii-gateway/compare/72236af...96e0097
