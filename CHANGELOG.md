# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0, so minor versions may include breaking changes).

## [Unreleased]

## [0.30.0] - 2026-09-03

### Added

- Added optional per-class `borrowedAdmissionSlot` policy with the explicit
  `deadline_abandonment` release mechanism and a bounded post-admission
  `deadlineMs`.
- Added exact concurrency/token borrowing attribution to admission contexts,
  successful-admission provenance, response headers, and audit events.
- Added `504 borrowed_admission_deadline` responses that state the released
  local resource, cancellation request, deadline, and unverified upstream
  reclamation status.
- Added resource-specific restoration state to `/stats` and bounded Prometheus
  series for local slot releases, upstream cancellation requests, unsettled
  admitted work, and per-class borrowed-slot deadline counts.
- Added `tyr.restoration.admissionSlots.releasedByCause`, splitting early slot
  returns into `deadline` (expired lease) and `manual` (explicit
  `abandonBorrowedConcurrency()`), so a lease configured too tight is
  distinguishable from deliberate shedding.
- Added `verify:borrowed-restoration` and integration coverage for split local
  slot/token release, protected-class admission after restoration, drain, HTTP,
  audit, metrics, and invalid policy rejection.
- Added the additive Latchflo registration capability
  `borrowedAdmissionSlotDeadlines: true`.
- Added `verify:vendor-provenance`, an online CI check that each vendored
  tarball is the artifact npm published for that exact `name@version`. The
  existing offline `verify:vendor` compares a tarball to its lockfile entry,
  and the two can be regenerated together from a local `npm pack`, so it
  cannot detect a pre-release build claiming a released version.

### Changed

- Updated the exact vendored runtime dependency from
  `async-bulkhead-llm@3.16.0` to `async-bulkhead-llm@3.17.0`.
- Scoped the upstream cancellation-request count and
  `tyr_pool_borrowed_admission_slot_deadlines_total` to deadline expiries.
  Only an expired lease aborts the callback signal, so a manual abandonment is
  no longer reported as a cancellation request. The local-slot release series
  still counts every early return, and the per-class counter keeps counting
  every early return because upstream exposes no per-class cause split.
- Kept Tyr-only deadline policy fixed in local configuration while Latchflo
  continues to replace numeric admission-class grants atomically.

### Fixed

- Re-vendored all three runtime tarballs from the npm registry so each is
  byte-identical to its published release. The previously committed
  `async-bulkhead-llm@3.17.0` tarball was a pre-release build missing the
  published release's `cause` split on borrowed-slot abandonment; the
  `async-bulkhead-ts` and `yaml` tarballs were repacks that differed in
  packaging only.

### Safety

- Deadline expiry returns only borrowed Tyr-local concurrency. The linked
  callback receives an abort signal, while its token reservation remains held
  until local callback settlement.
- No-timeout drain waits for that final settlement after the local slot is
  returned. A callback that never settles can therefore hold unbounded shutdown
  open; `shutdown.drainTimeoutMs` reports it as outstanding and bounds Tyr's
  wait without claiming that upstream execution stopped.
- Upstream cancellation is reported as `unverified`, never as reclaimed
  capacity. Protecting provider account limits, model queues, or accelerators
  still requires an unlent floor or another independently enforceable release
  mechanism.

### Compatibility

- Classes without `borrowedAdmissionSlot` retain non-preemptive drain behavior.
- The new Latchflo capability, provenance fields, headers, audit fields, stats,
  and metrics are additive. Existing provider routes and request wire shapes are
  unchanged.

## [0.29.0] - 2026-08-30

### Added

- Added admission-gated `POST /v1/responses` on the configured OpenAI upstream.
  The route preserves the native Responses wire shape and shares Tyr's existing
  pool selection, identity, admission-class, routing, telemetry, timeout, and
  provider-header forwarding pipeline.
- Added Responses admission projection for string/message-array `input`,
  `instructions`, `max_output_tokens`, request-visible `function` and `custom`
  tools, text/reasoning configuration, and multimodal `input_image` /
  `input_file` blocks.
- Added non-streaming `usage.input_tokens` / `usage.output_tokens` reconciliation
  and semantic SSE usage extraction from Responses lifecycle events such as
  `response.completed`.
- Added `verify:openai-responses` executable coverage for projection, raw request
  passthrough, OpenAI credential headers, non-streaming and streaming usage, and
  conservative hidden-state rejection.

### Safety

- The initial Responses implementation rejects `previous_response_id`,
  server-side `conversation`, stored `prompt` templates, `item_reference`,
  `background: true`, and provider-managed retrieval/computer tools. Those modes
  can add prompt or execution state that is not visible when Tyr must reserve
  capacity before provider invocation; rejecting them avoids presenting an
  under-reserved request as token-safe.

### Documentation

- Updated the README, route/configuration references, examples, container tags,
  roadmap, and verification guide for 0.29.0.
- Corrected stale wording that still described Latchflo 0.8.x as current and
  moved multi-controller coordination hardening behind self-serve evaluation and
  demonstrated deployment demand.

## [0.28.0] - 2026-08-28

### Added

- Added Latchflo 0.13+ `routingTopology` desired-state parsing with strict
  version, member-ID, and routable endpoint validation.
- Added a narrow gateway routing control surface that applies complete topology
  snapshots without exposing request forwarding or admission internals.
- Added `verify:routing-topology`, which exercises the real desired-state parser
  and gateway path for dynamic join, removal, stale-revision rejection, and a
  replacement Tyr joining under a new identity.
- Added managed-mode configuration validation requiring
  `routing.capacityAware.instanceId` to equal `controlPlane.instanceId`.

### Changed

- Capacity-aware routing peers can now be replaced at runtime by a newer complete
  Latchflo topology. The local member is filtered automatically.
- Removed peers and endpoint replacements lose cached capacity immediately; a new
  member or endpoint must publish a fresh authenticated capacity snapshot before
  becoming routable.
- Peer polling now starts and stops as dynamic membership transitions between an
  empty and non-empty peer set.
- Static `routing.capacityAware.peers` remain the startup/fallback topology for
  standalone Tyr and for older Latchflo controllers that omit `routingTopology`.

### Compatibility

- Latchflo remains off the synchronous provider request path; topology arrives on
  the existing desired-state poll.
- The Tyr-to-Tyr routing secret remains local configuration and is never supplied
  by Latchflo.
- Existing static-routing deployments continue to behave as before when no
  `routingTopology` is received.
- Admission policy, upstream request/response semantics,
  `tyr.admission-provenance.v1`, and runtime dependency versions are unchanged
  from 0.27.0.

## [0.27.0] - 2026-08-25

### Added

- Added `tyr_admission_decision_seconds`, sourced directly from
  `async-bulkhead-llm@3.16.0` admission events. It measures synchronous local
  admission-decision work while excluding the awaited local concurrency
  acquire.
- Added `tyr_admission_queue_wait_seconds` for that concurrency-acquire wait.
  Both histograms use bounded `pool`, `outcome` (`admitted`/`rejected`), and
  `admission_class` labels; model/request/identity dimensions remain excluded.
- Added 5 µs through 50 ms decision-duration buckets for distribution
  diagnostics. Queue-wait timing reuses the existing duration bucket set.
- Added executable `verify:admission-timing` coverage for admitted and rejected
  counts, exact zero queue wait on a precheck rejection, fine decision buckets,
  and observe-mode exclusion.

### Changed

- Updated the exact vendored runtime dependency from
  `async-bulkhead-llm@3.15.1` to `async-bulkhead-llm@3.16.0`. The transitive
  `async-bulkhead-ts@1.0.1` dependency is unchanged.
- Admission timing is reported per outcome. `_sum` / `_count` are the intended
  headline aggregation; histogram buckets are diagnostic rather than a
  quantile-based headline.
- At the time, renumbered the planned fleet-coordination-hardening milestone from
  v0.27.0 to v0.28.0. The roadmap was subsequently reprioritized; v0.28.0
  ultimately shipped dynamic fleet routing membership instead.

### Compatibility

- Admission policy, Latchflo wire behavior, and request/response semantics are
  unchanged from 0.26.0.
- Observe-mode bypasses emit no admission timing.
- `tyr.admission-provenance.v1` is unchanged; this release adds Prometheus
  timing only and does not version or extend the provenance record.

## [0.26.0] - 2026-08-19

### Added

- Added bounded exact successful-admission provenance to each pool's `/stats`
  payload under `tyr.admissionProvenance`. Events are captured from
  async-bulkhead-llm's synchronous `admit` event after capacity is held and
  before Tyr invokes the upstream callback.
- Added `tyr.admission-provenance.v1` records with a pool-local monotonic
  sequence, admission timestamp, Tyr-generated admission ID, priority, optional
  admission class, exact limit revision, reserved tokens, immutable applied
  limits, and matching Latchflo grant provenance when managed.
- Added a fixed 512-event per-pool retention bound plus `retained`, `dropped`,
  `captureFailures`, and `nextSequence` counters so consumers can detect
  incomplete proof evidence.
- Added tests for exact managed-grant attribution, pre-callback visibility,
  observe-mode exclusion, bounded retention, and request-content exclusion from
  `/stats`.

### Changed

- Updated runtime/build metadata and deployment examples to 0.26.0.
- Reserved high-cardinality admission/grant identifiers for `/stats` and audit
  evidence; no new Prometheus labels were added.

### Security

- Exact admission provenance intentionally retains no request bodies, model
  prompts, authenticated identity, or client-supplied request IDs. Tyr uses its
  internally generated admission ID as the trustworthy execution identifier.

### Compatibility

- Admission policy and the Latchflo wire protocol are unchanged from 0.25.1.
- Runtime dependencies remain `async-bulkhead-llm@3.15.1` and
  `async-bulkhead-ts@1.0.1`.

## [0.25.1] - 2026-08-11

### Fixed

- Restored `vendor/async-bulkhead-llm-3.15.1.tgz`,
  `vendor/async-bulkhead-ts-1.0.1.tgz`, and `vendor/yaml-2.9.0.tgz` to the
  source release archive. The committed lockfile resolves those exact tarballs,
  and the Dockerfile copies `vendor/` before `npm ci`; omitting them made clean
  Docker builds fail with `ENOENT /app/vendor/*.tgz`.
- Kept the 0.25.0 admission-class handoff runtime behavior unchanged.

### Verification

- Added release verification guidance for checking vendored tarball integrity
  against the lockfile and building the Docker image from a clean source tree.

## [0.25.0] - 2026-08-11

### Added

- Added `capabilities.admissionClassOccupancyAck: true` to Latchflo registration
  so Latchflo 0.11+ can require ordered class-level handoff evidence before
  reusing protected capacity ahead of lease expiry.
- Successful `applied` acknowledgements now include bounded, deterministic
  admission-class occupancy alongside the existing pool occupancy: protected
  use, shared borrowing, hard ceilings, and token occupancy when configured.
- Admission-class demand heartbeats now include the active hard
  `maxConcurrent` and `maxInFlightTokens` values. This lets a control plane
  reject stale pre-apply class snapshots while keeping class IDs bounded by the
  fixed local table.
- Added focused unit coverage and `verify:class-handoff` executable verification
  for class-only protected-floor restoration.

### Changed

- Tyr now recognizes restrictive class-only grant transitions as drain targets.
  Restoring a protected class floor is treated as a shrink of the shared
  remainder; lowering a class hard ceiling is also treated as a drain. After the
  grant is installed and acknowledged, Tyr immediately publishes a fresh class
  demand heartbeat.
- While the exact published class snapshot still exceeds the desired shared
  concurrency/token remainder or a reduced hard class ceiling, Tyr reuses the
  bounded 500 ms evidence cadence introduced in 0.24.0. The cadence returns to
  normal as soon as a sent snapshot proves the class transition safe.
- Safety evaluation uses the exact class snapshot sent to Latchflo, including
  desired protected floors and hard ceilings, so stale/custom demand providers
  cannot accidentally satisfy a class drain target.
- Updated release metadata, examples, README, roadmap, and verification
  documentation to `0.25.0`. Runtime dependencies are unchanged from 0.24.0.

### Fixed

- Made the capacity-routing executable verifier wait for completed peer snapshot
  refreshes instead of assuming a fixed 100 ms startup delay. This removes a
  timing race that could handle the first verification request locally and
  produce a missing `x-tyr-routed-by` header on slower hosts.

### Compatibility

- Latchflo 0.10.0 remains wire-compatible and may ignore the additive capability,
  acknowledgement class occupancy, and hard-limit heartbeat fields. Physical
  handoff behavior from Tyr 0.24.0 is unchanged.
- Latchflo 0.11+ can combine the normal `applied` acknowledgement with a fresh
  post-ack class heartbeat to commit class-only protected-floor restoration
  before the old lease expires.
- Active requests are never revoked. Restrictive class transitions use the same
  shrink-by-attrition semantics as physical drains, with lease expiry remaining
  the conservative control-plane fallback.

## [0.24.0] - 2026-08-07

### Added

- Added `capabilities.grantOccupancyAck: true` to Latchflo registration and
  additive bounded occupancy evidence on successful `applied` grant
  acknowledgements: `appliedAt`, `inFlight`, `pending`, and `inFlightTokens`
  when the pool exposes token occupancy.
- Added executable handoff verification and focused unit coverage for strict
  acknowledgement-before-heartbeat ordering, unsafe first evidence, an
  attrition race while the heartbeat response is in flight, and eventual safe
  evidence publication.

### Changed

- After a successfully acknowledged higher-revision physical-pool shrink, Tyr
  immediately publishes a distinct post-ack demand heartbeat. While the exact
  occupancy snapshot that Tyr actually published remains above the new
  concurrency or token ceiling, managed mode temporarily uses a bounded 500 ms
  heartbeat cadence and automatically returns to the configured cadence once a
  safe snapshot has been published.
- Serialized managed-mode heartbeat calls so post-ack evidence cannot reuse or
  race with a pre-ack request. Drain-target completion is evaluated against the
  exact sent snapshot rather than a newer local read, preserving proof ordering
  when requests finish during the control-plane round trip.
- Updated release metadata, examples, README, roadmap, and verification
  documentation to `0.24.0`. Runtime dependencies are unchanged from 0.23.0.

### Compatibility

- Latchflo 0.10.0 remains wire-compatible: its parsers ignore the additive
  registration and acknowledgement fields and continue to commit handoffs only
  after the existing `applied` acknowledgement plus a fresh post-ack heartbeat
  proves occupancy is within the drain target.
- Active work is never cancelled or preempted. Existing shrink-by-attrition
  semantics remain authoritative, and lease expiry remains the conservative
  control-plane fallback when acknowledgement/evidence publication fails.
- Non-shrink grants, standalone mode, and pools without managed-mode demand
  reporting retain their existing behavior.

## [0.23.0] - 2026-08-07

### Added

- Added bounded per-admission-class demand snapshots to Latchflo heartbeats. Each
  configured class now reports live in-flight work, accepted-heartbeat admission
  and rejection deltas, budget/concurrency rejection deltas, protected
  concurrency usage, shared-capacity borrowing, and token pressure when the pool
  has a token budget. Class IDs remain bounded by Tyr's fixed validated class
  table and are never derived from tenant/application churn.
- Added per-class accepted-heartbeat checkpoints and `lastRequestAt` tracking. A
  failed heartbeat does not advance class counters, so a later retry carries all
  activity since the last heartbeat Latchflo actually accepted.
- Tyr now advertises `capabilities.admissionClassDemand: true` alongside
  `admissionClasses: true` when registering with Latchflo. The then-current Latchflo 0.8.x
  ignores the additive capability and nested heartbeat field; a class-demand-aware
  allocator can opt into the richer signal without changing Tyr's request path.
- Extended executable demand verification and unit coverage for deterministic
  class ordering, protected/borrowed utilization, accepted-heartbeat deltas, and
  retry retention.

### Changed

- Demand reporting is now the gateway-side protocol foundation for future
  demand-aware lending of protected admission-class floors. Tyr still does not
  decide when a floor is lent or restored; that policy remains a Latchflo
  control-plane responsibility.
- Updated runtime build metadata, examples, verification documentation, and
  release version to `0.23.0`. Runtime dependencies are unchanged from 0.22.0.

### Compatibility

- Existing pool-level demand fields are unchanged. Pools without admission
  classes emit the same heartbeat shape as 0.22.0.
- Admission-class floor semantics are unchanged: idle protected capacity remains
  reserved until Latchflo explicitly issues a higher-revision grant with resized
  floors.

## [0.22.0] - 2026-08-06

### Added

- Added strict protected admission-class floors through
  `protectedConcurrent` and `protectedInFlightTokens`. Tyr validates each floor,
  the corresponding hard ceiling, and the sum of all floors against the local
  physical pool envelope before startup or runtime application.
- Added bounded Prometheus gauges and counters for protected, borrowed, and
  shared class capacity, including cumulative admissions and reservation tokens
  that used the shared remainder.
- Capacity-aware routing snapshots now use schema version `3` and include
  protected/borrowed class state plus the shared remainder. Replica selection
  predicts protection-layer rejection in addition to global and hard class
  ceilings.

### Changed

- Updated the exact runtime dependency from `async-bulkhead-llm@3.14.0` to
  `3.15.1` and refreshed the bundled offline artifact.
- Latchflo grant parsing and same-revision comparison now include protected
  class floors. Grants may resize floors atomically with physical and hard class
  limits; active work is never revoked and new borrowing pauses until attrition
  restores protection.
- A replica with protected floors will not route class-aware work to a schema-1
  or schema-2 peer that cannot represent or enforce floor semantics. Tyr still
  accepts older snapshots for fleets that do not use protected floors.

### Fixed

- Latchflo lease expiration now zeroes protected class floors before applying
  the zero-capacity kill switch, while retaining the last non-expiration class
  table so a later higher-revision grant that omits class limits can restore it.
- Repeated same-revision grants that omit admission classes are now idempotent
  when Tyr is preserving its local/effective fixed class table, rather than
  being misclassified as revision-content conflicts.
- `tyr_build_info` now reports `0.22.0`; telemetry smoke verification also checks
  that the runtime version constant matches `package.json`.

### Compatibility

- Existing admission-class configurations that omit both protected fields retain
  0.21 behavior.
- Protected floors are strict local reservations. Capacity above all floors is
  shared, but an idle floor is not automatically lent; demand-aware floor
  resizing remains a Latchflo control-plane policy.

## [0.21.0] - 2026-08-05

### Added

- Tyr now declares `capabilities.admissionClasses: true` when registering
  with Latchflo. Latchflo 0.7.0 and newer refuse to enrol an agent into any
  pool carrying `admissionClassLimits` unless the agent declares this, so
  every replica in a class-configured fleet previously failed registration
  with `400` and never appeared in `GET /v1/agents`. Combined with the
  0.20.1 retry-forever change, the symptom was a healthy-looking but
  permanently unready fleet that the control plane could not see. Older
  control planes ignore the field.
- Tyr now consumes the per-replica admission-class partition Latchflo ships
  on each capacity grant. `limits.admissionClasses` is parsed, validated
  (bounded class count, known properties only, non-negative integers,
  reserved class IDs rejected), and applied as part of the same atomic
  limits transaction as concurrency and token budget. Fleet-wide class
  ceilings configured in Latchflo now take effect instead of being silently
  discarded in favour of the locally configured table.

### Changed

- Admission-class limits in a pool's static configuration are now bootstrap
  values under control-plane management: a grant carrying
  `admissionClasses` overrides them. A grant that omits the field leaves the
  configured table in force, so control planes predating class-aware
  allocation continue to work unchanged.
- Same-revision grant comparison now includes admission-class limits. A
  grant that reuses an applied revision with different class ceilings is
  reported as `revision_content_conflict` rather than being accepted as
  equivalent.

### Fixed

- A grant whose class keys do not match the pool's configured class table is
  now rejected through the normal acknowledgement path
  (`admission_class_key_mismatch`, or `admission_classes_not_configured`
  when the pool has no class table at all). Previously the key-preservation
  check inside `applyLimits` would throw, leaving the grant unacknowledged
  until the expiration kill switch zeroed the pool.

### Notes

- No dependency changes. This release continues to build against
  `async-bulkhead-llm@3.14.0` and the vendored `async-bulkhead-ts@1.0.1`.

## [0.20.1] - 2026-08-04

### Fixed

- Fixed the Latchflo agent's heartbeat, desired-state poll, and startup
  registration loops giving up permanently after a non-retryable response
  (`400`/`401`/`403`/`404`/`409`/`422`, or a malformed response body). All
  three now keep retrying with the existing bounded exponential backoff, so
  a transient control-plane blip that happens to return one of those
  statuses no longer strands Tyr unready until a manual restart.
- Fixed steady-state agent-token recovery: a persisted token rejected with
  `401` when no bootstrap token is configured now discards the known-bad
  token so the next attempt fails fast locally with the existing "bootstrap
  token is required" message, instead of resending the same doomed request
  to Latchflo forever.
- Fixed a local agent-token persistence failure (for example a read-only or
  full `agentTokenFile` volume) being misclassified as an ordinary
  retryable connectivity failure. A freshly issued token now stays valid in
  memory even when it cannot be durably persisted, so Tyr no longer
  re-registers with Latchflo on every retry solely because of a local
  filesystem problem. The failure is now reported through a new
  `tyr_latchflo_failures_total{operation="persist",reason="persist_error"}`
  counter instead of the generic retryable/permanent reasons.
- Added focused regression coverage for all three fixes in
  `test/latchflo.test.ts`.

## [0.20.0] - 2026-08-04

### Added

- Added bounded per-pool admission classes backed by
  `async-bulkhead-llm@3.14.0`. Each configured class can independently cap
  active requests and in-flight tokens while remaining subordinate to the
  physical pool envelope.
- Added ordered identity-to-class rules over trusted subject, tenant,
  application, and role claims. First matching rule wins; selector categories
  within one rule are ANDed and values within a category are ORed.
- Added `x-admission-class`, admission-class attribution in structured audit
  events, bounded `admission_class` decision labels, and live per-class
  capacity/admission/rejection Prometheus series.
- Added class-aware capacity snapshots and routing. Tyr now excludes replicas
  where the selected class is missing or immediately unable to fit the request.
  The selected class is carried across the private hop under the existing
  routing shared secret, preventing destination-side policy drift from
  reclassifying the request.
- Added `scripts/verify-admission-classes.mjs` and focused unit coverage for
  bounded policy validation, first-match evaluation, class isolation,
  class-aware routing, atomic class-limit updates, and Latchflo preservation.

### Changed

- Updated the exact runtime dependency from `async-bulkhead-llm@3.13.0` to
  `3.14.0` while retaining the progressive-reconciliation API used by Tyr.
- Capacity snapshot schema version is now `2`. Tyr accepts schema versions 1
  and 2, but a class-aware request treats a schema-1 peer without class data as
  ineligible rather than assuming capacity.
- Complete admission-limit updates now include the fixed admission-class table
  when classes are configured. Runtime revisions may resize existing classes
  but cannot add, remove, or rename class IDs.
- Latchflo grant updates and expiration kill switches preserve local
  admission-class limits while continuing to own only the physical pool grant.
- Packaged artifacts now include the vendored async-bulkhead tarball required
  by the exact file dependency.

### Compatibility

- Existing configurations without `admissionClasses` retain 0.19 behavior.
- Admission classes are startup configuration in 0.20. Latchflo does not yet
  distribute identity rules or class limits.
- Class-limit reductions use shrink-by-attrition and never cancel running work.
- Raw tenant, application, subject, and role values remain excluded from
  Prometheus labels and runtime bulkhead keys.

## [0.19.0] - 2026-08-01

### Added

- Added progressive streaming reconciliation through
  `async-bulkhead-llm@3.13.0` and its `ProgressiveUsageReconciler`. Once a
  provider reports cumulative usage, Tyr returns already-processed input and
  output capacity while retaining a bounded future-output hold.
- Added per-pool `progressiveReconciliation` configuration with
  `enabled`, `updateStepTokens`, and `outputSafetyMarginTokens`. Budgeted pools
  enable the feature by default with a 256-token update step and 256-token
  safety floor.
- Added pool statistics for raw usage reports, applied hold updates, coalesced
  updates, and tokens released before request completion.
- Added focused unit and executable regression coverage for first-input
  release, stepped output release, safety-margin retention, coalescing, final
  release, and the explicit compatibility opt-out.

### Changed

- Updated the exact runtime dependency from `async-bulkhead-llm@3.12.0` to
  `3.13.0`. The vendored release artifact uses `async-bulkhead-ts@1.0.1`.
- Anthropic streaming requests no longer retain tokens that the provider has
  already processed. OpenAI streams gain the same behavior when cumulative
  usage is present in streamed chunks.

### Compatibility

- Set `progressiveReconciliation.enabled: false` on a pool to retain the
  conservative 3.12 behavior: actual input plus the full output ceiling stays
  held until final release.
- Non-streaming requests and streams that never report cumulative usage retain
  their original admission reservation until completion.

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

[Unreleased]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.30.0...HEAD
[0.30.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.25.1...v0.26.0
[0.25.1]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.20.1...v0.21.0
[0.20.1]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/v0.18.0...v0.19.0
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
[0.2.0]: https://github.com/mofluxhq/tyr-admission-controller/releases/tag/v0.2.0
[0.1.0]: https://github.com/mofluxhq/tyr-admission-controller/compare/72236af...96e0097
