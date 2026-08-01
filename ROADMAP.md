# Tyr Admission Controller Roadmap

Tyr is an LLM admission controller. Its purpose is to prevent concurrent AI workloads from overcommitting finite provider or inference capacity by reserving token capacity before upstream execution begins.

This roadmap prioritizes the shortest path from the current `v0.17.0` capacity-aware routing release to a commercially credible product. It assumes one experienced TypeScript/backend engineer, automated tests and documentation for every milestone, and no custom management UI before `v1.0.0`.

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

## Current baseline: v0.17.0

The current release provides:

- Anthropic Messages and OpenAI Chat Completions proxy routes.
- Model-prefix routing to independently configured local pools.
- A v3.12 pool policy runtime using exact reservation previews, native observe
  mode, and complete versioned admission-limit snapshots.
- Tyr-local all-or-nothing runtime updates across named pools, with stale
  revision protection and shrink-by-attrition semantics.
- First-class Latchflo-managed operation with registration, persisted credentials,
  readiness, expiring grants, and fail-closed zero-capacity startup.
- Admission-linearized revisions and a bounded per-pool Latchflo provenance ledger
  containing grant ID, controller epoch, and expiration.
- Exact grant-attribution response headers for admissions, bypasses, and
  rejections.
- Adaptive per-model input estimates learned from provider-reported usage.
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

### v0.15.0 — Authenticated identity and telemetry export

**Target duration:** 2–3 weeks
**Goal:** Make Tyr safe for authenticated design-partner pilots and integrate its
telemetry with existing observability pipelines.

Planned work:

- Add JWT verification using configurable issuers, audiences, and JWKS endpoints.
- Derive a request context containing `tenantId`, `applicationId`, `subject`, and
  roles from verified claims.
- Authorize operator endpoints by role while retaining the simple bearer-token
  option for local deployments.
- Add OTLP/OpenTelemetry export without removing the built-in Prometheus endpoint.
- Add a documented durable audit-sink interface and identity fields to structured
  audit events.
- Add cardinality and authentication regression coverage.

Exit criteria:

- No unauthenticated request can obtain high priority or access protected
  operational data.
- Identity fields never become unbounded default metric labels.
- The same admission signals can be exported through Prometheus or OTLP.

Deferred from this release:

- Managed API-key issuance and rotation.
- Per-tenant bulkhead instances.
- A bundled audit search UI.

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

### v0.18.0 — Fleet coordination hardening

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

### v0.19.0 — Tenant policy and fairness

**Target duration:** 2–4 weeks
**Goal:** Support paid multi-tenant deployments without creating unbounded gateway
state.

Planned work:

- Add model-access allow and deny policies by tenant and application.
- Add bounded per-tenant token, concurrency, and priority policies within shared
  physical pools.
- Add weighted or reserved capacity for selected service classes.
- Define deterministic policy precedence across global, pool, tenant, and
  application scopes.
- Add policy versioning, validation, dry-run evaluation, and atomic reload.
- Include policy identifiers and versions in audit events.
- Add fairness and noisy-neighbor tests across multiple tenants and priorities.
- Add optional durable audit export through OpenTelemetry logs or a documented
  sink interface.

Exit criteria:

- A tenant cannot access a disallowed model or consume another tenant's reserved
  capacity.
- Policy reload cannot partially apply an invalid configuration.
- Tenant churn does not create unbounded timers, metric series, or bulkhead
  objects.
- Saturation tests demonstrate that interactive traffic remains available while
  lower-priority batch work is shed.

### v1.0.0 — Supported production release

**Target duration:** 3–5 weeks after v0.19.0
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
