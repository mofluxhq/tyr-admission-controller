# Tyr Gateway Roadmap

Tyr is an admission-first LLM gateway. Its purpose is to prevent concurrent AI workloads from overcommitting finite provider or inference capacity by reserving token capacity before upstream execution begins.

This roadmap prioritizes the shortest path from the current `v0.6.1` prototype to a commercially credible product. It assumes one experienced TypeScript/backend engineer, automated tests and documentation for every milestone, and no custom management UI before `v1.0.0`.

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

## Current baseline: v0.6.1

The current release provides:

- Anthropic Messages and OpenAI Chat Completions proxy routes.
- Model-prefix routing to independently configured local pools.
- Fail-fast concurrent-request and token-budget admission.
- Priority reserve support with secure-by-default priority handling.
- Provider-aware prompt, tool-schema, tool-call, and media admission estimates.
- Streaming usage correction, backpressure, response and idle timeouts.
- Graceful shutdown, local statistics, strict startup validation, and Node.js 20+ support.

Known commercial limitations include single-process capacity, no built-in request identity, no standard metrics exporter, no durable audit trail, limited protocol coverage, and no supported deployment package.

## Release sequence

### v0.7.0 — Observable and identifiable

**Target duration:** 2–3 weeks  
**Goal:** Make Tyr safe to pilot and capable of proving that admission control improves production outcomes.

Planned work:

- Add OpenTelemetry metrics with OTLP and Prometheus export options.
- Record admission and rejection counts by bounded pool, provider, priority, and reason labels.
- Export active token hold, configured budget, available capacity, and active request counts.
- Record provider `429`, response-timeout, idle-timeout, usage-overrun, client-disconnect, and stream-stall events.
- Record estimated, reserved, consumed, and refunded token values without high-cardinality metric labels.
- Add JWT verification using configurable issuers, audiences, and JWKS endpoints.
- Derive a request context containing `tenantId`, `applicationId`, `subject`, and roles from verified claims.
- Protect `/stats` and future administration routes with role-based authorization.
- Emit structured admission audit events with decision, reason, request identity, pool, model, priority, reservation, and relevant capacity snapshot.
- Add `/readyz` and make readiness false during shutdown.

Exit criteria:

- A local saturation test visibly correlates Tyr rejections with reduced upstream `429` responses.
- No unauthenticated request can obtain high priority or access protected operational data.
- Metrics pass cardinality tests and do not use tenant, subject, or request ID as default labels.
- Every admission and rejection produces a documented reason and structured audit event.

Deferred from this release:

- Managed API-key issuance and rotation.
- Durable audit storage or a search UI.
- Per-tenant bulkhead instances.

### v0.8.0 — Ecosystem and modern OpenAI support

**Target duration:** 2–3 weeks  
**Goal:** Reduce adoption friction and support the most commercially important modern OpenAI workload.

Planned work:

- Add an OpenAI Responses API adapter with streaming usage accounting.
- Account for instructions, input items, tool definitions, tool calls, images, files, and response output limits.
- Add direct OpenAI and Anthropic SDK integration examples and automated smoke tests.
- Add tested vLLM/OpenAI-compatible endpoint support and deployment guidance.
- Add a tested LiteLLM chaining configuration and identity-header propagation contract.
- Document a generic reverse-proxy integration contract for existing internal gateways.
- Publish an error and admission-reason compatibility reference.
- Add bounded non-streaming upstream response buffering.
- Forward a documented allowlist of provider diagnostic headers, including request identifiers where available.

Exit criteria:

- OpenAI Responses non-streaming and streaming requests pass admission, usage-correction, disconnect, timeout, and malformed-input tests.
- Direct SDK, vLLM, and LiteLLM examples run in CI against deterministic test services.
- An existing gateway can propagate authenticated tenant and application identity without exposing trusted priority headers to clients.

Deferred from this release:

- Bedrock support.
- Generic MCP session accounting.
- Native Kong or Envoy extensions.

### v0.9.0 — Distributed token leases

**Target duration:** 4–6 weeks  
**Goal:** Enforce one capacity budget across multiple Tyr replicas.

Planned work:

- Introduce a coordination interface independent of Redis-specific types.
- Implement Redis-backed atomic token and concurrency leases.
- Use unique lease IDs, bounded TTLs, heartbeats, idempotent release, and expired-lease reclamation.
- Define fail-open and fail-closed behavior explicitly per pool; default protected pools to fail closed.
- Ensure usage growth and refunds update distributed holds atomically.
- Add runtime pool-budget updates and zero-budget admission kill switches.
- Expose coordinator health, lease age, reclamation, conflict, and degraded-mode metrics.
- Add multi-process and fault-injection tests for crash recovery, network interruption, clock skew, duplicate release, and Redis failover.
- Document conservative capacity behavior during coordinator loss.

Exit criteria:

- Multiple gateway replicas cannot collectively admit more than the configured distributed budget, except for a documented bounded overrun caused by post-admission usage correction.
- A crashed replica's abandoned capacity is reclaimed within the configured lease window.
- Duplicate, delayed, or reordered lease operations cannot create capacity.
- Operators can disable a pool across all replicas without restarting them.

Non-goals:

- Building a custom centralized coordinator.
- Automatically discovering provider quotas.
- Kubernetes-only budget partitioning as the primary correctness mechanism.

### v0.10.0 — Tenant policy and fairness

**Target duration:** 2–4 weeks  
**Goal:** Support paid multi-tenant deployments without creating unbounded gateway state.

Planned work:

- Add model-access allow and deny policies by tenant and application.
- Add bounded per-tenant token, concurrency, and priority policies within shared physical pools.
- Add weighted or reserved capacity for selected service classes.
- Define deterministic policy precedence across global, pool, tenant, and application scopes.
- Add policy versioning, validation, dry-run evaluation, and atomic reload.
- Include policy identifiers and versions in audit events.
- Add fairness and noisy-neighbor tests across multiple tenants and priorities.
- Add optional durable audit export through OpenTelemetry logs or a documented sink interface.

Exit criteria:

- A tenant cannot access a disallowed model or consume another tenant's reserved capacity.
- Policy reload cannot partially apply an invalid configuration.
- Tenant churn does not create unbounded timers, metric series, or bulkhead objects.
- Saturation tests demonstrate that interactive traffic remains available while lower-priority batch work is shed.

### v1.0.0 — Supported production release

**Target duration:** 3–5 weeks after v0.10.0  
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

Timeline estimates are directional and should be revised after each design-partner milestone. Customer evidence may reorder post-v0.8 protocol and integration work, but observability, trustworthy identity, and distributed correctness remain prerequisites for a production product.
