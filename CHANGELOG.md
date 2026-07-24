# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0, so minor versions may include breaking changes).

## [Unreleased]

## [0.10.0] - 2026-07-23

### Added

- Added complete versioned per-pool admission-limit snapshots covering
  `maxConcurrent`, `maxQueue`, token budget, and high-priority reserve.
- Added `limitsRevision`, `maxQueue`, and `queueTimeoutMs` startup
  configuration, plus legacy environment equivalents.
- Added a narrow `control` interface from `createGateway()` with
  `limits()`, `stats()`, and Tyr-local transactional `applyLimits()` methods.
- Added all-or-nothing multi-pool preflight for unknown pools, duplicate pool
  entries, invalid snapshots, and stale revisions.
- Added `x-admission-preview-revision`, `x-admission-revision`,
  `x-admission-outcome`, and `x-admission-bypass-reason` response headers.
- Added v3.10 integration tests for kill switches, stale-update rejection,
  snapshot-once behavior, native observe context, and immediate scale-up of
  accepted waiters.

### Changed

- Upgraded and pinned `async-bulkhead-llm` from 3.8.0 to exactly 3.10.0.
- Replaced Tyr's hand-built observe-mode bypass path with the library's native
  v3.10 observe execution, bypass accounting, and bypass release usage events.
- Replaced the exposed bulkhead handle with a narrow per-pool controller for
  reading and applying complete limit snapshots.
- Runtime limit decreases now inherit v3.10 shrink-by-attrition semantics;
  existing work is not cancelled. Raising concurrency pumps accepted waiters
  after the complete snapshot is installed.
- `maxConcurrent: 0` is supported at runtime as a fail-fast per-pool kill
  switch, while startup configuration still requires a positive initial value.
- Corrected CI to run the existing typecheck command and verify Tyr's actual
  flat ESM/declaration tarball layout.

### Removed

- Removed the duplicated `pools-v38.test.ts` suite and replaced it with focused
  v3.10 coverage.

## [0.9.0] - 2026-07-21

### Added

- Added per-pool `admissionMode: enforce | observe`. Observe mode records the
  same detailed capacity decision as enforcement while proxying capacity
  rejections upstream with a synthetic `shadow-...` admission ID.
- Added adaptive per-model input estimation backed by
  `createAdaptiveTokenEstimator`, enabled by default for budgeted pools and
  configurable through `adaptiveEstimation` / legacy environment variables.
- Added v3.8 advisory response headers: `x-admission-mode`,
  `x-admission-preview`, `x-admission-preview-reason`, and
  `x-admission-reserved-tokens`.
- Added per-pool Tyr policy telemetry under `/stats`, including advisory
  decisions, shadow bypasses, race bypasses, and adaptive correction snapshots.
- Added bounded shutdown configuration through `shutdown.drainTimeoutMs` and
  `SHUTDOWN_DRAIN_TIMEOUT_MS`, returning per-pool outstanding-work snapshots.
- Added focused v3.8 tests for exact reservation reuse, detailed previews,
  shadow execution, adaptive calibration, shutdown safety, and bounded drain.

### Changed

- Upgraded and pinned `async-bulkhead-llm` to exactly 3.8.0.
- Re-architected pool handling into a policy runtime that owns preparation,
  advisory decisions, enforcement/observation, calibration, statistics, and
  drain behavior. The HTTP server no longer calls bulkhead primitives directly.
- The complete immutable object returned by `bulkhead.estimate()` is now passed
  verbatim to both `wouldAdmit()` and authoritative admission, including the
  v3.8 `reserved` consistency check.
- Shutdown now closes remaining HTTP connections when a configured bounded drain
  expires instead of waiting indefinitely on stalled work.


## [0.8.0] - 2026-07-20

### Added

- Successful admitted responses now include `x-admission-id`, exposing
  `async-bulkhead-llm`'s stable UUID for correlation across client logs,
  gateway traces, streaming usage updates, and release events.
- Added per-pool `opaqueMediaInputTokenReservation` and legacy
  `OPAQUE_MEDIA_INPUT_TOKENS` configuration. The default remains a conservative
  2,048-token surcharge per opaque media/document block; `0` disables it.

### Changed

- Upgraded `async-bulkhead-llm` from 3.6.0 to 3.7.0.
- Admission projection now uses v3.7's first-class `system`,
  `extraInputTokens`, and `opaqueBlockTokens` surfaces instead of a hidden
  symbol and a synthetic JSON user message.
- Tyr now computes one exact reservation preview and supplies it through the
  v3.7 per-call reservation override, ensuring the preview and actual admission
  use the same immutable token estimate.
- Removed an accidentally pasted assistant transcript from the beginning of
  `README.md` and updated the documentation for the 3.7 integration.

## [0.7.0] - 2026-07-19

### Added

- Added versioned, startup-only YAML configuration selected with
  `TYR_CONFIG_FILE`, including strict unknown-field validation, multi-pool
  routing, deterministic rejection of mixed file/environment configuration,
  and a safe configuration fingerprint in startup logs.
- Added `tyr validate --config <path>` / `npm run validate:config` for offline
  validation without opening a listener.
- Added `config/tyr.example.yaml`, a JSON Schema, focused configuration tests,
  a production Dockerfile, and a file-mounted Compose example.

### Changed

- Legacy environment configuration remains supported as a single-pool fallback,
  while new deployments can use one standard image with customer-specific
  read-only configuration files.
- The process banner now identifies the service as `tyr-admission-controller`.

## [0.6.1] - 2026-07-19

### Security

- Client-supplied `x-priority: high` is no longer trusted by default.
  High-priority admission can be derived with `GatewayOptions.resolvePriority`,
  or raw header trust can be explicitly enabled with
  `trustPriorityHeader` / `TRUST_X_PRIORITY_HEADER=true` only behind a trusted
  proxy. This prevents unauthenticated callers from self-assigning reserved
  capacity.

### Fixed

- Admission estimates now include provider-specific prompt material that was
  previously forwarded upstream without consuming budget: Anthropic `system`,
  `tools`, and `tool_choice`; OpenAI tool/function schemas and calls,
  `response_format`, `prediction`, and null-content assistant/tool turns.
  Opaque image, audio, document, file, and video blocks now receive a
  conservative 2,048-token minimum surcharge while inline binary data is
  omitted from literal text estimation.
- Startup configuration now fails before listening when URLs, ports, numeric
  ranges, pool names, model prefixes, duplicate names/prefixes, budgets, or
  priority reserves are invalid. Environment parsing no longer accepts `NaN`,
  fractional, negative, or out-of-range values silently.
- `npm start` is compatible with the declared Node.js 20+ engine: it builds and
  starts `dist/index.js` instead of using Node's experimental TypeScript
  stripping on `src/index.ts`. The process banner now says `tyr-gateway`.

### Changed

- Documentation now describes the token budget accurately as an admission-time
  ceiling. Reported usage overruns can temporarily raise the active hold above
  the configured budget; the gateway blocks new admissions but does not abort
  the already-running request.
- Added `npm run smoke` and `npm run release:check`; CI now imports the built
  runtime on every supported Node version.
- Completed the project rename and upgraded `async-bulkhead-llm` from 3.4.1 to
  3.5.0.

## [0.6.0] - 2026-07-18

### Fixed

- **Requests are now validated before admission.** Previously, the JSON
  body was cast to `Record<string, unknown>` without checking it was
  actually a non-array object, and `toMessages()` accepted any array
  without validating its elements. This let malformed client input reach
  the bulkhead and surface as an infrastructure failure rather than a
  client error:
  - A body of `null` (or any non-object JSON value) returned `500
    internal` instead of `400`.
  - `max_tokens: -1` (or any negative/non-integer/oversized output limit)
    was forwarded upstream and came back as `502 upstream_error`.
  - A message without `content` threw `content is not iterable` deep in
    the adapter, surfacing as `502 upstream_error`.

  Each provider adapter (`src/adapters.ts`) now exposes a `validate()`
  that checks, before the bulkhead ever sees the request: the top-level
  JSON value is a non-array object; `model` is a non-empty string;
  `messages` is an array of valid `{ role, content }` entries (string or
  content-block array content, valid roles); output-limit fields
  (`max_tokens` / `max_completion_tokens`) are non-negative safe integers
  below a configured ceiling (`maxOutputTokens`, default 200,000, see
  `GatewayOptions.maxOutputTokens` / `MAX_OUTPUT_TOKENS`); Anthropic-
  required (`max_tokens`) and OpenAI-required fields are present; and
  `stream`, `stream_options`, `tools`, `system`, and multimodal content
  blocks have valid shapes when present. Shared shape-checking helpers
  live in the new `src/validation.ts`. Invalid client input now returns
  `400` with `error.type: "invalid_request"` and an `errors` array
  describing every problem found — never `500` or `502`.

- **An unsupported `model` now returns `422`, not `404`.** The route
  exists and the request body is well-formed; it simply doesn't match any
  configured pool. `error.type` is now `"unsupported_model"`.

- **Route matching now compares the request's pathname, not its complete
  raw URL.** Previously `/v1/messages?x=1` incorrectly 404'd because the
  router compared `req.url` verbatim against `"/v1/messages"`. Routing now
  parses `new URL(req.url, base).pathname` for matching, so query strings
  no longer affect routing.

## [0.5.0] - 2026-07-17


### Added

- `PoolConfig.budget` is now documented as tri-state: omitted (unlimited,
  token-aware admission disabled), `0` (a legal "admit nothing" pool — every
  budget-gated request is rejected with `429`/`budget_limit`), or `N > 0`
  (the in-flight token ceiling). Previously only the omitted/positive states
  were documented. `budget: 0` used to throw at construction under
  `async-bulkhead-llm@3.2.0`; the currently pinned `3.3.1` makes it a valid
  construction that simply never admits, which the gateway now allows
  intentionally (useful for taking a pool out of rotation without deleting
  it from config) rather than treating as a footgun to reject. Added a test
  pinning that a `budget: 0` pool constructs successfully and returns `429`
  for every request rather than crashing.

## [0.4.1] - 2026-07-16


### Fixed

- Non-streaming proxy responses now send an explicit `content-length`
  header instead of relying on Node's chunked-transfer-encoding fallback.
  Previously, a client pipelining multiple requests on a single keep-alive
  connection (or any client relying on `content-length` for response
  framing) could misparse where one response ends and the next begins.
  This also fixes a latent issue where the documented graceful-shutdown
  `503`/`x-admission-reason: shutdown` response would send `Connection:
  close`, causing the socket to close promptly at that point — see next
  item.
- Graceful shutdown now resolves promptly: a `503`/`shutdown` admission
  rejection sends `Connection: close`, so the connection it arrived on
  closes immediately instead of idling out on Node's keep-alive timer.
  Previously, `shutdown()` would not resolve until every connection —
  including ones that had already received a final "shutdown" rejection —
  had gone fully idle and timed out, needlessly delaying process exit.

## [0.4.0] - 2026-07-16

### Changed
`
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

[Unreleased]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/janbalangue/tyr-admission-controller/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/janbalangue/tyr-admission-controller/releases/tag/v0.2.0
[0.1.0]: https://github.com/janbalangue/tyr-admission-controller/compare/72236af...96e0097
