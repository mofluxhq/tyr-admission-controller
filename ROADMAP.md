# Tyr Admission Controller Roadmap

Tyr is an LLM admission controller. Its purpose is to prevent concurrent AI workloads from overcommitting finite provider or inference capacity by reserving token capacity before upstream execution begins.

This roadmap prioritizes the shortest path from the current `v0.32.0`
open-source release to a commercially credible product. It
assumes one experienced TypeScript/backend engineer, automated tests and
documentation for every milestone, and no custom management UI before
`v1.0.0`.

## Product direction

Tyr should compete as an **LLM capacity firewall**, not as a general-purpose provider gateway. It should integrate with existing gateways and provider SDKs rather than attempt to replace LiteLLM, Kong, Envoy, or established internal platforms.

The initial commercial promise is:

> Tyr rejects the right requests before provider invocation, protects high-value traffic during saturation, and makes admission decisions observable and auditable.

## Guiding principles

1. **Fail safely.** A coordination, identity, or telemetry failure must not silently grant elevated priority or exceed a configured capacity policy.
2. **Prove value before adding architecture.** Telemetry and design-partner evidence come before a custom control plane.
3. **Prefer integration over replacement.** Tyr should work with direct provider SDKs, vLLM, LiteLLM, Kong, Envoy, and existing internal gateways.
4. **Keep policy explicit.** Every rejection should have a bounded reason code, relevant capacity context, and an audit event.
5. **Control cardinality.** Tenant, application, model, and request identifiers must not create unbounded metric labels or bulkhead instances.
6. **Preserve a small data plane.** Authentication, admission, forwarding, and telemetry belong in the gateway; historical analytics and fleet coordination may live outside it.

## Current baseline: v0.32.0

The current release provides:

- Apache-2.0 licensing. Latchflo managed mode requires a separately licensed
  Latchflo 0.4.0 or later.
- Upstream failure diagnostics: `502 upstream_error` names a bounded transport
  `cause.code`, counted by `tyr_upstream_failures_total` and logged as a
  `tyr.diagnostic.v1` event.
- Anthropic Messages, OpenAI Chat Completions, and stateless OpenAI Responses proxy routes.
- Model-prefix routing to independently configured local pools.
- A v3.17 pool policy runtime using exact reservation previews, native observe
  mode, and complete versioned admission-limit snapshots.
- Optional wall-clock leases for borrowed local admission slots, with split
  concurrency/token accounting and resource-specific restoration evidence.
- Tyr-local all-or-nothing runtime updates across named pools, with stale
  revision protection and shrink-by-attrition semantics.
- First-class Latchflo-managed operation with registration, persisted credentials,
  readiness, expiring grants, and fail-closed zero-capacity startup.
- Automatic per-pool and bounded per-admission-class demand snapshots on
  authenticated Latchflo heartbeats, including accepted-heartbeat
  admission/rejection deltas, protected/shared utilization, and live token
  pressure.
- Acknowledged physical-capacity handoff evidence: shrink grants are installed
  before acknowledgement, followed by a distinct fresh occupancy heartbeat and
  bounded 500 ms evidence cadence until the exact published snapshot is within
  the new ceiling.
- Admission-linearized revisions and a bounded per-pool Latchflo provenance ledger
  containing grant ID, controller epoch, and expiration.
- A bounded exact successful-admission provenance ring in `/stats`, tying each
  Tyr-generated admission ID to its applied limit revision/snapshot and matching
  Latchflo grant without relying on cross-process timestamp ordering.
- Exact grant-attribution response headers for admissions, bypasses, and
  rejections.
- Adaptive per-model input estimates learned from provider-reported usage.
- Progressive streaming reconciliation that returns completed input/output capacity in bounded steps while retaining a future-output safety floor.
- Fail-fast concurrent-request and token-budget admission with priority reserves.
- Stable admission IDs, streaming usage correction, transport backpressure, and
  response, idle, and client-stall timeouts.
- Bounded graceful drain with outstanding-work reporting.
- Strict startup validation, YAML configuration, offline validation, Docker and
  Compose assets, and expanded local policy statistics.
- Native bounded-cardinality Prometheus metrics, optional structured admission
  audit events, operator-token protection, and a provisioned Grafana demo.
- First-class JWT/JWKS request identity, role authorization for provider and
  operator routes, role-based high priority, and identity-attributed audit events.
- Optional request-specific capacity-aware routing with protected short-lived
  capacity snapshots, one-hop forwarding, local tie preference, and authoritative
  destination admission. In Latchflo managed mode, Latchflo 0.13+ supplies a
  versioned fleet topology that Tyr can apply without restart; standalone routing
  retains startup-configured peers.
- Observed-completion-based retry hints for capacity rejection responses.
- Explicit upstream-cancellation uncertainty: deadline-based local slot release
  is never presented as provider-capacity reclamation.

Known commercial limitations include a single-controller SQLite control plane, no OTLP exporter or durable audit store, direct-JWKS-only identity configuration, limited protocol coverage, and no hardened multi-region deployment package.

## Release sequence

### v0.15.1 — Identity verifier availability semantics

**Status:** Released 2026-07-29

- Added `503 identity_unavailable` for JWKS and custom-verifier infrastructure
  failures while preserving fail-closed verification.
- Kept `401` for caller-owned credential failures and `403` for authorization
  failures.
- Preserved warm-cache operation through transient JWKS outages.

### v0.15.0 — Authenticated request identity

**Status:** Released 2026-07-29

- Added JWT/JWKS authentication before request-body buffering.
- Added role authorization for provider invocation and operator endpoints.
- Added verified role-based high-priority admission.
- Added identity attribution to `tyr.admission-audit.v2`.

### v0.14.0 — Production telemetry and demonstrable value

**Status:** Released 2026-07-28

- Added bounded Prometheus metrics for capacity, admission, rejection, token,
  duration, upstream, readiness, grant, and Latchflo failure signals.
- Added structured admission audit records with settlement and final usage.
- Added optional operator bearer protection for `/stats` and `/metrics`.
- Added a local Prometheus/Grafana/mock-provider overload demonstration.

### v0.13.0 — First-class Latchflo managed mode

**Status:** Released 2026-07-26

- Added configuration-driven control-plane registration and desired-state polling.
- Added persisted rotated credentials, readiness gating, and graceful lifecycle wiring.
- Added fail-closed zero-capacity startup through `async-bulkhead-llm` 3.12.0.
- Added strict desired-state validation and lease-expiration enforcement.

### v0.12.0 — Latchflo rebrand compatibility

**Goal:** Let Tyr and the control plane migrate to the Latchflo name
independently, without a synchronized deploy.

- Accepted `source: "latchflo"` alongside the legacy `source: "korrx"`.
- Added `x-latchflo-grant-id` and `x-latchflo-controller-epoch` headers,
  emitted alongside the deprecated `x-korrx-*` pair.
- Deferred removal of the legacy value and headers to a later release, gated on
  fleet-wide migration.

### v0.11.1 — Korrx contract compatibility

**Status:** Released 2026-07-25
**Goal:** Make Tyr consume the exact provenance contract emitted by the Korrx
control-plane agent.

Delivered:

- Changed immutable admission provenance to require `source: "korrx"`.
- Renamed grant-attribution headers to `x-korrx-grant-id` and
  `x-korrx-controller-epoch`.
- Added real pool and gateway regression coverage for Korrx-attributed
  admissions, observe bypasses, and rejections.
- Added validation coverage proving the obsolete Zab source fails before any
  pool is mutated.

### v0.8.0 — Exact and correlatable admission

**Status:** Released 2026-07-20
**Goal:** Align Tyr's admission model with `async-bulkhead-llm` 3.7.0 and make admitted requests reliably correlatable.

Delivered:

- Upgraded `async-bulkhead-llm` from 3.6.0 to 3.7.0.
- Replaced synthetic JSON prompt projection and hidden-symbol metadata with
  first-class `system`, `extraInputTokens`, and `opaqueBlockTokens` request
  surfaces.
- Added configurable per-pool and legacy-environment opaque media/document
  token reservations.
- Frozen one reservation preview per request and supplied it as the exact
  per-call reservation override, so the preview and admission decision use the
  same immutable estimate.
- Exposed the stable bulkhead admission UUID as `x-admission-id` on admitted
  responses.
- Added regression coverage and synchronized the configuration schema,
  examples, README, changelog, generated runtime, and release metadata.

Outcome:

- Provider-only prompt metadata and opaque blocks participate in admission
  without being serialized into fake user content.
- The reservation shown before execution cannot drift from the reservation
  used to admit the request.
- Clients and operators can correlate an admitted HTTP request with its
  reservation lifecycle using one stable identifier.

Limitations at that release:

- Standard metrics export, operator protection, and structured audit events were
  delivered later in v0.14.0; authenticated tenant/application identity arrived in v0.15.0.

### v0.9.0 — Adaptive and observable admission policy

**Status:** Released 2026-07-21
**Goal:** Adopt the full `async-bulkhead-llm` 3.8 admission lifecycle and make enforcement safe to evaluate before rollout.

Delivered:

- Exact reservation round-tripping with v3.8 consistency checks.
- Detailed advisory capacity snapshots on admitted and rejected previews.
- Per-pool `enforce` and `observe` modes.
- Adaptive per-model input-estimation correction from provider usage.
- Policy statistics and advisory response headers.
- Bounded drain results and forced HTTP connection closure at the configured
  shutdown deadline.

Outcome:

- Operators can deploy Tyr in shadow mode, quantify prospective rejection
  behavior, inspect requested and available capacity, then enable enforcement
  without changing the forwarding path.
- Estimation can adapt to workload and tokenizer drift while remaining bounded.
- Shutdown no longer needs to wait forever on a stalled stream.

Limitations at that release:

- Standard metrics export, operator protection, and structured audit events were
  delivered later in v0.14.0; authenticated tenant/application identity arrived in v0.15.0.

### v0.10.0 — Versioned data-plane control

**Status:** Released 2026-07-23
**Goal:** Make Tyr a safe, remotely reconfigurable data-plane agent built directly on `async-bulkhead-llm` 3.10.0.

Delivered:

- Complete per-pool snapshots for concurrency, queue capacity, token budget, and high-priority reserve.
- Strictly increasing revisions with stale-update rejection.
- Tyr-local multi-pool preflight so invalid or stale batches cannot partially apply.
- Shrink-by-attrition, immediate scale-up of accepted waiters, and a zero-concurrency kill switch.
- Native v3.10 observe execution and bypass accounting, replacing Tyr's duplicated shadow path.
- A narrow `createGateway().control` interface for limit snapshots, statistics, and runtime updates.
- Revision and admission-outcome response headers.
- Startup queue and revision configuration, updated CI, documentation, and focused regression coverage.

Outcome:

- This snapshot model established the bounded, versioned grant surface later consumed by Latchflo without joining every request path.
- Tyr can safely reduce or restore local capacity without restarting or cancelling active work.
- Delayed or duplicated control messages cannot overwrite a newer local revision.

Limitations at that release:

- Latchflo-managed expiring grants arrived in v0.13.0 and Prometheus/audit
  telemetry arrived in v0.14.0; identity arrived in v0.15.0; durable audit storage remains future work.

### v0.11.0 — Provenance-correct distributed admission

**Status:** Released 2026-07-24
**Goal:** Make every local admission attributable to the exact external grant
that authorized its capacity.

Delivered:

- Upgraded to `async-bulkhead-llm` 3.11.0 and consumed its immutable
  admission-linearized `limitRevision`.
- Added optional Korrx provenance to transactional updates: grant ID, controller
  epoch, exact revision, and expiration.
- Retained a bounded revision-to-provenance ledger per pool.
- Added exact grant and epoch response headers for admitted, bypassed, and
  rejected requests.
- Added deterministic library, pool, gateway, and agent race coverage.

Outcome:

- Applying grant B cannot relabel work that already acquired capacity under
  grant A.
- Operators can trace each decision to the exact versioned, expiring capacity
  grant that governed it.

### v0.16.0 — Capacity retry guidance

**Status:** Released 2026-07-31

- Added precise `x-admission-retry-after-ms` hints derived from observed pool
  completion intervals.
- Added standards-compatible `Retry-After` for waits of at least one second.
- Added bounded, configurable hint sampling and deliberately omitted guesses
  before sufficient evidence exists.

### v0.17.0 — Capacity-aware Tyr replica routing

**Status:** Released 2026-08-01

- Added protected, short-lived per-replica capacity snapshots.
- Added request-specific selection using exact reservation, concurrency headroom,
  and priority-adjusted token headroom.
- Added authenticated single-hop forwarding with local tie preference and no
  automatic replay after dispatch.
- Kept the destination Tyr authoritative, preserving Latchflo's bounded grants.
- Kept peer membership static; Latchflo topology distribution is deferred.

### v0.18.0 — Automatic Latchflo demand reporting

**Status:** Released 2026-08-01

- Added per-managed-pool demand snapshots to authenticated Latchflo heartbeats.
- Reported live concurrency and token pressure plus interval admission and
  rejection deltas without adding work to the provider request path.
- Advanced demand checkpoints only after accepted heartbeats so transient
  control-plane failures cannot lose demand.
- Enabled Latchflo 0.6 demand-aware capacity groups while preserving
  compatibility with Latchflo 0.5.x.

### v0.20.0 — Identity-aware admission classes — shipped 2026-08-04

Shipped:

- Added bounded, statically configured service classes beneath each physical
  pool, with independent concurrency and in-flight token ceilings.
- Added deterministic first-match rules over trusted subject, tenant,
  application, and role claims.
- Added class-aware routing, response headers, structured audit attribution,
  bounded Prometheus labels, versioned class-limit updates, and Latchflo grant
  preservation.
- Kept tenant churn out of runtime bulkhead keys, timers, and metric series by
  limiting policy to at most 64 configured classes.

### v0.21.0 — Latchflo-distributed class limits — shipped 2026-08-05

Shipped:

- Declared admission-class capability during Latchflo registration.
- Consumed per-replica class partitions from capacity grants and applied them
  atomically with physical concurrency and token limits.
- Preserved fixed class-key tables and rejected mismatched or conflicting grant
  revisions through the normal acknowledgement path.
- Kept locally configured class limits as bootstrap values when an older control
  plane omits class partitions.

### v0.22.0 — Protected class floors and borrowing visibility — shipped 2026-08-06

Shipped:

- Added strict local concurrency and in-flight token floors beneath class hard
  ceilings through `async-bulkhead-llm@3.15.1`.
- Added bounded protected, borrowed, and shared-capacity telemetry.
- Added routing snapshot schema 3 so replica selection predicts floor-protection
  rejection and avoids peers that cannot represent the active policy.
- Extended Latchflo grants to resize floors atomically without revoking active
  work; shrink-by-attrition pauses new borrowing until protection is restored.

Current guarantee boundary:

- Floors are strict local reservations and capacity above all floors is shared.
- An idle floor is not automatically lent by the data-plane library. Demand-aware
  floor resizing and restoration remain a Latchflo allocation policy.
- Dynamic model authorization, policy rollout, and durable policy management are
  still future work.

### v0.23.0 — Bounded admission-class demand reporting — shipped 2026-08-07

Shipped:

- Extended every managed pool demand heartbeat with deterministic, bounded
  snapshots for its configured admission classes.
- Added live class in-flight pressure, accepted-heartbeat admission/rejection
  deltas, protected utilization, shared-capacity borrowing, and token pressure.
- Added per-class accepted-heartbeat checkpoints so failed control-plane calls do
  not lose demand evidence.
- Advertised `capabilities.admissionClassDemand: true` while preserving wire
  compatibility with the then-current Latchflo 0.8.x, which ignored the additive fields.
- Kept lending policy out of Tyr: the gateway reports demand and continues to
  enforce only the complete higher-revision limit snapshots issued by Latchflo.

Outcome:

- Latchflo now has a bounded gateway-side signal it can use to distinguish idle
  protected classes from classes that need their nominal floor restored.
- No raw tenant/application identity is added to runtime keys or control-plane
  demand cardinality.

### v0.24.0 — Acknowledged capacity-handoff evidence — shipped 2026-08-07

Shipped:

- Advertised the additive `grantOccupancyAck` capability and included bounded
  current occupancy in successful grant acknowledgements.
- Installed lower physical-pool grants before acknowledgement, then published a
  distinct post-ack demand heartbeat so Latchflo can prove that borrowed
  capacity actually drained before committing its staged expansion.
- Added a bounded 500 ms evidence cadence while the exact published occupancy
  remains above a successfully acknowledged shrink target; ordinary Latchflo
  heartbeat cadence resumes automatically after safe evidence is published.
- Serialized heartbeats and tied drain completion to the exact sent snapshot,
  closing a race where local occupancy changes while the control-plane response
  is in flight.
- Preserved non-revoking shrink-by-attrition behavior and the control plane's
  lease-expiry safety fallback.

Outcome:

- Latchflo 0.10.0 can reclaim borrowed capacity materially sooner than a normal
  heartbeat/lease boundary without treating acknowledgement alone as proof that
  capacity is free.
- Tyr remains a small data plane: it reports and enforces the grant; Latchflo
  still owns allocation and transfer policy.

### v0.25.1 — Reproducible Docker source packaging — shipped 2026-08-11

- Restores the vendored runtime tarballs required by the committed `package-lock.json` and Dockerfile so `npm ci` succeeds inside clean Docker build contexts.
- Carries forward the 0.25.0 admission-class handoff behavior unchanged.

### v0.25.0 — Acknowledged admission-class handoff evidence — shipped 2026-08-11

Shipped:

- Advertised additive `admissionClassOccupancyAck` support and included bounded
  class occupancy in successful grant acknowledgements.
- Added active hard class ceilings to class-demand heartbeats so post-ack class
  evidence proves the desired snapshot was actually installed.
- Treated protected-floor restoration as a shrink of shared class capacity and
  lower hard class ceilings as drain targets.
- Published a distinct post-ack class heartbeat and retained the 500 ms evidence
  cadence until the exact sent snapshot fits the desired shared remainder and
  any reduced hard ceilings.
- Preserved non-preemptive attrition and lease-expiry fallback.

Outcome:

- Latchflo 0.11+ has the Tyr-side protocol needed to restore admission-class
  protected floors before the old lent-allocation lease expires without
  double-allocating shared capacity.
- Latchflo 0.10 remains wire-compatible and physical handoff behavior is
  unchanged.

### v0.26.0 — Exact admission provenance — shipped 2026-08-19

Shipped:

- Captures every successful capacity-holding admission from the local admission
  linearization event before upstream execution begins.
- Exposes a bounded 512-event per-pool `/stats` ring with Tyr-local sequence,
  admission timestamp/ID, priority/class, exact revision, immutable applied
  limits, reserved tokens, and matching Latchflo grant provenance.
- Reports retained/dropped counts, capture failures, and next sequence so evidence
  consumers can reject incomplete histories rather than silently overclaim.
- Keeps request bodies, identity, and client-supplied request IDs out of the
  provenance ring and keeps all high-cardinality identifiers out of Prometheus.

Outcome:

- MoFlux Bench can prove that a post-handoff admission was authorized by the
  committed successor grant directly, eliminating the 500 ms polling-window
  ambiguity that previously made some safe handoffs inconclusive.
- No admission-policy or Latchflo wire-protocol change is required.

### v0.27.0 — Admission-decision instrumentation — shipped 2026-08-25

- Measures synchronous local admission-decision time separately from local
  concurrency queue wait using `async-bulkhead-llm@3.16.0`.
- Exposes per-outcome Prometheus histograms with bounded pool/class labels and
  fine 5 µs–50 ms decision buckets.
- Excludes observe-mode bypasses and preserves exact zero queue wait for
  precheck rejections.
- Keeps `tyr.admission-provenance.v1` unchanged.
- Adds executable release verification so missing timing cannot be mistaken for
  zero decision cost.

Outcome:

- MoFlux Bench can directly measure Tyr's local admission decision cost instead
  of leaving the MoFlux arm permanently `not-instrumented`.
- The coordination claim can compare local Tyr decision cost against an
  immediate external coordinator while reporting queue contention separately.

### v0.28.0 — Dynamic fleet routing membership — shipped 2026-08-28

- Consumes Latchflo 0.13+ versioned `routingTopology` snapshots from desired
  state without adding a Latchflo call to the provider request path.
- Applies only newer complete topology revisions and filters the local Tyr
  instance from the routable peer set.
- Immediately removes departed peers and their cached capacity; new members and
  endpoint replacements must earn a fresh capacity snapshot before routing.
- Starts and stops peer polling as membership changes, allowing a fleet to move
  from zero startup peers to dynamically discovered peers without restart.
- Preserves static peers as the standalone/older-controller fallback.
- Requires routing and Latchflo managed mode to use the same `instanceId`.
- Adds executable dynamic join/remove/stale-revision/replacement verification.

Outcome:

- A failed Tyr can be replaced by a new fleet member with a different identity or
  endpoint and become routable through Latchflo membership propagation rather
  than a coordinated static-config edit.
- Autoscaling and rolling replacement no longer require every Tyr process to be
  restarted solely to learn the current managed fleet topology.

### v0.29.0 — OpenAI Responses API — shipped 2026-08-30

- Added `POST /v1/responses` on the existing OpenAI upstream configuration.
- Added stateless request projection for `input`, `instructions`,
  `max_output_tokens`, request-visible function/custom tools, structured text
  configuration, reasoning configuration, and multimodal input blocks.
- Added non-streaming Responses usage reconciliation and semantic SSE usage
  extraction from final response lifecycle events.
- Preserved raw OpenAI request passthrough and provider credential ownership.
- Rejected hidden-state modes (`previous_response_id`, server-side
  `conversation`, stored `prompt`, `item_reference`), `background: true`, and
  provider-managed retrieval/computer tools until Tyr can reserve their unseen
  capacity without undercounting.
- Added executable Responses compatibility verification and corrected stale
  current-state documentation.

Outcome:

- New OpenAI applications can use the recommended Responses endpoint through Tyr
  without falling back to Chat Completions for admission control.
- Tyr keeps its pre-upstream token-reservation guarantee explicit rather than
  pretending unseen provider-managed state can be estimated safely.

### v0.32.0 — Apache-2.0 open-source release — shipped 2026-09-22

- Relicensed Tyr under Apache-2.0 and shipped the license, notice and third-party notices in the image and npm package.
- Removed the deprecated `x-korrx-*` headers and `source: "korrx"` provenance, completing the 0.12.0 deprecation.

### v0.31.0 — Upstream failure diagnostics — shipped 2026-09-22

- `502 upstream_error` carries a bounded transport `cause.code`; `tyr_upstream_failures_total` and a `tyr.diagnostic.v1` stderr line record every upstream failure with its code and bounded detail.

### v0.30.0 — Resource-specific restoration contracts — shipped 2026-09-03

- Added an optional post-admission wall-clock deadline for concurrency actually
  borrowed by a configured admission class.
- Split local concurrency release from token accounting: expiry abandons the
  borrowed Tyr slot, while the token hold remains until local work settles.
- Added explicit resource attribution and restoration evidence to headers,
  errors, audit events, provenance, `/stats`, and Prometheus metrics.
- Classified local slot release as enforced and upstream abort-signal
  cancellation as unverified.
- Advertised deadline support to Latchflo without allowing numeric grant updates
  to replace the local deadline policy.
- Added executable verification covering local restoration, protected admission,
  conservative token accounting, final drain, and ignored cancellation.

Outcome:

- Borrowing policy now states who borrows, which local resource is borrowed, and
  the deadline/release mechanism for restoring that resource.
- Tyr does not convert client-side abandonment into a false claim that provider
  quota, model queues, or accelerator capacity was reclaimed.
- Operators have a concrete reason to retain an unlent upstream floor wherever
  provider-side termination cannot be proven.

### v0.33.0 — Self-serve evaluation path

**Goal:** Make it possible for an engineer to prove Tyr's value against a real
OpenAI workload without a design-partner engagement or custom deployment work.

Planned work:

- Publish a minimal OpenAI SDK quickstart for both `responses.create(...)` and
  Chat Completions with Tyr as the base URL.
- Provide a single-node evaluation configuration with interactive/batch admission
  classes, Prometheus metrics, and explicit cost controls.
- Add a small live-provider Responses compatibility check to MoFlux Bench rather
  than another broad benchmark campaign.
- Tighten deployment/readiness documentation and produce a short evaluation
  checklist that can be completed before introducing Latchflo.

Exit criteria:

- A new evaluator can launch Tyr, point an OpenAI SDK at it, run a protected
  interactive-versus-batch workload, and inspect the resulting admission metrics
  without modifying Tyr source code.
- The evaluation path does not require Kubernetes or Latchflo.

Non-goals:

- Multi-controller control-plane hardening without a demonstrated deployment
  requirement.
- A management UI.


### v1.0.0 — Supported production release

**Timing:** After v0.33.0 and sufficient design-partner validation.
**Goal:** Provide a stable, documented, supportable product for production design partners.

Planned work:

- Publish a versioned Docker image with SBOM, provenance, vulnerability scanning, and multi-architecture builds.
- Publish a Helm chart with PodDisruptionBudget, readiness/liveness probes, graceful termination, resource guidance, and network-policy examples.
- Define configuration compatibility and deprecation policies.
- Stabilize public TypeScript configuration, identity, policy, telemetry, and coordination interfaces.
- Add bounded shutdown deadlines and documented termination behavior.
- Add end-to-end load, soak, memory, disconnect, and coordinator-failure test suites.
- Publish supported Node.js, Redis, provider API, and deployment compatibility matrices.
- Publish the contribution policy. Tyr is licensed under Apache-2.0.
- Publish operational runbooks, threat model, security reporting process, and service-level indicators.
- Produce at least one public or anonymized design-partner case study.

Exit criteria:

- At least three production or near-production design-partner deployments.
- Demonstrated reduction in provider throttling or saturation incidents.
- No unresolved critical security findings.
- Reproducible release artifacts and upgrade/rollback documentation.
- A stable support policy for the `1.x` release line.

## Post-v1 candidates

These items are valuable but should follow demonstrated customer demand.

### Protocols

1. Bedrock Converse and ConverseStream.
2. OpenAI-style embeddings.
3. Provider-specific reranking adapters.
4. Agent-run and MCP traffic correlation across multiple model and tool calls.
5. Additional OpenAI-compatible local inference servers.

### Integrations

1. Packaged Kong reference deployment.
2. Packaged Envoy reference deployment.
3. Native Envoy external-processing service when metadata-aware admission is required.
4. Native gateway plugins only where HTTP chaining cannot satisfy latency, identity, or policy requirements.
5. Design-partner adapters for existing internal gateways.

### Coordination

1. Multi-controller Latchflo failover and fencing hardening when a real deployment
   requires removal of the single-controller operational dependency.
2. A small centralized capacity coordinator when Redis operational or consistency limits become material.
3. Provider-quota allocation issued to replicas when Tyr has enough provider-specific quota data to rebalance intelligently.
4. Kubernetes-aware dynamic partitioning as an optional degraded or Redis-free mode, not the default distributed correctness mechanism.
