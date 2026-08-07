# Tyr Admission Controller Roadmap

Tyr is an LLM admission controller. Its purpose is to prevent concurrent AI workloads from overcommitting finite provider or inference capacity by reserving token capacity before upstream execution begins.

This roadmap prioritizes the shortest path from the current `v0.23.0` class-demand reporting release to a commercially credible product. It assumes one experienced TypeScript/backend engineer, automated tests and documentation for every milestone, and no custom management UI before `v1.0.0`.

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

## Current baseline: v0.23.0

The current release provides:

- Anthropic Messages and OpenAI Chat Completions proxy routes.
- Model-prefix routing to independently configured local pools.
- A v3.15 pool policy runtime using exact reservation previews, native observe
  mode, and complete versioned admission-limit snapshots.
- Tyr-local all-or-nothing runtime updates across named pools, with stale
  revision protection and shrink-by-attrition semantics.
- First-class Latchflo-managed operation with registration, persisted credentials,
  readiness, expiring grants, and fail-closed zero-capacity startup.
- Automatic per-pool and bounded per-admission-class demand snapshots on
  authenticated Latchflo heartbeats, including accepted-heartbeat
  admission/rejection deltas, protected/shared utilization, and live token
  pressure.
- Admission-linearized revisions and a bounded per-pool Latchflo provenance ledger
  containing grant ID, controller epoch, and expiration.
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
- Optional request-specific capacity-aware routing across statically configured
  Tyr replicas, with protected short-lived capacity snapshots, one-hop forwarding,
  local tie preference, and authoritative destination admission.
- Observed-completion-based retry hints for capacity rejection responses.

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

- A future central allocator can issue bounded, versioned grants without joining every request path.
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
  compatibility with Latchflo 0.8.x, which ignores the additive fields.
- Kept lending policy out of Tyr: the gateway reports demand and continues to
  enforce only the complete higher-revision limit snapshots issued by Latchflo.

Outcome:

- Latchflo now has a bounded gateway-side signal it can use to distinguish idle
  protected classes from classes that need their nominal floor restored.
- No raw tenant/application identity is added to runtime keys or control-plane
  demand cardinality.

### v0.24.0 — Fleet coordination hardening

**Target duration:** 4–6 weeks
**Goal:** Harden Latchflo-managed capacity allocation across multiple Tyr replicas
and remove the remaining single-controller operational dependency.

Planned work:

- Define and test multi-controller failover semantics for Latchflo grants.
- Preserve monotonic controller epochs, revisions, and grant expiration across
  failover.
- Add allocator conflict, stale-leader, clock-skew, and network-partition tests.
- Let Latchflo distribute and update the capacity-routing topology without putting
  Latchflo on the per-request path.
- Expose controller health, grant age, expiration, routing-snapshot age, conflict,
  and degraded-mode metrics.
- Add multi-process Tyr and control-plane fault-injection tests.
- Publish conservative fail-closed deployment and recovery guidance.

Exit criteria:

- Multiple Tyr replicas cannot collectively exceed the capacity assigned by the
  active Latchflo controller.
- Controller failover cannot revive stale grants or create capacity.
- Routing membership can change without restarting Tyr and without routing loops.
- Operators can identify stale, expiring, conflicted, and unroutable grants from
  telemetry.

Non-goals:

- Embedding a second coordination system directly in Tyr.
- Automatically discovering provider quotas.
- Making Kubernetes the source of admission correctness.


### v1.0.0 — Supported production release

**Target duration:** 3–5 weeks after v0.24.0
**Goal:** Provide a stable, documented, supportable product for production design partners.

Planned work:

- Publish a versioned Docker image with SBOM, provenance, vulnerability scanning, and multi-architecture builds.
- Publish a Helm chart with PodDisruptionBudget, readiness/liveness probes, graceful termination, resource guidance, and network-policy examples.
- Define configuration compatibility and deprecation policies.
- Stabilize public TypeScript configuration, identity, policy, telemetry, and coordination interfaces.
- Add bounded shutdown deadlines and documented termination behavior.
- Add end-to-end load, soak, memory, disconnect, and coordinator-failure test suites.
- Publish supported Node.js, Redis, provider API, and deployment compatibility matrices.
- Choose and publish the product license and contribution policy.
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

1. A small centralized capacity coordinator when Redis operational or consistency limits become material.
2. Provider-quota allocation issued to replicas when Tyr has enough provider-specific quota data to rebalance intelligently.
3. Kubernetes-aware dynamic partitioning as an optional degraded or Redis-free mode, not the default distributed correctness mechanism.

## Explicitly out of scope before v1.0

- Competing with broad gateways on provider count.
- A full identity provider or API-key management platform.
- A general-purpose billing system.
- A proprietary observability dashboard before exported telemetry proves insufficient.
- Response caching or stochastic-request deduplication by default.
- Automatic retries after an upstream request may have begun.
- An unbounded admission queue.

## Commercial validation plan

Engineering milestones do not establish market viability on their own. Each design partner should have concurrent LLM workloads and an observable saturation problem, such as provider throttling, retry storms, unpredictable latency, GPU exhaustion, or interactive traffic being starved by batch work.

Track these outcomes during pilots:

- Provider `429` and timeout rate before and after Tyr.
- Requests rejected locally before upstream execution.
- Completion rate of high-priority traffic during saturation.
- Estimated versus actual token error distribution.
- Capacity utilization and reservation refund rate.
- User-visible tail latency.
- Operational incidents attributable to gateway or coordinator failure.
- Willingness to pay for distributed coordination, tenant policy, audit, or support.

The roadmap should be reconsidered if pilots do not show that early rejection protects more valuable work or reduces saturation incidents. In that case, Tyr should remain a focused open-source library and sidecar rather than expand into a standalone commercial platform.

## Release decision rules

A milestone may ship only when:

- New behavior has unit, integration, and failure-path coverage.
- Admission behavior remains fail-safe under malformed inputs and dependency failures.
- New metrics have bounded cardinality.
- Security-sensitive defaults require explicit opt-in to weaken.
- Upgrade and rollback behavior is documented.
- The release notes distinguish admission-time guarantees from post-admission usage overruns.

Timeline estimates are directional and should be revised after each design-partner milestone. Customer evidence may reorder protocol and integration work after v0.11.0, but observability, trustworthy identity, and distributed correctness remain prerequisites for a production product.


## Shipped in v0.23.0

- Protected identity-aware admission classes using
  `async-bulkhead-llm@3.15.1`.
- First-match claim rules, class-aware schema-3 routing, bounded telemetry, and
  fixed-key runtime class-limit updates.
- Latchflo-distributed class ceilings and protected floors with atomic grant
  application and shrink-by-attrition restoration.
- Bounded per-class demand heartbeats with accepted-heartbeat delta retention,
  protected/borrowed utilization, and additive capability signaling for future
  demand-aware class-floor lending.
