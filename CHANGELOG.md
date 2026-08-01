# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0, so minor versions may include breaking changes).

## [Unreleased]

## [0.18.0] - 2026-08-01

### Added

- Added automatic Latchflo 0.6 demand snapshots to the existing authenticated
  agent heartbeat. Every managed pool now reports live in-flight and pending
  work, recent admissions and rejections, budget-versus-concurrency rejection
  pressure, and live token usage/headroom when a token budget is configured.
- Added `TyrDemandReporter`, which derives bounded heartbeat deltas from Tyr's
  existing pool statistics without adding work to the provider request path.
- Added executable and unit regression coverage for live demand, token pressure,
  accepted-heartbeat checkpoints, transient heartbeat failures, and automatic
  managed-mode wiring.

### Changed

- The first managed heartbeat is now scheduled immediately after the initial
  desired-state poll. Later heartbeats continue using Latchflo's advertised
  cadence with jitter, reducing the time before an idle pool can safely lend
  its protected floor.
- Demand counters advance only after Latchflo accepts the heartbeat. A failed
  or timed-out heartbeat therefore cannot erase admission or rejection pressure;
  the next successful attempt includes all activity since the last accepted
  report.
- Updated the Prometheus build-info version and managed-mode examples to 0.18.0.

### Compatibility

- Tyr 0.18.0 remains compatible with Latchflo 0.5.x. Older control planes ignore
  the heartbeat body and continue lease management normally.
- Latchflo 0.6.0 consumes the new snapshots to support demand-aware,
  work-conserving capacity groups, idle-floor lending, starvation prevention,
  and lease-safe floor restoration. Latchflo still owns all grant allocation
  and fencing decisions; Tyr only reports local demand.
- `oldestPendingMs` is intentionally omitted because Tyr's current bulkhead
  statistics expose queue depth but not waiter age. Latchflo's continuous-demand
  state still provides starvation aging across heartbeats.

## [0.17.0] - 2026-08-01

### Added

- Added optional request-specific capacity-aware routing across statically
  configured Tyr replicas. The ingress replica ranks fresh, ready candidates
  by the concurrency and priority-adjusted token headroom that would remain
  after admitting the exact immutable reservation.
- Added the shared-secret-protected `GET /_tyr/capacity` endpoint and
  asynchronous peer snapshot polling with bounded probe deadlines, stale-peer
  exclusion, single-flight refreshes, and strict snapshot validation.
- Added authenticated one-hop Tyr-to-Tyr forwarding. Routed requests cannot be
  routed again, and successful responses identify the ingress and serving
  replica through `x-tyr-routed-by` and `x-tyr-routed-to`.
- Added `routing.capacityAware` YAML and JSON Schema configuration, with the
  shared secret loaded from an environment variable instead of stored in the
  configuration file.
- Added unit, configuration, gateway, and executable integration regression
  coverage for request-specific selection, high-priority token reserves, local
  tie preference, protected snapshots, remote admission, and spoofed routing
  headers.

### Changed

- External provider requests may now be forwarded before local admission when a
  fresh peer snapshot predicts more usable capacity. The destination Tyr still
  performs the authoritative reservation and admission decision, so stale
  routing information cannot create capacity or bypass a Latchflo grant.
- Observe-mode pools stay local and cannot be selected as remote destinations.
  Tyr also refuses to route between token-aware and token-unaware definitions
  of the same pool name.
- A request is never retried automatically after it has been dispatched to a
  peer. A peer timeout or transport failure returns a bounded `502` or `504`
  response instead of risking a duplicate provider invocation.

### Security

- Requests carrying incomplete or unauthenticated internal-routing headers are
  rejected before Tyr buffers the body. Capacity snapshots and forwarding use
  a constant-time shared-secret check, refuse peer redirects, and must be
  deployed on a trusted private network or over TLS.

### Notes

- Peer membership is static startup configuration in this release. Latchflo is
  unchanged in v0.17.0 and may distribute routing topology in a later release.
- Capacity snapshots are advisory and intentionally short-lived. Concurrent
  arrivals can consume capacity after selection; the destination's normal
  fail-fast admission response remains authoritative.

## [0.16.0] - 2026-07-31

### Added

- Added `Retry-After` on capacity rejections. Tyr now estimates when the pool
  will have room and tells the caller, instead of leaving it to guess with
  blind exponential backoff. Emitted for `concurrency_limit`, `queue_limit`,
  `budget_limit`, and `timeout`.
- Added `x-admission-retry-after-ms` alongside it, carrying the precise wait.
  This is the header to prefer. `Retry-After` has one-second resolution, and
  most capacity waits under load are shorter than that.
- Added the `retryHint` configuration block (`enabled`, `minMs`, `maxMs`,
  `halfLifeMs`, `minSamples`) and the `TYR_RETRY_HINT_ENABLED` environment
  override.

### Changed

- **Behavioral change on upgrade.** A client that already honors `Retry-After`
  will change its retry timing against Tyr on waits of a second or more.
  Shorter waits deliberately carry no `Retry-After` at all: rounding a 200ms
  wait up to `Retry-After: 1` would park a compliant client five times longer
  than necessary, which is worse advice than the backoff it would have chosen
  itself. Those rejections carry only `x-admission-retry-after-ms`, so a client
  that reads neither header behaves exactly as it did before. Set
  `retryHint.enabled: false` to suppress both.

### Notes

- The estimate is derived from observed upstream completion intervals per pool,
  held as a time-decayed moving average. Until a pool has produced
  `minSamples` completions, no header is emitted at all — a missing header is
  an honest "unknown", which is why `async-bulkhead-llm` continues to expose
  capacity counters and no ETA of its own. The library cannot see how long work
  takes; Tyr can, because it proxies it.

### Fixed

- Corrected the client-facing error contract table to include `401` identity
  failures, `403` authorization failures, and both distinct `503` contracts:
  retryable `identity_unavailable` verifier outages and shutdown admission
  rejection.

## [0.15.1] - 2026-07-29

### Fixed

- Distinguished caller-owned credential failures from identity-verifier
  infrastructure failures. Missing, malformed, expired, incorrectly scoped,
  or cryptographically invalid JWTs continue to return `401`; JWKS network,
  timeout, HTTP, size, parsing, and unusable-key-set failures now return
  `503 identity_unavailable` without a `WWW-Authenticate` challenge.
- Preserved fail-closed cold-cache behavior while allowing clients and proxies
  to retry transient identity-provider outages correctly. A valid warm-cache
  key continues serving until its configured cache TTL expires.
- Classified untyped exceptions from custom identity authenticators as
  `503 identity_unavailable`; custom authenticators must throw an explicit
  `TyrIdentityError` for `401` or `403` caller failures.

## [0.15.0] - 2026-07-29

### Added

- Added immutable authenticated request identity with subject, optional tenant
  and application IDs, and bounded roles.
- Added configurable RS256/RS384/RS512 JWT verification against cached JWKS,
  including issuer, audience, expiration, not-before, issued-at, key-ID,
  algorithm, token-size, JWKS-size, timeout, and rotation validation.
- Added versioned YAML and JSON Schema configuration under `identity.jwt` and
  `identity.roles`. The default `x-tyr-identity-token` header keeps identity
  credentials separate from provider `Authorization` headers.
- Added any-of role authorization for provider invocation and operator
  endpoints, plus role-based access to high-priority token reserves.
- Added programmatic identity APIs and passed verified identity to
  `GatewayOptions.resolvePriority(req, identity)`.
- Added regression coverage for JWT validation, JWKS rotation, pre-body
  authentication, role authorization, role priority, operator access, and audit
  attribution.

### Changed

- Provider requests authenticate and authorize before Tyr buffers or parses the
  request body.
- When first-class identity is configured, verified role policy takes
  precedence and raw `x-priority` is ignored. The legacy trusted-header path is
  retained for deployments without first-class identity.
- Structured admission audit events now use `tyr.admission-audit.v2` and include
  authenticated identity on admitted, observe-bypassed, and rejected decisions.
  Identity fields are not added to Prometheus labels.
- `/stats` and `/metrics` can now be authorized by an authenticated operator
  role; `TYR_OPERATOR_BEARER_TOKEN` remains available as an alternative.

## [0.14.0] - 2026-07-28

### Added

- Added native Prometheus exposition at `GET /metrics` with bounded dimensions
  for admission decisions, rejection reasons, gateway outcomes, upstream status
  classes, request/upstream duration histograms, pool limits and utilization,
  token reservation/reconciliation, readiness, grant expiration, controller
  epoch, audit failures, and Latchflo integration failures.
- Added optional structured `tyr.admission-audit.v1` JSON events for admitted,
  observe-bypassed, and rejected decisions. Completed admissions include final
  provider usage when available and exact grant provenance without placing
  request, admission, model, or grant identifiers into metric labels.
- Added `TYR_OPERATOR_BEARER_TOKEN` protection for `/stats` and `/metrics` while
  leaving `/healthz` and `/readyz` available to orchestrators.
- Added versioned file configuration for `telemetry.metrics.enabled` and
  `telemetry.audit.enabled`, plus environment overrides.
- Added a local Docker Compose demonstration with a mock provider, Prometheus,
  provisioned Grafana datasource/dashboard, and normal/overload load scripts.
- Added regression coverage for metric exposition, cardinality boundaries,
  audit settlement and usage, rejected-decision audit, endpoint protection, and
  telemetry configuration.

### Changed

- `createGateway()` now also returns its `telemetry` collector so the built-in
  Latchflo managed mode can report bounded integration-failure counters.
- Client disconnect, client-stall, response-timeout, idle-timeout, and upstream
  error paths now produce explicit request and audit outcomes without changing
  their existing admission or response semantics.


## [0.13.0] - 2026-07-26

### Added

- Added first-class `controlPlane.type: latchflo` file configuration with
  instance identity, managed pool selection, metadata, retry cadence, bootstrap
  credential environment lookup, and persisted rotated agent tokens.
- Added a built-in Latchflo agent that registers, polls desired state, applies
  complete higher-revision limit batches, acknowledges grants, and preserves
  exact grant provenance for admission and rejection telemetry.
- Added `/readyz`; it returns `503 control_plane_not_ready` until all managed
  pools hold valid, unexpired grants while `/healthz` continues to report
  process liveness.
- Added single-flight startup and background retry behavior with request deadlines,
  bounded exponential backoff, jitter, and `Retry-After` support so Tyr remains
  observable without synchronizing a fleet against an unavailable control plane.
- Added atomic owner-only agent-token persistence and graceful agent shutdown.
- Added configuration, readiness, provenance, expiration, and credential
  persistence tests.

### Changed

- The built-in agent emits `source: "latchflo"`. Tyr continues accepting the
  deprecated `"korrx"` source and emitting deprecated `x-korrx-*` aliases.
- Managed operation no longer requires installing the control-plane package
  into Tyr or editing `src/index.ts`.
- Upgraded `async-bulkhead-llm` to 3.12.0. Latchflo-managed pools are now
  required to start at zero concurrency, zero queue capacity, revision zero,
  and enforcement mode so startup is fail closed before the first grant.
- Desired-state ingestion now validates response structure, instance identity,
  managed pools, duplicate grants, controller epochs, revisions, timestamps,
  expiration ordering, and token-budget relationships before applying limits.
- Valid leases remain ready through transient desired-state poll failures until
  their expiration deadline. Persisted credentials are refreshed through a
  serialized bootstrap registration after a `401`. Grant acknowledgements are
  best-effort and cannot interrupt local expiration scheduling after a grant is
  applied; permanent configuration, authentication, and protocol failures are not
  retried continuously.

## [0.12.0] - 2026-07-25

### Added

- Accepted `source: "latchflo"` on immutable admission provenance alongside the
  existing `source: "korrx"`. Both are valid; `"korrx"` is retained for the
  Latchflo rebrand transition.
- Added `x-latchflo-grant-id` and `x-latchflo-controller-epoch` response
  headers, emitted alongside the existing `x-korrx-*` pair with identical
  values.
- Added coverage that both provenance sources are accepted and that both header
  pairs are emitted on admitted, observe-bypassed, and rejected responses.

### Changed

- `AdmissionProvenance.source` is now the exported `AdmissionProvenanceSource`
  union rather than the `"korrx"` literal. Consumers annotating provenance
  objects with the literal type continue to compile.
- The provenance rejection message now reads
  `provenance.source must be "korrx" or "latchflo"`. Callers matching the old
  message as a substring are unaffected; exact-string matchers must update.

### Deprecated

- `x-korrx-grant-id` and `x-korrx-controller-epoch` are deprecated aliases.
  They will be removed in a future release once no consumer reads them.
- `source: "korrx"` is deprecated. It will be rejected in a future release once
  every control plane in the fleet emits `"latchflo"`.

### Notes

This release is intentionally backward compatible rather than a rename. Tyr and
the control plane are deployed independently, and a provenance mismatch throws
out of `applyLimits` instead of returning a rejection, so the agent never acks,
readiness goes stale, and the expiration kill switch drives pool capacity to
zero. A hard cutover therefore sheds live traffic in either deploy order --
the same failure mode recorded under 0.11.1, when Korrx emitted
`source: "korrx"` while Tyr still required `source: "zab"`. Accepting both
values removes the ordering constraint entirely.

Recommended rollout:

1. Deploy Tyr 0.12.0 everywhere. No control-plane change required.
2. Migrate control planes to emit `source: "latchflo"`, at whatever pace.
3. Migrate any consumer reading `x-korrx-*` to the `x-latchflo-*` pair.
4. Only once 2 and 3 are complete fleet-wide, drop the legacy value and headers
   in a follow-up release.


## [0.11.1] - 2026-07-25

### Changed

- Renamed the external admission-provenance namespace from Zab to Korrx so
  Tyr accepts the provenance objects emitted by `korrx-control-plane` 0.2.0.
- Renamed grant-attribution response headers to `x-korrx-grant-id` and
  `x-korrx-controller-epoch`.
- Updated the runtime-control example and operator documentation to use the
  Korrx integration contract consistently.

### Fixed

- Fixed the Tyr/Korrx integration blocker where Korrx emitted
  `source: "korrx"` but Tyr required `source: "zab"`.
- Added regression coverage for admitted, observe-bypassed, and rejected
  responses, plus validation that the obsolete Zab source is rejected before
  any pool is mutated.

## [0.11.0] - 2026-07-24

### Added

- Added optional immutable Zab provenance to each transactional pool update:
  grant ID, controller epoch, exact revision, and expiration timestamp.
- Added a bounded per-pool revision-to-provenance ledger and exposed the
  current record through `/stats`.
- Added `x-zab-grant-id` and `x-zab-controller-epoch` to admitted, bypassed,
  and rejected responses whenever the decision revision has Zab provenance.
- Added race coverage proving that a request admitted under grant A continues
  to report grant A after grant B is applied, while the next request reports B.

### Changed

- Upgraded and pinned `async-bulkhead-llm` to 3.11.0.
- Tyr now uses the library's admission-linearized `limitRevision` directly
  instead of reading `bulkhead.limits()` after admission.

### Fixed

- Prevented an in-flight request from being attributed to a newer control-plane
  revision that was applied after its capacity had already been acquired.

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

### Fixed

- Added the missing ESLint flat configuration, `lint` / `lint:fix` scripts,
  dependency lock entries, and a required CI lint step.
- Added lint to `release:check` and documented the lint commands in the README.
- Preserved the original `cause` when configuration file reads or YAML
  conversion fail, and removed an unused test import found by linting.
- Corrected the concurrency scale-up test to hold both admitted operations open
  while asserting two in-flight requests and no pending waiter.

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

[Unreleased]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.15.1...v0.16.0
[0.7.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/janbalangue/tyr-admission-controller/releases/tag/v0.2.0
[0.1.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/72236af...96e0097
