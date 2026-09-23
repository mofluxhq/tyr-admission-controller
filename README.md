# Tyr Admission Controller

Tyr is an admission-first proxy for Anthropic Messages, OpenAI Chat
Completions, and the OpenAI Responses API. Before an upstream request begins,
Tyr projects the request into a token reservation, evaluates current concurrency
and token pressure, and either
enforces or observes the resulting admission decision.

Tyr 0.31.0 is built on
[`async-bulkhead-llm@3.17.0`](https://www.npmjs.com/package/async-bulkhead-llm),
unchanged from 0.30.0.
The committed lockfile uses the matching vendored tarball so Tyr's release gate
remains reproducible before or without registry access.
The pool runtime uses complete versioned limit snapshots, immutable reservation
previews, native observe mode, per-model adaptive estimation, stable admission
identities, streaming usage reconciliation, priority reserves, bounded
identity-aware admission classes, and bounded drain results.

> **Status:** v0.31.0, identity-aware distributed admission data plane,
> proprietary software. See [`LICENSE.txt`](LICENSE.txt). Tyr includes
> first-class Latchflo managed mode with configuration-driven registration,
> expiring grants, readiness, persisted agent credentials, demand reporting,
> and fail-closed expiration behavior.

## What changed in v0.31.0

- A `502 upstream_error` now names the transport failure. Node's `fetch`
  reports every connection failure as `fetch failed`. Tyr now walks the error's
  cause chain and adds a bounded `cause: { name, code }` to the response body,
  for example `ECONNREFUSED`, `ECONNRESET` or `UND_ERR_SOCKET`. The cause
  message is not returned, because it can contain internal host addresses.
- Every upstream failure, including a stream torn after headers were sent, is
  counted in `tyr_upstream_failures_total{pool,provider,code}`. It also emits one
  `tyr.diagnostic.v1` `upstream_failure` JSON line on stderr, with the code,
  syscall and bounded detail. This line is independent of
  `telemetry.audit.enabled`. Embedders can redirect it with
  `telemetry.diagnosticSink`.
- No admission, configuration, or Latchflo wire change.

## What changed in v0.30.0

- Added an optional per-admission-class `borrowedAdmissionSlot` policy. When an
  admission actually borrows local concurrency, Tyr starts the configured
  wall-clock deadline after admission and returns that local slot when the
  deadline expires.
- Made restoration contracts resource-specific. Deadline expiry releases Tyr's
  local admission slot with `deadline_abandonment` and requests upstream
  cancellation with an abort signal, but explicitly reports upstream reclamation
  as `unverified`.
- Kept token accounting separate from local concurrency. Abandoning a borrowed
  slot does not release its token reservation; the remaining accounting hold is
  retained until the local upstream callback settles.
- Added exact borrowed-resource attribution to admission context, provenance,
  response headers, audit events, `/stats`, and bounded-cardinality Prometheus
  metrics.
- Added the `504 borrowed_admission_deadline` response contract and executable
  verification proving that protected local work can enter after slot
  restoration while borrowed token accounting remains conservative.
- Added the additive Latchflo registration capability
  `borrowedAdmissionSlotDeadlines: true`. Numeric admission-class grants remain
  dynamically managed while the deadline policy stays local to Tyr.
- Updated and vendored `async-bulkhead-llm@3.17.0`; the transitive
  `async-bulkhead-ts@1.0.1` dependency is unchanged.

## What changed in v0.29.0

- Added `POST /v1/responses` on the configured OpenAI upstream, alongside the
  existing Chat Completions route. Requests are proxied in their native OpenAI
  shape; Tyr does not translate between API formats.
- Added token-aware projection for Responses `input`, `instructions`,
  `max_output_tokens`, request-visible function/custom tool definitions, text
  configuration, reasoning configuration, and multimodal `input_image` /
  `input_file` blocks. `input_text` blocks are normalized only inside the
  admission projection; the upstream receives the original request bytes.
- Added non-streaming usage reconciliation from `usage.input_tokens` /
  `usage.output_tokens` and semantic SSE reconciliation from Responses lifecycle
  events such as `response.completed`.
- Preserved OpenAI credential ownership and forwards `authorization`,
  `openai-organization`, and `openai-project` on both OpenAI routes.
- Kept the initial Responses boundary deliberately token-safe. Tyr rejects
  `previous_response_id`, server-side `conversation`, stored `prompt` templates,
  `item_reference`, `background: true`, and provider-managed retrieval/computer
  tools because those modes can introduce prompt or execution state that is not
  visible when Tyr must make its pre-upstream reservation. Request-visible
  `function` and `custom` tools are supported.
- Reprioritized multi-controller Latchflo hardening behind self-serve evaluation
  and demonstrated deployment demand rather than treating it as the automatic
  next release.
- Corrected stale current-state documentation while preserving historical
  release/version references where they describe the software that actually ran.

## What changed in v0.28.0

- Added Latchflo-managed dynamic fleet membership for capacity-aware Tyr routing.
  Latchflo 0.13+ may publish a complete versioned `routingTopology` in desired
  state; Tyr applies only newer revisions and replaces its peer set atomically.
- Removed peers become unroutable immediately and their cached capacity snapshots
  are discarded. New members and endpoint replacements must earn a fresh capacity
  snapshot before they can receive traffic.
- Latchflo publishes the complete fleet including the local member; Tyr always
  filters its own `instanceId`, rejects duplicate or malformed members, and ignores
  stale or duplicate topology revisions.
- Capacity polling now starts and stops as the dynamic peer set becomes non-empty
  or empty. Latchflo remains off the synchronous provider request path.
- Static `routing.capacityAware.peers` remain the startup/fallback topology for
  standalone deployments and for managed deployments talking to an older Latchflo
  that does not publish `routingTopology`.
- Latchflo-managed routing requires `routing.capacityAware.instanceId` to match
  `controlPlane.instanceId`, preventing a topology from accidentally routing back
  to the same Tyr process under a different identity.
- Added executable `verify:routing-topology` coverage for wire parsing, dynamic
  join, removal, stale-revision rejection, and replacement discovery.

## What changed in v0.27.0

- Added direct local admission-decision timing from `async-bulkhead-llm@3.16.0`
  without adding any control-plane round trip to the request path.
- Added `tyr_admission_decision_seconds`, which measures synchronous admission
  work while explicitly excluding time spent awaiting local concurrency
  capacity. The histogram is split by bounded `pool`, `outcome`
  (`admitted`/`rejected`), and configured admission class.
- Added `tyr_admission_queue_wait_seconds`, which separately measures the full
  local concurrency-acquire wait using the same bounded dimensions.
- Admission-decision buckets start at 5 microseconds and extend through 50 ms;
  the release headline is intended to use histogram `_sum` / `_count`, with
  buckets reserved for distribution diagnostics.
- Observe-mode bypasses are excluded from both timing metrics. Precheck
  rejections preserve an exact zero queue wait.
- `tyr.admission-provenance.v1` is unchanged. Timing remains Prometheus
  telemetry and does not alter the exact successful-admission proof schema.
- Updated and vendored the exact runtime dependency to
  `async-bulkhead-llm@3.16.0`; `async-bulkhead-ts@1.0.1` remains unchanged.

## What shipped in v0.26.0

- Added exact, bounded successful-admission provenance to each pool's `GET /stats`
  payload. Tyr records the event synchronously from async-bulkhead-llm's
  admission event, after concurrency/token capacity is held and before the
  upstream callback starts.
- Each `tyr.admissionProvenance.events[]` record carries the Tyr-generated
  `admissionId`, a pool-local monotonic sequence, admission timestamp, priority,
  optional admission class, exact limit revision, reserved tokens, an immutable
  copy of the applied limit snapshot, and the matching Latchflo grant provenance
  when the revision is managed.
- The per-pool ring is bounded at 512 events and reports `retained`, `dropped`,
  `captureFailures`, and `nextSequence` so benchmark tooling can detect both
  retention loss and an internal revision-evidence failure instead of silently
  treating incomplete evidence as proof.
- Admission provenance deliberately excludes request bodies, model prompts,
  authenticated identity, and client-supplied request IDs. Grant IDs, admission
  IDs, and revisions remain excluded from Prometheus labels.
- Admission policy, Latchflo wire behavior, and runtime dependency versions are
  unchanged from 0.25.1.

## What shipped in v0.25.1

- Restored the three vendored runtime tarballs required by the committed lockfile
  and Dockerfile. Clean source-tree Docker builds no longer fail with
  `ENOENT /app/vendor/*.tgz` during `npm ci`.
- Added `npm run verify:vendor`, which checks every `file:vendor/*.tgz` lockfile
  entry for presence and exact SHA-512 integrity and verifies the Dockerfile copies
  `vendor/` into the build context before installing dependencies.
- Runtime behavior and dependency versions are unchanged from 0.25.0.

## What shipped in v0.25.0

- Extended Tyr 0.24's acknowledged drain proof to restrictive admission-class
  transitions. Restoring a protected class floor now shrinks the shared
  concurrency/token remainder by attrition rather than waiting silently for the
  ordinary managed-mode heartbeat cadence.
- Added additive `capabilities.admissionClassOccupancyAck: true` registration
  metadata. Successful grant acknowledgements now include deterministic bounded
  class occupancy, including protected use, shared borrowing, hard ceilings, and
  token occupancy when configured.
- Added active `maxConcurrent` and `maxInFlightTokens` to bounded class demand
  snapshots so Latchflo can prove a fresh post-apply snapshot corresponds to the
  desired class table.
- A higher-revision class grant that restores protected floors or lowers a hard
  class ceiling triggers an immediate post-ack demand heartbeat. If the exact
  sent snapshot still exceeds the new shared remainder or class ceiling, Tyr
  temporarily uses the existing bounded 500 ms evidence cadence until attrition
  makes the transition safe.
- Active work is never cancelled or preempted. Latchflo 0.10 remains compatible
  by ignoring the additive fields; Latchflo 0.11+ can use them to commit
  class-only handoffs before lease expiry.
- Runtime dependencies remain `async-bulkhead-llm@3.15.1` and its
  `async-bulkhead-ts@1.0.1` dependency.

## What shipped in v0.24.0

- Added acknowledged capacity-handoff evidence for Latchflo-managed physical
  pool shrinks. After Tyr installs a lower complete grant and Latchflo accepts
  the normal `applied` acknowledgement, Tyr immediately publishes a distinct
  post-ack demand heartbeat instead of waiting for the ordinary heartbeat
  cadence.
- Added additive `capabilities.grantOccupancyAck: true` registration metadata
  and bounded occupancy evidence on successful grant acknowledgements
  (`appliedAt`, `inFlight`, `pending`, and `inFlightTokens` when available).
  Latchflo 0.10.0 ignores these unknown additive fields and continues to use
  the existing acknowledgement plus fresh-heartbeat proof.
- While a successfully acknowledged shrink remains above its new concurrency or
  token ceiling, Tyr temporarily publishes demand at a bounded 500 ms cadence.
  It automatically returns to Latchflo's configured heartbeat cadence after an
  exact published snapshot proves the drain target is safe.
- Serialized managed-mode heartbeats so a post-ack proof cannot collapse into a
  pre-ack request. Drain completion is evaluated against the exact occupancy
  snapshot actually sent, avoiding races when local work finishes while a
  heartbeat response is in flight.
- Active work is never cancelled or preempted. Shrinks still use the existing
  attrition semantics, and Latchflo lease expiry remains the conservative
  control-plane fallback when an acknowledgement or fresh proof cannot be
  obtained.
- Runtime dependencies remain `async-bulkhead-llm@3.15.1` and its
  `async-bulkhead-ts@1.0.1` dependency.

## What shipped in v0.23.0

- Added bounded per-admission-class demand snapshots to managed-mode Latchflo
  heartbeats. Each configured class reports live in-flight work, accepted-
  heartbeat admission/rejection deltas, budget/concurrency rejection pressure,
  protected utilization, and shared-capacity borrowing.
- Added per-class accepted-heartbeat checkpoints and `lastRequestAt` tracking, so
  failed heartbeats cannot discard class demand before Latchflo sees it.
- Added `capabilities.admissionClassDemand: true` during Latchflo registration.
  The extension was additive: the then-current Latchflo 0.8.x ignored the nested
  class-demand field while continuing to consume the existing pool-level snapshot.
- Kept policy ownership explicit. Tyr observes and reports class demand; later
  Latchflo releases can resize protected floors through the existing
  higher-revision grant path.
- Runtime dependencies remain `async-bulkhead-llm@3.15.1` and its
  `async-bulkhead-ts@1.0.1` dependency.

## What shipped in v0.22.0

- Added strict protected concurrency and in-flight token floors for bounded
  admission classes. Every floor and the aggregate floor set are validated
  against the class ceilings and physical pool envelope.
- Added protected, borrowed, and shared-capacity statistics plus bounded
  Prometheus series. Raw tenant/application identities remain excluded.
- Updated Latchflo grant handling so per-replica class partitions may resize
  protected floors atomically without revoking active work.
- Upgraded capacity-aware routing snapshots to schema version 3. Routing now
  predicts protection-layer rejection and excludes older peers when a request
  depends on protected-floor semantics.
- Updated the exact runtime dependency to `async-bulkhead-llm@3.15.1`.

## What shipped in v0.20.0

- Added bounded per-pool admission classes with independent concurrency and
  in-flight token ceilings. The fixed class table is validated at startup and
  cannot grow from tenant churn.
- Added ordered rules that map trusted JWT subject, tenant, application, and
  role claims to configured class IDs. First matching rule wins; selector
  categories within one rule are ANDed and values within one category are ORed.
- Added `x-admission-class`, class attribution in structured audit events,
  bounded `admission_class` decision labels, and live per-class capacity
  gauges/counters. Raw identity values remain excluded from metrics.
- Added class-aware capacity routing. A request is not forwarded to a replica
  whose selected class is unavailable or exhausted, even when the physical pool
  still has global headroom.
- Added atomic runtime updates for class ceilings with fixed-key validation and
  shrink-by-attrition behavior through `async-bulkhead-llm@3.14.0`.
- Latchflo continues to own the physical fleet grant. Tyr preserves its local
  class table across grant updates and grant-expiration kill-switch revisions.

## What shipped in v0.17.0

- Added optional capacity-aware routing across statically configured Tyr
  replicas. The ingress ranks fresh, ready candidates using request-specific
  concurrency and priority-adjusted token headroom.
- Added a shared-secret-protected internal capacity snapshot endpoint and
  asynchronous peer polling outside the provider request path.
- Added authenticated, single-hop Tyr-to-Tyr forwarding. The destination Tyr
  remains the authoritative admission controller, and routed requests are never
  automatically retried after dispatch.
- Added strict routing topology validation, spoofed-header rejection, bounded
  probe and forwarding deadlines, and response headers identifying the ingress
  and serving replica.
- Latchflo is unchanged in this release. Peer membership is static startup
  configuration and can be distributed by Latchflo in a later release.

## What shipped in v0.16.0

- Added completion-informed retry guidance for capacity rejections through the
  precise `x-admission-retry-after-ms` header and standards-based `Retry-After`
  when whole-second precision is appropriate.
- Added bounded retry-hint configuration without changing admission limits or
  automatically retrying provider requests inside Tyr.

## What shipped in v0.15.0

- Added first-class immutable request identity with `subject`, optional tenant and
  application attribution, and bounded roles.
- Added RS256/RS384/RS512 JWT verification against a cached JWKS endpoint, with
  issuer, audience, expiration, not-before, issued-at, algorithm, key-ID, size,
  timeout, and key-rotation validation.
- Provider requests are authenticated and role-authorized before Tyr buffers or
  parses their bodies. Identity uses `x-tyr-identity-token` by default so OpenAI
  and Anthropic provider credentials in `Authorization` remain untouched.
- Added any-of role policy for provider invocation, operator endpoints, and
  high-priority token-reserve access. When identity is enabled, raw
  `x-priority` cannot override verified role policy.
- Upgraded structured admission audit events to
  `tyr.admission-audit.v2`; admitted, observe-bypassed, and rejected decisions
  now include their authenticated identity without adding tenant-supplied values
  to Prometheus labels.

## What shipped in v0.14.0

- Added a native Prometheus text exporter at `GET /metrics` with bounded labels
  for admission decisions, rejections, request outcomes, upstream status,
  durations, pool capacity, token accounting, readiness, grant expiration, and
  Latchflo integration failures.
- Added optional structured JSON admission audit events. Each admitted,
  observe-bypassed, or rejected decision records its pool, provider, priority,
  model, exact limit revision, reservation, grant provenance, settlement, and
  final provider usage when available. Request, admission, model, and grant IDs
  are never used as metric labels.
- Added optional bearer-token protection for both `/stats` and `/metrics` through
  `TYR_OPERATOR_BEARER_TOKEN`; liveness and readiness probes remain public.
- Added a zero-cost Docker Compose demo with a mock OpenAI-compatible provider,
  Prometheus, an automatically provisioned Grafana dashboard, and repeatable
  normal-load and overload generators.
- Added Latchflo startup, poll, heartbeat, acknowledgement, and expiration
  failure counters without changing fail-closed grant enforcement.

## What shipped in v0.13.0

- Added first-class `controlPlane.type: latchflo` file configuration. Tyr now
  registers itself, polls desired state, applies complete higher-revision grant
  snapshots, acknowledges results, and retries startup without source edits.
- Added `/readyz`, which returns `503` until every managed pool has a valid,
  unexpired Latchflo grant. `/healthz` remains a process-liveness probe.
- Added atomic persistence of rotated per-instance agent tokens with `0600`
  permissions and graceful agent shutdown before gateway drain.
- Managed pools now start with `maxConcurrent: 0`, `maxQueue: 0`, revision
  `0`, and enforcement enabled. This requires `async-bulkhead-llm` 3.12.0 and
  ensures Tyr is fail closed before its first valid grant arrives.
- Added runtime validation for desired-state identities, epochs, revisions,
  timestamps, duplicate pools, and token-budget relationships. A stale persisted
  credential is re-registered once on `401` when a bootstrap token is available.
- Latchflo provenance emitted by the built-in agent now uses
  `source: "latchflo"`. Deprecated `x-korrx-*` response aliases remain for
  downstream migration.

## What shipped in v0.12.0

- Accepted `source: "latchflo"` on admission provenance alongside the legacy
  `source: "korrx"`, so Tyr and the control plane can be rolled out in either
  order during the Latchflo rebrand.
- Added `x-latchflo-grant-id` and `x-latchflo-controller-epoch` response
  headers, emitted alongside the existing `x-korrx-*` pair with identical
  values.

## What shipped in v0.11.1

- Corrected the embedded-agent contract to accept Korrx provenance with
  `source: "korrx"`.
- Renamed grant-attribution headers to `x-korrx-grant-id` and
  `x-korrx-controller-epoch`.
- Added regression tests across the real pool-validation and gateway-response
  paths for admitted, bypassed, and rejected decisions.

## What shipped in v0.11.0

- Upgraded and pinned `async-bulkhead-llm` to exactly 3.11.1.
- Added complete per-pool snapshots covering concurrency, queue capacity, token
  budget, and high-priority reserve.
- Added strictly increasing revisions and stale-update rejection.
- Added Tyr-local all-or-nothing batch application across named pools.
- Added a narrow `control` interface from `createGateway()` for an embedded
  control-plane agent.
- Delegated observe-mode execution and accounting to the library's native v3.11
  implementation, including bypass identities and bypass release usage.
- Added request headers for preview and authoritative limit revisions.
- Added immutable Korrx grant provenance keyed by the exact admission revision,
  with grant and controller-epoch response headers.
- Added queue and initial-revision startup configuration.
- Corrected CI to validate Tyr's actual flat ESM/declaration package layout.

See [`CHANGELOG.md`](CHANGELOG.md) for the complete release history and
[`ROADMAP.md`](ROADMAP.md) for planned work.

## Latchflo managed-mode overview

Use [`config/tyr.latchflo.example.yaml`](config/tyr.latchflo.example.yaml) as the
starting point. Managed pools must begin closed:

```yaml
pools:
  - name: openai-primary
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 0
    maxQueue: 0
    limitsRevision: 0
    admissionMode: enforce

controlPlane:
  type: latchflo
  url: http://latchflo-control-plane:8080
  instanceId: tyr-a
  pools: [openai-primary]
  bootstrapTokenEnv: LATCHFLO_AGENT_BOOTSTRAP_TOKEN
  agentTokenFile: /var/lib/tyr/latchflo-agent.token
```

`/healthz` reports process liveness. `/readyz` returns `503` until all managed
pools hold valid grants and returns to `503` when a grant expires. The listener
may therefore remain observable while admission remains safely closed.

With Latchflo 0.6 or newer, the same authenticated heartbeat also carries a
bounded demand snapshot for every managed pool. No additional endpoint or
request-path callback is required. Latchflo can use these observations for
work-conserving capacity groups while continuing to fence all allocations with
expiring grants.

## Request lifecycle

For each provider request, Tyr:

1. Authenticates and authorizes the caller before buffering the request when
   identity is enabled.
2. Buffers and validates the JSON body within the configured size limit.
3. Routes the model to the longest matching pool prefix and projects provider
   prompt content into an admission request.
4. Computes one immutable reservation preview.
5. When capacity-aware routing is enabled, compares the local grant partition
   with fresh peer snapshots and may forward the request once to a roomier Tyr.
6. The serving Tyr captures its complete versioned limit snapshot, computes its
   own authoritative reservation, and calls the native v3.15 `run()` path in
   the configured `enforce` or `observe` mode.
7. Reconciles live and final provider usage. Budgeted streams progressively
   return processed capacity when cumulative usage is available; native observe
   bypass releases also feed adaptive estimation.
8. Releases remaining capacity when the request completes, fails, or the client
   disconnects.

Tyr does not translate between Anthropic and OpenAI request formats.

## Capacity semantics

A pool's `inFlightTokenBudget` is an **admission-time in-flight ceiling**. An
admitted request reserves estimated input plus `max_tokens` or
`max_completion_tokens`, falling back to the pool's
`defaultOutputReservation` when the request does not provide an output limit.
Actual provider usage refunds unused capacity at completion, and streaming
usage can correct the active hold while the response is running.

Usage reported after admission can exceed the original estimate. In that case,
`async-bulkhead-llm` expands the active hold, so live `inFlightTokens` may
temporarily exceed the configured ceiling. Tyr blocks new admissions until
capacity is released; it does not abort an already-running request. This is
deliberate overrun accounting, not a strict post-admission kill switch.

Admission estimation uses the library request surfaces instead of folding the
entire provider request into a synthetic user message:

- Anthropic `system` and provider messages remain first-class request fields.
- Tool schemas, tool calls, response formats, roles, and provider-specific
  prompt metadata are charged through `extraInputTokens`.
- Opaque image, audio, document, file, and video blocks use the library's
  `opaqueBlockTokens` policy.
- Inline binary payload text is omitted from literal prompt estimation so a
  base64 payload is not mistaken for ordinary text.

The estimate is intended for load shedding and capacity protection. It is not a
billing-grade tokenizer or a substitute for provider usage records.

For token-budgeted pools, adaptive estimation is enabled by default. Tyr records
provider-reported input usage on release and applies the library's bounded
per-model EWMA correction after the configured minimum sample count. Output
reservations are never adapted. Calibration is local, in-memory, and reset when
the process restarts.

## Identity-aware admission classes

Admission classes partition a physical pool into a bounded set of service
classes. They are intended for noisy-neighbor isolation, not provider RPM/TPM
rate limiting or cumulative spend policy.

```yaml
pools:
  - name: openai-primary
    modelPrefixes: [gpt, o1, o3, o4]
    estimatorModel: gpt-4o
    maxConcurrent: 40
    inFlightTokenBudget: 400000
    admissionClasses:
      defaultClass: standard
      classes:
        standard:
          protectedConcurrent: 12
          maxConcurrent: 32
          protectedInFlightTokens: 100000
          maxInFlightTokens: 300000
          borrowedAdmissionSlot:
            releaseMechanism: deadline_abandonment
            deadlineMs: 30000
        premium:
          protectedConcurrent: 8
          maxConcurrent: 24
          protectedInFlightTokens: 80000
          maxInFlightTokens: 240000
      rules:
        - admissionClass: premium
          tenantIds: [tenant-paid]
        - admissionClass: premium
          applicationIds: [latency-sensitive-app]
          roles: [tier.premium]
```

The class table is fixed at startup and capped at 64 entries. Rules are capped
at 256 entries, each selector list is capped at 256 values, and only configured
class IDs appear in runtime state or metrics. A request with no matching rule
uses `defaultClass`. When multiple selector categories appear in one rule they
must all match; the first matching rule wins.

Each class may define a protected floor and a hard ceiling beneath the physical
pool limit. A request consumes its own protected capacity first; work above that
floor borrows from the shared remainder left after every configured floor. A
request must fit the physical pool, its hard class ceiling, and the currently
available shared remainder.

Protected floors are strict within the active local limit snapshot. An idle
floor is not implicitly lent to another class; Latchflo can implement
demand-aware lending by issuing a newer atomic class-limit snapshot. Increasing
or shrinking a floor or ceiling stops unsafe new borrowing, but existing work
otherwise restores protection by attrition.

`borrowedAdmissionSlot` places a post-admission wall-clock lease on local
concurrency borrowed by that class. It does not apply when the admission fits
inside the class's own protected concurrency. At expiry Tyr returns the borrowed
local slot, aborts the linked callback signal, and returns
`504 borrowed_admission_deadline` to a caller whose response has not started.
The admission's token reservation remains held until the local callback settles,
so returning one resource cannot falsely return another.

That deadline is an enforceable restoration bound only for Tyr's local admission
slot. A provider may continue generating after client cancellation, so Tyr
reports upstream cancellation as requested and upstream reclamation as
unverified. If an account quota, model-side queue, or accelerator is the
constrained resource, retain an unlent floor or an independently enforceable
provider partition for the protected workload. A Tyr deadline alone is not that
upstream guarantee.

Class selection uses authenticated identity produced by Tyr's identity layer.
Without identity, all requests use the configured default class. Programmatic
embedders may supply `resolveAdmissionClass`, but the returned value must still
name a configured class. Never map arbitrary tenant IDs directly to class IDs.

Prometheus exposes bounded per-class protected, borrowed, in-flight,
configured-ceiling, admission, release, and rejection series using only the
configured class ID. Per-pool shared-remainder gauges and `/stats` expose the
corresponding capacity and token-accounting totals.

Latchflo 0.7 and newer may distribute the per-replica class limit table on each
grant. Tyr 0.22 applies protected floors and hard ceilings atomically with the
physical pool revision while keeping identity-to-class rules local.

## Capacity-aware replica routing

Tyr can optionally route an external request to another Tyr replica before
admission. Each replica publishes a shared-secret-protected capacity snapshot
and polls its configured peers outside the request path. For each validated
request, the ingress replica computes the exact local reservation and ranks
fresh, ready replicas by the capacity that would remain after admitting it:

- immediate physical-pool concurrency headroom;
- priority-adjusted physical-pool token headroom when configured;
- selected admission-class concurrency and token headroom;
- shared capacity remaining after protected class floors; and
- the tightest normalized constraint, so global capacity cannot hide a hard
  class ceiling or protection-layer rejection.

Equal candidates prefer the local replica to avoid an unnecessary hop.
Observe-mode pools stay local and are never selected as remote destinations, so
shadow evaluation cannot silently change the request topology or bypass an
enforce-mode ingress decision. A forwarded request carries an authenticated one-hop marker and the selected
bounded admission-class ID under the same shared secret. The class cannot be
reclassified by a drifting destination policy, and the request can never be
forwarded again, preventing routing loops. The destination Tyr remains the
authoritative admission controller and may still reject if capacity changed
after the last snapshot. Tyr never retries a request after forwarding it.

This does not replace Latchflo. Latchflo still owns bounded fleet-wide grants;
capacity-aware routing only chooses which current grant partition should
evaluate a request. Replicas sharing a pool name must use compatible request
projection and estimator policy. Tyr refuses to route between token-aware and token-unaware definitions of the
same pool. Schema-3 snapshots carry protected and borrowed capacity; when local
floors are configured, schema-1/2 peers are excluded because they cannot prove
equivalent enforcement. In Latchflo managed mode, Latchflo 0.13+ may publish a
complete versioned routing topology in desired state. Tyr applies only newer
revisions, filters itself, drops removed-peer capacity immediately, and begins
polling newly advertised peers without a restart. The Tyr-to-Tyr shared secret is
never distributed by Latchflo and remains local configuration. Standalone Tyr, or
managed Tyr connected to an older Latchflo, keeps the configured startup peer list.

```yaml
routing:
  capacityAware:
    instanceId: tyr-r1
    sharedSecretEnv: TYR_ROUTING_SECRET
    pollIntervalMs: 100
    staleAfterMs: 1000
    probeTimeoutMs: 250
    forwardTimeoutMs: 30000
    peers:
      - id: tyr-r2
        baseUrl: http://tyr-r2:8787
      - id: tyr-r3
        baseUrl: http://tyr-r3:8787
```

Set the same random `TYR_ROUTING_SECRET` on every listed replica. Keep peer
URLs on a trusted private network and use TLS whenever that network is not
cryptographically isolated. Successful forwarding adds `x-tyr-routed-by` and
`x-tyr-routed-to` to the client response.

## Admission modes

`enforce` is the default and returns the normal `429`/`503` admission response.
`observe` runs the same reservation and capacity decision but proxies requests
that would have failed for budget, concurrency, queue, or admission timeout.
Those bypasses receive a synthetic `shadow-...` admission ID and are counted in
`/stats`. Shutdown and client-abort behavior are never shadowed.

Observe mode models the system that would exist under enforcement: requests
that would be rejected do not consume simulated pool capacity. It is therefore
appropriate for measuring prospective rejection rates before enabling policy,
not for representing actual upstream load while bypasses are running.

## HTTP routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/messages` | Identity-authorized, admission-gated Anthropic Messages proxy |
| `POST` | `/v1/chat/completions` | Identity-authorized, admission-gated OpenAI Chat Completions proxy |
| `POST` | `/v1/responses` | Identity-authorized, admission-gated OpenAI Responses proxy |
| `GET` | `/stats` | Live per-pool statistics; optional operator JWT role or bearer token |
| `GET` | `/metrics` | Prometheus text; optional operator JWT role or bearer token |
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Managed readiness; `503` until all configured Latchflo grants are valid |
| `GET` | `/_tyr/capacity` | Protected internal capacity snapshot when replica routing is configured |

A provider route is enabled only when its upstream base URL is configured.
Calling a disabled provider route returns `404` with
`error.type: "route_not_configured"`.

### Forwarded request headers

Tyr forwards only the provider headers below. Provider credentials remain owned
by the calling application and must not be placed in Tyr configuration files.

| Provider route | Forwarded headers |
|---|---|
| Anthropic | `content-type`, `x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta` |
| OpenAI | `content-type`, `authorization`, `openai-organization`, `openai-project` |

### Admission response headers

Every validated, pool-routed request includes an advisory snapshot:

| Header | Meaning |
|---|---|
| `x-admission-mode` | `enforce` or `observe` |
| `x-admission-class` | Bounded configured class selected for the request, when admission classes are enabled |
| `x-admission-preview` | Advisory `admit` or `reject` result at request arrival |
| `x-admission-preview-revision` | Limit revision used for the advisory preview |
| `x-admission-preview-reason` | Present when the advisory result rejects |
| `x-admission-reserved-tokens` | Exact input-plus-output reservation when a token budget exists |
| `x-admission-id` | Bulkhead UUID, or `shadow-...` for an observe-mode bypass |
| `x-admission-outcome` | `admitted` or native v3.12 `bypassed` outcome |
| `x-admission-revision` | Revision active when execution began; immediate rejections use the preview revision |
| `x-admission-slot-borrowed` | `true` when this admission used shared rather than class-protected local concurrency |
| `x-admission-borrowed-tokens` | Tokens attributed to the shared rather than class-protected token remainder |
| `x-admission-slot-deadline-ms` | Configured local borrowed-slot deadline when it applies; repeated on deadline errors |
| `x-admission-bypass-reason` | Capacity reason simulated by an observe-mode bypass |
| `x-latchflo-grant-id` | Exact Latchflo capacity grant associated with `x-admission-revision`, when present |
| `x-latchflo-controller-epoch` | Latchflo fencing epoch that issued the associated grant |
| `x-korrx-grant-id` | Deprecated alias of `x-latchflo-grant-id`, identical value |
| `x-korrx-controller-epoch` | Deprecated alias of `x-latchflo-controller-epoch`, identical value |
| `x-tyr-routed-by` | Ingress Tyr instance that selected a remote replica; present only after forwarding |
| `x-tyr-routed-to` | Tyr instance that performed the authoritative admission and provider invocation |

Actual admission rejections also include `x-admission-reason`, and — when Tyr
has enough evidence — a retry hint:

| Header | Meaning |
|---|---|
| `x-admission-retry-after-ms` | The estimated wait in milliseconds. Always present when Tyr has a hint. Prefer this. |
| `retry-after` | The same wait in whole seconds, per RFC 9110. Rounded up, so a caller that obeys it never arrives before capacity exists. **Only sent when the wait is at least one second** — below that the header cannot express it without overstating it badly, and Tyr leaves the client's own backoff alone rather than parking it five times too long. |

Tyr estimates the wait from **observed upstream completion intervals** for the
pool, held as a time-decayed moving average, combined with the queue depth or
token deficit reported in the rejection detail. This is why the hint lives in
Tyr and not in `async-bulkhead-llm`: the library only sees admission decisions
and correctly refuses to invent an ETA it has no basis for, whereas Tyr proxies
the work and watches it finish.

The honesty rule survives the move. Until a pool has produced
`retryHint.minSamples` completions, **no header is emitted at all** — a missing
hint means "unknown", never a guess. Hints are omitted entirely for `shutdown`
(this instance is draining; re-resolve rather than wait), `aborted` (the caller
already gave up), and `unshareable_result` (a deduplication conflict that
waiting cannot resolve).

Set `retryHint.enabled: false`, or `TYR_RETRY_HINT_ENABLED=false`, to suppress
both headers.

Advisory results are not guarantees; capacity can change before authoritative
admission, and a retry hint is an estimate rather than a reservation.

### Error contract

| Status | Error type or reason | Meaning and retry guidance |
|---:|---|---|
| `400` | `invalid_json` or `invalid_request` | The request is malformed; correct it before retrying. |
| `401` | `identity_required`, `identity_invalid`, `operator_unauthorized`, or `routing_unauthorized` | Identity or an internal routing credential is missing or invalid; do not retry the same credential unchanged. |
| `403` | `identity_forbidden` | The verified identity lacks a required role; retry only after authorization changes. |
| `404` | `not_found`, `route_not_configured`, `routing_not_configured`, or `metrics_disabled` | The route is unknown, its upstream or replica routing is disabled, or metrics exposition is disabled. |
| `413` | `payload_too_large` | The request body exceeds `server.maxRequestBodyBytes`. |
| `422` | `unsupported_model` | No configured pool matches the requested model. |
| `429` | `admission_rejected`, commonly `budget_limit` or `concurrency_limit` | Tyr is protecting bounded capacity; honor `x-admission-retry-after-ms` when present, otherwise retry with backoff or reduce demand. |
| `500` | `internal` | Tyr encountered an unexpected internal failure; retry according to the caller's server-error policy. |
| `502` | `upstream_error` or `routing_peer_unavailable` | The provider or selected Tyr peer failed before a valid response was returned. `upstream_error` carries `cause.code` (for example `ECONNREFUSED` or `UND_ERR_SOCKET`) when the transport reported one. A routed request is not automatically replayed. |
| `503` | `identity_unavailable` | Tyr cannot currently verify identity because the verifier or JWKS endpoint is unavailable; retry with backoff. |
| `503` | `admission_rejected` with reason `shutdown` | This Tyr instance is draining and no longer accepts admissions; retry another instance or retry with backoff. |
| `504` | `borrowed_admission_deadline` | Tyr returned a borrowed local slot and requested upstream cancellation. The body reports local release as enforced and upstream reclamation as unverified; retry only when the operation is safe to repeat. |
| `504` | `response_timeout`, `idle_timeout`, `routing_peer_timeout`, or `admission_rejected` with reason `timeout` | A provider, selected Tyr peer, stream-idle, or queued-admission deadline expired; retry only according to the operation's idempotency policy. |

Admission rejection bodies include the pool name and the bounded capacity detail
reported by `async-bulkhead-llm`. Identity errors use `error.type` and do not
include admission-capacity details. Only `401` identity responses include a
`WWW-Authenticate` challenge; `503 identity_unavailable` deliberately does not.

## Requirements

- Node.js 20 or newer.
- At least one Anthropic-shaped or OpenAI-shaped upstream.
- Provider credentials supplied by the calling client.

## Quick start

Install dependencies and run the release checks:

```bash
npm ci
npm run release:check

# Zero-cost metrics demonstration
npm run demo:up
npm run demo:normal
npm run demo:overload
npm run demo:down
```

Copy the example configuration:

```bash
cp config/tyr.example.yaml tyr.yaml
```

Edit `tyr.yaml`, then validate it without opening a listener:

```bash
npm run validate:config -- --config ./tyr.yaml
```

Successful validation prints the resolved file path, schema version, SHA-256
configuration fingerprint, port, pool names, and enabled routes.

Start Tyr:

```bash
TYR_CONFIG_FILE=./tyr.yaml npm start
```

At startup, Tyr validates the entire file before calling `server.listen()`.
Unreadable files, malformed YAML, unknown properties, invalid URLs, duplicate
pool names or model prefixes, unsafe numeric values, and invalid reserve
relationships terminate the process with a nonzero exit code.

Startup configuration seeds pool routing, estimator policy, timeout behavior,
and the initial admission-limit snapshot. Routing and estimator changes still
require a restart. Concurrency, queue capacity, token budget, and high-priority
reserve can be replaced at runtime through the versioned `control` interface;
existing work drains under the new ceilings and is never cancelled merely
because a limit shrank.

## Example requests

Anthropic Messages:

```bash
curl -i http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_ANTHROPIC_API_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Explain admission control."}]
  }'
```

OpenAI Chat Completions:

```bash
curl -i http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  --data '{
    "model": "gpt-4o",
    "max_completion_tokens": 512,
    "messages": [{"role": "user", "content": "Explain admission control."}]
  }'
```

OpenAI Responses (recommended for new OpenAI integrations):

```bash
curl -i http://127.0.0.1:8787/v1/responses \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  --data '{
    "model": "gpt-5.6",
    "max_output_tokens": 512,
    "input": "Explain admission control."
  }'
```

Tyr 0.31.0 supports stateless synchronous and streaming Responses requests. To
keep pre-admission token reservations bounded from request-visible state, it
rejects `previous_response_id`, server-side `conversation`, stored `prompt`
templates, `item_reference`, `background: true`, and provider-managed
retrieval/computer tools. Request-visible `function` and `custom` tools are
supported.

For OpenAI Chat Completions streaming requests, set
`stream_options: { "include_usage": true }` when supported so Tyr can reconcile
usage from the final stream chunk. Responses streams reconcile cumulative usage
from semantic lifecycle events such as `response.completed`. Anthropic streaming
usage is extracted from supported `message_start` and `message_delta` events.

## File configuration

Set `TYR_CONFIG_FILE` to select file mode. Relative paths are resolved from the
process working directory:

```bash
TYR_CONFIG_FILE=/etc/tyr/config.yaml
```

Values are literal. Tyr does not expand `${ENV_VAR}` placeholders inside YAML.
Keep provider credentials in the calling application or its secret manager.

File mode does not merge with legacy Tyr environment variables. When
`TYR_CONFIG_FILE` is set, variables such as `PORT`, `UPSTREAM_URL`,
`TOKEN_BUDGET`, and `MAX_CONCURRENT` cause startup to fail. This keeps the
effective policy deterministic and reviewable.

When `TYR_CONFIG_FILE` is absent, Tyr uses the legacy single-pool environment
configuration documented in [`.env.example`](.env.example).

## Progressive streaming reconciliation

Progressive reconciliation, introduced in Tyr 0.22, uses the current
`async-bulkhead-llm@3.17.0` runtime to account for the work still ahead
instead of retaining tokens the provider has already processed. For a
streaming request, the first cumulative input report returns the completed
input reservation. Later cumulative output reports shrink the remaining
future-output hold. Updates are coalesced so every token does not create an
accounting write, and a configurable safety floor remains until final release.

```yaml
pools:
  - name: interactive-claude
    inFlightTokenBudget: 400000
    progressiveReconciliation:
      enabled: true                 # default for budgeted pools
      updateStepTokens: 256         # apply after this much additional release
      outputSafetyMarginTokens: 256 # retained until completion
```

`GET /stats` exposes `tyr.progressiveReconciliation` with report, update,
coalescing, and early-release counters. Disable the block explicitly to retain
the conservative 3.12 hold behavior. Streams without cumulative provider usage
remain conservative automatically. The repository lockfile resolves the bundled
`vendor/async-bulkhead-llm-3.17.0.tgz` and
`vendor/async-bulkhead-ts-1.0.1.tgz`, so the release can be built before those
artifacts are fetched from a public registry.


## Configuration schema

Every configuration file must declare the current schema version:

```yaml
version: 1
```

The documented template is
[`config/tyr.example.yaml`](config/tyr.example.yaml). Editor and CI tooling can
use [`config/tyr.schema.json`](config/tyr.schema.json), while runtime validation
remains the source of truth for cross-field rules.

### Complete example

```yaml
version: 1

server:
  port: 8787
  maxRequestBodyBytes: 1048576
  maxOutputTokens: 200000

upstreams:
  anthropic:
    baseUrl: https://api.anthropic.com
  openai:
    baseUrl: https://api.openai.com

timeouts:
  responseHeadersMs: 30000
  streamIdleMs: 30000
  clientStallMs: 30000

shutdown:
  drainTimeoutMs: 30000

priority:
  trustHeader: false

identity:
  jwt:
    jwksUrl: https://identity.example.com/.well-known/jwks.json
    issuer: https://identity.example.com/
    audience: moflux-tyr
    header: x-tyr-identity-token
    algorithms: [RS256]
    claims:
      subject: sub
      tenantId: tenant_id
      applicationId: azp
      roles: roles
  roles:
    invoke: [tyr.invoke]
    operator: [tyr.operator]
    highPriority: [tyr.priority.high]

telemetry:
  metrics:
    enabled: true
  audit:
    enabled: false

pools:
  - name: interactive-claude
    modelPrefixes: [claude-sonnet-4, claude-haiku-4]
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
    maxQueue: 0
    limitsRevision: 100
    admissionMode: enforce
    inFlightTokenBudget: 400000
    highPriorityTokenReserve: 80000
    defaultOutputReservation: 8192
    opaqueMediaInputTokenReservation: 2048
    adaptiveEstimation:
      enabled: true
      smoothing: 0.2
      minSamples: 5
      minCorrection: 0.5
      maxCorrection: 2
      maxModels: 64

  - name: batch-openai
    modelPrefixes: [gpt-4o, gpt-5, o1, o3, o4]
    estimatorModel: gpt-4o
    maxConcurrent: 20
    maxQueue: 0
    limitsRevision: 100
    admissionMode: observe
    inFlightTokenBudget: 250000
    defaultOutputReservation: 4096
```

### Field reference

| Field | Required | Meaning |
|---|---:|---|
| `version` | Yes | Configuration schema version; currently `1` |
| `server.port` | No | Listen port; default `8787` |
| `server.maxRequestBodyBytes` | No | Maximum buffered request body; default 1 MiB |
| `server.maxOutputTokens` | No | Validation ceiling for request output-limit fields; default `200000` |
| `upstreams.anthropic.baseUrl` | One upstream required | Enables `POST /v1/messages` |
| `upstreams.openai.baseUrl` | One upstream required | Enables `POST /v1/chat/completions` and `POST /v1/responses` |
| `timeouts.responseHeadersMs` | No | Maximum wait for upstream response headers |
| `timeouts.streamIdleMs` | No | Maximum gap between upstream stream chunks |
| `timeouts.clientStallMs` | No | Maximum wait for a backpressured client to drain |
| `shutdown.drainTimeoutMs` | No | Bounded graceful-drain deadline; omit for unbounded drain |
| `priority.trustHeader` | No | Legacy trusted-proxy fallback; ignored on provider routes when identity is configured |
| `identity.jwt.jwksUrl` | Identity only | HTTP(S) JWKS endpoint used to verify JWT signatures |
| `identity.jwt.issuer` | Identity only | Exact required `iss` claim |
| `identity.jwt.audience` | Identity only | Required audience string or list; at least one must match `aud` |
| `identity.jwt.header` | No | Header containing `Bearer <JWT>`; default `x-tyr-identity-token` |
| `identity.jwt.algorithms` | No | Allowed RSA algorithms; default `[RS256]` |
| `identity.jwt.cacheTtlMs` | No | JWKS cache lifetime; unknown `kid` forces one refresh |
| `identity.jwt.requestTimeoutMs` | No | JWKS request deadline; default `5000` |
| `identity.jwt.clockSkewSeconds` | No | Clock tolerance for `exp`, `nbf`, and `iat`; default `30` |
| `identity.jwt.requireExpiration` | No | Require `exp`; default `true` |
| `identity.jwt.claims.*` | No | Claim names for subject, tenant, application, and roles |
| `identity.roles.invoke` | No | Any matching role may invoke provider routes; omitted/empty allows any authenticated identity |
| `identity.roles.operator` | No | Any matching role may read `/stats` and `/metrics` |
| `identity.roles.highPriority` | No | Any matching role receives `high` admission priority |
| `routing.capacityAware.instanceId` | Routing only | Stable identifier for this Tyr replica |
| `routing.capacityAware.sharedSecretEnv` | Routing only | Environment variable containing the shared Tyr-to-Tyr secret |
| `routing.capacityAware.peers` | Routing only | Startup/fallback peer IDs and base URLs; managed Latchflo 0.13+ topology replaces the set after the first newer topology snapshot |
| `routing.capacityAware.pollIntervalMs` | No | Peer snapshot refresh cadence; default `100` |
| `routing.capacityAware.staleAfterMs` | No | Maximum usable peer snapshot age; default `1000` |
| `routing.capacityAware.probeTimeoutMs` | No | Peer capacity-probe deadline; default `250` |
| `routing.capacityAware.forwardTimeoutMs` | No | Deadline for a routed peer to return response headers; default `30000` |
| `telemetry.metrics.enabled` | No | Expose Prometheus text at `/metrics`; default `true` |
| `telemetry.audit.enabled` | No | Emit one structured JSON line per admission decision; default `false` |
| `pools[].name` | Yes | Unique pool name used in stats and rejection details |
| `pools[].modelPrefixes` | Yes | Unique prefixes; longest matching prefix wins |
| `pools[].estimatorModel` | Yes | Model used for estimator ratios; requests are not rewritten |
| `pools[].maxConcurrent` | Yes | Maximum active requests in the pool |
| `pools[].maxQueue` | No | Maximum accepted waiters; default `0` for fail-fast admission |
| `pools[].queueTimeoutMs` | No | Construction-time timeout for queued requests |
| `pools[].limitsRevision` | No | Initial non-negative admission-limit revision; default `0` |
| `pools[].admissionMode` | No | `enforce` (default) or shadow `observe` |
| `pools[].inFlightTokenBudget` | No | Admission-time in-flight token ceiling |
| `pools[].highPriorityTokenReserve` | No | Token headroom reserved for high-priority requests |
| `pools[].defaultOutputReservation` | No | Output reservation used when the request omits an output limit |
| `pools[].opaqueMediaInputTokenReservation` | No | Fixed surcharge per opaque media/document block; default `2048`, `0` disables it |
| `pools[].adaptiveEstimation.enabled` | No | Enables local per-model correction; default `true` for budgeted pools |
| `pools[].adaptiveEstimation.smoothing` | No | EWMA smoothing in `(0, 1]`; default `0.2` |
| `pools[].adaptiveEstimation.minSamples` | No | Samples before applying correction; default `5` |
| `pools[].adaptiveEstimation.minCorrection` | No | Lower factor clamp; default `0.5` |
| `pools[].adaptiveEstimation.maxCorrection` | No | Upper factor clamp; default `2` |
| `pools[].adaptiveEstimation.maxModels` | No | Maximum tracked model keys; default `64` |
| `pools[].admissionClasses.defaultClass` | Classes only | Configured class used when no ordered identity rule matches |
| `pools[].admissionClasses.classes` | Classes only | Fixed map of at most 64 class IDs to optional protected floors and hard concurrency/token ceilings |
| `pools[].admissionClasses.classes.<id>.borrowedAdmissionSlot.releaseMechanism` | No | Must be `deadline_abandonment`; releases only borrowed local concurrency |
| `pools[].admissionClasses.classes.<id>.borrowedAdmissionSlot.deadlineMs` | With borrowed-slot policy | Post-admission local slot lease from `1` through `2147483647` ms; not an upstream reclamation guarantee |
| `pools[].admissionClasses.rules` | No | Up to 256 ordered mappings from trusted subject, tenant, application, or role claims to fixed class IDs |

Identity verification remains fail closed when no usable key is cached. A fresh
cached key remains usable until `identity.jwt.cacheTtlMs` expires, allowing Tyr to
continue serving through a temporary JWKS outage without weakening signature
verification.

`inFlightTokenBudget` is tri-state:

- Omit it to disable token-budget admission for the pool.
- Set it to `0` to reject every budget-gated request.
- Set a positive integer to enforce an in-flight ceiling.

`highPriorityTokenReserve` requires `inFlightTokenBudget` and cannot exceed it.
It reserves token headroom only; it does not reserve a concurrency slot or
preempt running work.

`opaqueMediaInputTokenReservation` controls the conservative surcharge applied
to each opaque image, audio, document, file, or video block. Omit it for 2,048
tokens per block. Set it to `0` only when another estimator or upstream policy
accounts for that cost.

`adaptiveEstimation` requires no external state. Set `enabled: false` when a
custom exact tokenizer is already supplying reservations or when deterministic
estimates across process restarts are more important than local calibration.

`shutdown.drainTimeoutMs` uses the bounded drain result. When the deadline
expires, Tyr records the outstanding count, closes remaining HTTP connections,
and returns the snapshot from `shutdown()`. If it is omitted, shutdown waits
for final token settlement as well as local concurrency. A callback that remains
unsettled after its borrowed slot was returned can therefore keep an unbounded
shutdown pending; configure the timeout when process termination must be
bounded. Expiry bounds Tyr's wait, not upstream provider execution.

## Latchflo managed mode

File configuration can make Latchflo operation part of Tyr's normal process
lifecycle. No package installation or `src/index.ts` modification is required.

```yaml
routing:
  capacityAware:
    instanceId: tyr-a
    sharedSecretEnv: TYR_ROUTING_SECRET
    # Empty is valid in Latchflo 0.13+ managed mode; desired-state topology
    # supplies the routable fleet after startup.
    peers: []

controlPlane:
  type: latchflo
  url: http://latchflo-control-plane:8080
  instanceId: tyr-a
  pools: [interactive-claude, batch-openai]
  bootstrapTokenEnv: LATCHFLO_AGENT_BOOTSTRAP_TOKEN
  agentTokenFile: /var/lib/tyr/latchflo-agent.token
  retryIntervalMs: 1000
  retryMaxIntervalMs: 30000
  requestTimeoutMs: 5000
  metadata:
    region: us-west
    zone: us-west-2a
    version: 0.31.0
    endpoint: http://tyr-a:8787
    labels:
      environment: demo
```

The bootstrap credential is read from the named environment variable only when
no persisted agent token exists. After registration, Tyr writes the rotated
agent token atomically with owner-only permissions. Relative token paths are
resolved against the configuration file directory.

When both managed mode and capacity-aware routing are enabled, the routing and
control-plane `instanceId` values must match. Latchflo 0.13+ advertises active
agents that have routing endpoints; Tyr treats each newer topology as the complete
peer set. Older Latchflo responses omit `routingTopology`, in which case the
startup `peers` list remains unchanged. `TYR_ROUTING_SECRET` is still provisioned
directly to Tyr replicas and is not part of Latchflo desired state.

Tyr opens its HTTP listener even when Latchflo is temporarily unavailable so
`/healthz` can distinguish process health from control-plane readiness.
Transient registration, heartbeat, and desired-state failures use single-flight,
bounded exponential backoff with jitter; `429` and `503` `Retry-After` values are
honored as a minimum delay. Permanent configuration, authentication, and
protocol failures are not retried continuously. Every control-plane request is
bounded by `requestTimeoutMs`.


### Demand-aware Latchflo heartbeats

Tyr automatically derives one snapshot per managed pool from its existing
statistics. Tyr 0.31.0 carries forward bounded per-class demand in that additive
heartbeat while preserving the original pool-level fields:

```json
{
  "demand": [
    {
      "pool": "interactive-claude",
      "observedAt": "2026-08-01T20:00:00.000Z",
      "inFlight": 12,
      "pending": 0,
      "recentAdmissions": 31,
      "recentRejections": 4,
      "recentBudgetRejections": 3,
      "recentConcurrencyRejections": 1,
      "inFlightTokens": 9200,
      "availableTokens": 800,
      "lastRequestAt": "2026-08-01T19:59:59.900Z",
      "admissionClasses": [
        {
          "admissionClass": "premium",
          "inFlight": 8,
          "recentAdmissions": 24,
          "recentRejections": 3,
          "recentBudgetRejections": 2,
          "recentConcurrencyRejections": 1,
          "protectedConcurrent": 4,
          "protectedConcurrentInUse": 4,
          "borrowedConcurrent": 4,
          "maxConcurrent": 12,
          "inFlightTokens": 6100,
          "protectedInFlightTokens": 4000,
          "protectedTokensInUse": 4000,
          "borrowedInFlightTokens": 2100,
          "maxInFlightTokens": 12000,
          "lastRequestAt": "2026-08-01T19:59:59.900Z"
        }
      ]
    }
  ]
}
```

`recent*` values are deltas since the last heartbeat accepted by Latchflo, not
process-lifetime totals. Current in-flight work keeps a pool demanding even when
no new arrivals occurred during the interval. A failed heartbeat does not
advance the checkpoint, so its activity is retried rather than lost.

The same accepted-heartbeat semantics apply independently to every configured
admission class. `admissionClasses` is deterministic and bounded by Tyr's fixed
class table (at most 64 entries); tenant, application, subject, and other raw
identity values never become heartbeat keys. `protected*` and `borrowed*` fields
report current use of the active floor and shared remainder. They are telemetry,
not a request for Tyr to resize its own limits.

Tyr 0.31.0 advertises `admissionClassDemand: true`,
`grantOccupancyAck: true`, `admissionClassOccupancyAck: true`, and the additive
`borrowedAdmissionSlotDeadlines: true` capability at registration. Older control
planes that ignore unknown capability and nested evidence fields remain
compatible. Latchflo 0.10.0 continues to use the physical-pool proof introduced
in Tyr 0.24; Latchflo 0.11+ can require the class capability before committing a
class-only handoff ahead of lease expiry.

Tyr omits token fields for concurrency-only pools and currently omits
`oldestPendingMs` because the underlying queue statistics do not expose waiter
age. Latchflo can still age continuous demand from successive reports. Missing
or stale telemetry remains protected by Latchflo; it cannot cause a floor to be
lent early.

### Acknowledged capacity handoffs

When Latchflo 0.10.0 restores capacity from a borrower, it can issue a lower
complete physical-pool grant as a drain target. Tyr installs that higher
revision locally first, so no new request can extend occupancy beyond the new
ceiling. Active work is not revoked; the pool shrinks by attrition.

Only after the `applied` acknowledgement succeeds does Tyr publish a separate
demand heartbeat. If the exact published snapshot is still above the new
`maxConcurrent` limit, or above a newly introduced/lower token budget, Tyr uses
a bounded 500 ms evidence cadence until a published snapshot is at or below the
target. Normal heartbeat cadence then resumes. Failed acknowledgements or
heartbeats do not weaken local enforcement, and Latchflo can still fall back to
lease expiry rather than double-allocating capacity.

The acknowledgement's `occupancy` object is additive observability evidence;
Latchflo 0.10.0 does not need to trust it to commit a transfer. The fresh
post-ack heartbeat remains the authoritative proof used by that control plane.

Tyr 0.31.0 applies the same ordering to restrictive class-only changes. When a
protected floor is restored, the newly protected capacity reduces the shared
remainder. Tyr therefore keeps publishing bounded class evidence until the sum
of `borrowedConcurrent` fits within the desired shared concurrency remainder and,
for token-managed pools, the sum of `borrowedInFlightTokens` fits within the
desired shared token remainder. Reduced per-class hard ceilings must also contain
their current class occupancy. The heartbeat includes the active protected floors
and hard ceilings so Latchflo can reject stale snapshots.

`/readyz` remains `503` until every managed pool has a complete unexpired grant.
A transient poll failure does not discard a still-valid lease. When a grant
expires, Tyr applies the reserved next even revision with zero capacity and
immediately becomes unready. Grant acknowledgements are best-effort and cannot
interrupt local expiration enforcement after limits have been applied.

Omit `controlPlane.pools` to manage every pool declared in the Tyr file. Pool
names are validated at startup, and a grant batch is preflighted before any
local pool mutates. Queue timeout, model routing, estimator policy, admission
mode, and provider upstreams remain construction-time settings.

### Embedded control surface

`createGateway()` still returns the narrow `control` object for custom embedded
agents and tests. It does not expose the request-execution bulkhead itself.

```ts
const { control } = createGateway(options);
const result = control.applyLimits([
  {
    pool: "interactive-claude",
    limits: {
      revision: 101,
      maxConcurrent: 24,
      maxQueue: 0,
      tokenBudget: { budget: 240_000, highPriorityReserve: 48_000 },
    },
    provenance: {
      source: "latchflo",
      grantId: "f6bc97d0-14ba-4ca7-b9bb-9a275a8b1533",
      controllerEpoch: 12,
      revision: 101,
      expiresAt: "2026-07-24T18:30:00.000Z",
    },
  },
]);

if (!result.applied) console.error(result.reason, result.pool);
```

Every update must provide the complete snapshot expected by that pool.
Revisions must be strictly greater than the current revision, and provenance
revision must match the limit revision. Tyr retains a bounded revision ledger
so in-flight requests remain attributable to the grant captured at admission.
Reductions use shrink-by-attrition; setting `maxConcurrent: 0` disables new
admissions immediately.

## Authenticated identity and priority safety

Identity is optional for backward compatibility. Once `identity` is configured,
every provider request must present a valid JWT before Tyr reads the request
body. The default identity header is deliberately separate from
`Authorization`, because Tyr forwards that provider credential to OpenAI and
Anthropic. Tyr strips the configured identity credential header before
forwarding and rejects configuration that reuses a provider-forwarded header.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_OPENAI_API_KEY' \
  -H 'x-tyr-identity-token: Bearer YOUR_IDENTITY_JWT' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

Role lists use any-of semantics. `identity.roles.invoke` authorizes provider
routes, `identity.roles.operator` authorizes `/stats` and `/metrics`, and
`identity.roles.highPriority` grants access to the reserved high-priority token
headroom. Tenant, application, subject, and roles appear only in structured
audit events, never in Prometheus labels.

When identity is enabled, client-supplied `x-priority` is ignored even if the
legacy trusted-header option is true. Embedded applications can still supply
`GatewayOptions.resolvePriority(req, identity)` for custom policy; the verified
identity is passed as the second argument. Programmatic authenticators using a
custom credential header should also set `identity.credentialHeader` so Tyr
strips it before provider forwarding.

The legacy raw-header path remains available only when identity is not
configured:

```yaml
priority:
  trustHeader: true
```

Enable that fallback only behind a trusted proxy that removes client copies,
authenticates callers, and injects its own header.

## Validate configuration in CI

```bash
npm ci
npm run validate:config -- --config ./deploy/tyr.yaml
```

The built CLI is also available directly:

```bash
npm run build
node dist/cli.js validate --config ./deploy/tyr.yaml
```

The package declares a `tyr` binary, so an installed package can run:

```bash
tyr validate --config ./deploy/tyr.yaml
```

## Container usage

Build the included image:

```bash
docker build -t tyr-admission-controller:0.31.0 .

The source tree must include the committed `vendor/` directory. Run `npm run verify:vendor` before building or publishing a source archive.
It is an offline check: it proves each tarball matches the lockfile. Because a tarball and its lockfile entry can be regenerated together from a local `npm pack`, CI also runs `npm run verify:vendor-provenance`, which compares each vendored tarball against the artifact npm published for that exact `name@version`. That online check is what stops a local pre-release build from shipping under a released version number; run it whenever you re-vendor a dependency.
```

Run it with a read-only mounted configuration:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  tyr-admission-controller:0.31.0
```

Or use the included Compose example:

```bash
docker compose -f compose.example.yaml up --build
```

Pin production deployments to a released version or image digest rather than a
mutable `latest` tag.

An OpenAI SDK can point its base URL at `http://tyr:8787/v1` and use either
`responses.create(...)` or Chat Completions within the supported request boundary.
An Anthropic client can send Messages requests to `http://tyr:8787/v1/messages`.
In all cases, the application continues to own and send its provider credentials.

## Legacy environment mode

The original environment entrypoint remains available for simple single-pool
deployments:

```bash
UPSTREAM_URL=https://api.anthropic.com \
OPENAI_UPSTREAM_URL=https://api.openai.com \
TOKEN_BUDGET=500000 \
ADMISSION_MODE=enforce \
ADAPTIVE_ESTIMATION=true \
OPAQUE_MEDIA_INPUT_TOKENS=2048 \
MAX_CONCURRENT=50 \
npm start
```

See [`.env.example`](.env.example) for every legacy variable. New multi-pool
deployments should use file configuration.

## Prometheus and Grafana demo

The repository includes a completely local demonstration that does not call a
paid model provider:

```bash
npm run demo:up
```

Open Grafana at `http://localhost:3000`. The **Moflux / Tyr Overload
Protection** dashboard and Prometheus datasource are provisioned automatically.
Prometheus is also available at `http://localhost:9090`, and Tyr at
`http://localhost:8787`.

In a second terminal, establish the normal baseline:

```bash
npm run demo:normal
```

Then generate a fail-fast overload burst:

```bash
npm run demo:overload
```

The dashboard shows the four-slot concurrency ceiling, admitted traffic,
capacity rejections by reason, token holds and refunds, upstream status, p95
latency, and readiness. The mock provider deliberately holds calls for 1.2 seconds,
so the overloaded run makes Tyr's pre-provider shedding visible without API
keys or usage charges. Stop and remove the stack with `npm run demo:down`.

The demo intentionally leaves the operator token unset. When enabling
`TYR_OPERATOR_BEARER_TOKEN`, add the same bearer credential to Prometheus's
scrape configuration.

## Runtime behavior

Request bodies are buffered up to `maxRequestBodyBytes`, 1 MiB by default.
Streaming responses honor downstream backpressure, abort upstream work when the
client disconnects, and support separate response-header, upstream-idle, and
client-stall timeouts. Non-streaming responses are buffered and returned with an
explicit `content-length`.

`SIGTERM` and `SIGINT` stop new admissions, close the HTTP server, and drain
in-flight bulkhead work. Requests reaching an existing keep-alive connection
during shutdown receive `503` with `x-admission-reason: shutdown`. When
`shutdown.drainTimeoutMs` is configured, Tyr closes remaining connections after
the bounded v3.12 drain snapshot reports outstanding work.

Without `shutdown.drainTimeoutMs`, drain also waits for final token settlement
after a borrowed local slot has been returned. A callback that never settles
therefore keeps shutdown pending even though interactive local concurrency is
already restored. The bounded form reports that admission as outstanding and
allows Tyr to finish closing connections; it does not establish that upstream
work stopped.

`/stats` exposes the live bulkhead statistics plus a `tyr` object for each pool.
That object contains admission mode, advisory admit/reject counts, observe-mode
bypass counts, adaptive correction snapshots, progressive-reconciliation
statistics, current Latchflo provenance, and bounded exact admission provenance.
When configured, the underlying snapshot also contains bounded per-class limits
and live usage. `tyr.restoration` states the release mechanism and enforceability
separately for local admission slots and upstream capacity, lists configured
class deadlines, counts slot releases and cancellation requests, and reports
local work whose slot has been returned while its accounting has not settled.
`admissionSlots.releasedByCause` splits those releases into `deadline` (an
expired lease) and `manual` (an explicit `abandonBorrowedConcurrency()` call).
Tyr never abandons manually, so a non-zero `manual` count only appears when an
embedder returns a slot itself. Only `deadline` expiry aborts the callback
signal, so `upstreamCapacity.cancellationRequested` counts that cause alone; a
rising `deadline` share means the configured lease is too tight.

`tyr.admissionProvenance` is a fixed-size 512-event ring for successful,
capacity-holding admissions only; observe-mode bypasses are intentionally absent.
Each event uses schema `tyr.admission-provenance.v1` and includes a pool-local
monotonic `sequence`, `admittedAt`, Tyr-generated `admissionId`, `pool`,
`priority`, optional `admissionClass`, `limitRevision`, `reservedTokens`, the
exact `resources` borrowing attribution, the applied `limits` snapshot, and the
matching managed `grant` when one
exists. The wrapper also reports `retained`, `dropped`, `captureFailures`, and
`nextSequence`. Benchmark consumers should require `captureFailures == 0` and
track `sequence` gaps before treating the retained events as complete evidence.
Matching the event's `grant.grantId`/`limitRevision` to a committed Latchflo
successor grant proves which allocation authorized an admission without relying
on cross-process clock ordering. Request bodies, identity, and client-supplied
request IDs are not retained in this ring.

`/metrics` exposes Prometheus text format with only bounded dimensions: configured
pool name, configured admission-class ID, provider shape, priority, status
class, outcome, and enumerated reason. Model strings, request IDs, admission
IDs, grant IDs, and tenant-supplied identity values never become metric labels.

Tyr 0.31.0 carries forward two admission-path histograms.
`tyr_admission_decision_seconds` measures synchronous local decision work and
**excludes** the awaited local concurrency acquire.
`tyr_admission_queue_wait_seconds` measures that acquire wait separately. Both
are emitted only for enforce-mode admission decisions and are split by
`pool`, `outcome` (`admitted` or `rejected`), and bounded `admission_class`.
Use each histogram's `_sum` / `_count` for the per-outcome mean; do not pool
admitted and rejected decisions because their mixes can differ across arms. The
decision histogram uses 5 µs–50 ms diagnostic buckets, while queue wait reuses
the normal duration buckets. A precheck rejection contributes exactly zero to
queue-wait sum.

Borrowed-slot restoration is exposed through
`tyr_resource_release_events_total`,
`tyr_pool_borrowed_admission_slot_deadlines_total`,
`tyr_pool_admission_class_borrowed_slot_deadlines_total`, and
`tyr_pool_work_in_flight`. The resource metric intentionally emits an enforced
local-slot release series and a separate unverified upstream cancellation-request
series; neither the label nor the count claims that provider capacity was
reclaimed. The local-slot series counts every early return, while the upstream
series and `tyr_pool_borrowed_admission_slot_deadlines_total` count deadline
expiries only. The per-class counter has no upstream cause split, so it counts
every early return for the class.

For coordination comparisons, Tyr's decision duration is the local decision
cost to compare with an external coordinator that grants/refuses immediately;
queue wait is local capacity contention and is intentionally not part of that
decision-cost comparison.

Set `TYR_OPERATOR_BEARER_TOKEN` to require `Authorization: Bearer <token>` for
both `/stats` and `/metrics`. Leave it unset for the local demo or protect the
endpoints at the network layer.

Set `telemetry.audit.enabled: true` or `TYR_AUDIT_ENABLED=true` to emit one JSON
line per admission decision. Audit output is intentionally richer than metrics
and can include authenticated subject, tenant, application, roles, model,
admission ID, reservation, exact grant provenance, final usage, and settlement. Audit-sink failures are isolated from proxy behavior and
counted by `tyr_audit_write_failures_total`.

Upstream failures are always reported, whether or not audit output is enabled.
`tyr_upstream_failures_total{pool,provider,code}` counts them by bounded
transport code. Each one also writes a `{"schema":"tyr.diagnostic.v1","event":"upstream_failure",...}`
line to stderr with the code, syscall, whether headers had already been sent,
and a bounded detail message. The detail can include internal addresses, so it
is logged but never returned to the caller.

## Known limitations

- Standalone budgets and statistics are per process. Configure Latchflo managed
  mode when replicas must share a bounded fleet-wide capacity envelope.
- Latchflo coordination uses expiring partitioned grants rather than a strict
  distributed lease on every request. Capacity can be temporarily unavailable
  during safe lease handoff.
- Borrowed-slot deadlines enforce reclamation of Tyr-local concurrency only.
  Provider cancellation may be best-effort, so upstream account, queue, or
  accelerator protection still requires an unlent floor or another release
  mechanism that can be proven to reclaim that resource.
- Capacity snapshots are advisory and can race with authoritative admission;
  stale or unavailable peers are ignored, and a routed rejection is returned
  without a second automatic attempt. Managed peer membership is dynamic only
  when Latchflo 0.13+ publishes `routingTopology`; standalone peer membership
  remains startup configuration.
- Upstream, estimator, timeout, routing-secret, and admission-mode configuration
  is loaded only at startup. Admission-limit snapshots and managed routing
  topology can be replaced at runtime.
- Adaptive calibration is local, learned only from live observations, and is not
  persisted across restarts.
- JWT identity currently supports direct JWKS URLs and RSA signatures; OIDC discovery, EC signatures, and durable identity-policy distribution remain external work.
- Prometheus export is built in, but OTLP/OpenTelemetry export and durable audit storage remain external integration work.
- SSE usage extraction must be verified against the exact provider API versions
  used in production. Missing usage affects reservation refunds, not proxying.
- Upstream response headers are not generally passed through; Tyr returns the
  upstream status and body with a normalized content type.
- There is no Anthropic/OpenAI format translation.
- Responses support is intentionally stateless in v0.31.0: hidden server-side
  conversation/prompt references, background execution, and provider-managed
  retrieval/computer tools are rejected until Tyr can reserve their capacity
  without undercounting unseen state.
- There is no active-stream termination policy for post-admission usage
  overruns.
- Multi-controller Latchflo failover, tenant policy, and supported Helm packaging
  remain roadmap work.

## Repository layout

```text
config/
  tyr.example.yaml  documented configuration template
  tyr.schema.json   JSON Schema for editor and CI integration
src/
  admission.ts      request projection and estimator policy
  adapters.ts       provider validation, projection, and usage parsing
  cli.ts            offline configuration validation command
  config.ts         YAML and legacy environment configuration loading
  identity.ts       JWT/JWKS authentication, immutable identity, and role policy
  index.ts          validated process entrypoint and managed-mode lifecycle
  latchflo.ts        built-in Latchflo agent, retry, readiness, demand heartbeat, and token persistence
  demand.ts          accepted-heartbeat demand deltas derived from live pool statistics
  pools.ts          v3.16 policy runtime, progressive reconciliation, versioned limits, observe mode, and drain
  routing.ts        protected peer snapshots and request-specific replica selection
  server.ts         HTTP proxy, routing, admission, telemetry, timeouts, and shutdown
  telemetry.ts      Prometheus metrics and structured admission audit events
  sse.ts            Anthropic streaming usage extraction
  sse-openai.ts     OpenAI Chat Completions streaming usage extraction
  sse-responses.ts  OpenAI Responses semantic streaming usage extraction
  validation.ts     provider-agnostic request shape validation
test/
  admission.test.ts request projection and estimator regression tests
  config.test.ts    file-schema and environment compatibility tests
  gateway.test.ts   gateway end-to-end tests
  routing.test.ts   request-specific replica-scoring regression tests
  demand.test.ts    managed demand snapshot and checkpoint regression tests
  routing-gateway.test.ts authenticated one-hop routing integration tests
  latchflo.test.ts  managed-agent, readiness, persistence, and expiration tests
  pools-v311.test.ts v3.11 preview, exact admission provenance, observe, reconfiguration, and drain tests
Dockerfile          production multi-stage image
compose.example.yaml local file-configured container example
demo/                mock provider, Prometheus, Grafana, dashboard, and load generator
```

## Development commands

```bash
npm run lint
npm run lint:fix
npm run typecheck
npm test
npm run build
npm run smoke
npm run verify:routing
npm run verify:routing-topology
npm run verify:openai-responses
npm run verify:borrowed-restoration
npm run verify:demand
npm run verify:admission-provenance
npm run release:check

# Zero-cost metrics demonstration
npm run demo:up
npm run demo:normal
npm run demo:overload
npm run demo:down
```

## License

Tyr is proprietary software licensed under [`LICENSE.txt`](LICENSE.txt) and an
applicable Order Form or other written authorization. Third-party notices are
provided in [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).
