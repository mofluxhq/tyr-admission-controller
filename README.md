# Tyr Admission Controller

Tyr is an admission-first proxy for Anthropic Messages and OpenAI Chat
Completions. Before an upstream request begins, Tyr projects the request into a
token reservation, evaluates current concurrency and token pressure, and either
enforces or observes the resulting admission decision.

Tyr 0.14.0 is built on
[`async-bulkhead-llm@3.12.0`](https://www.npmjs.com/package/async-bulkhead-llm).
The pool runtime uses complete versioned limit snapshots, immutable reservation
previews, native observe mode, per-model adaptive estimation, stable admission
identities, streaming usage reconciliation, priority reserves, and bounded
drain results.

> **Status:** v0.14.0, single-process data plane, proprietary software. See
> [`LICENSE.txt`](LICENSE.txt). Tyr now includes first-class Latchflo managed
> mode with configuration-driven registration, expiring grants, readiness,
> persisted agent credentials, and fail-closed expiration behavior.

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

## Request lifecycle

For each provider request, Tyr:

1. Buffers and validates the JSON body within the configured size limit.
2. Routes the model to the longest matching pool prefix.
3. Projects provider prompt content into an admission request.
4. Computes one immutable reservation preview.
5. Captures the pool's complete versioned limit snapshot and calls
   `wouldAdmit(..., { detail: true })` with the exact reservation.
6. Calls the native v3.12 `run()` path with the same reservation and the pool's
   configured `enforce` or `observe` mode.
7. Reconciles live and final provider usage. Native observe bypass releases also
   feed adaptive estimation when provider usage is available.
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
| `POST` | `/v1/messages` | Admission-gated Anthropic Messages proxy |
| `POST` | `/v1/chat/completions` | Admission-gated OpenAI Chat Completions proxy |
| `GET` | `/stats` | Live per-pool bulkhead statistics; optional operator bearer token |
| `GET` | `/metrics` | Prometheus text exposition; optional operator bearer token |
| `GET` | `/healthz` | Process liveness |
| `GET` | `/readyz` | Managed readiness; `503` until all configured Latchflo grants are valid |

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
| `x-admission-preview` | Advisory `admit` or `reject` result at request arrival |
| `x-admission-preview-revision` | Limit revision used for the advisory preview |
| `x-admission-preview-reason` | Present when the advisory result rejects |
| `x-admission-reserved-tokens` | Exact input-plus-output reservation when a token budget exists |
| `x-admission-id` | Bulkhead UUID, or `shadow-...` for an observe-mode bypass |
| `x-admission-outcome` | `admitted` or native v3.12 `bypassed` outcome |
| `x-admission-revision` | Revision active when execution began; immediate rejections use the preview revision |
| `x-admission-bypass-reason` | Capacity reason simulated by an observe-mode bypass |
| `x-latchflo-grant-id` | Exact Latchflo capacity grant associated with `x-admission-revision`, when present |
| `x-latchflo-controller-epoch` | Latchflo fencing epoch that issued the associated grant |
| `x-korrx-grant-id` | Deprecated alias of `x-latchflo-grant-id`, identical value |
| `x-korrx-controller-epoch` | Deprecated alias of `x-latchflo-controller-epoch`, identical value |

Actual admission rejections also include `x-admission-reason`. Tyr does not
fabricate a `Retry-After` header because a fail-fast capacity snapshot cannot
provide an honest availability time. Advisory results are not guarantees;
capacity can change before authoritative admission.

### Error contract

| Status | Typical error type or reason |
|---:|---|
| `400` | `invalid_json` or `invalid_request` |
| `404` | `not_found` or `route_not_configured` |
| `413` | `payload_too_large` |
| `422` | `unsupported_model` |
| `429` | `admission_rejected`, commonly `budget_limit` or `concurrency_limit` |
| `502` | `upstream_error` |
| `503` | `admission_rejected` with reason `shutdown` |
| `504` | `response_timeout`, `idle_timeout`, or admission timeout |

Admission rejection bodies include the pool name and the bounded capacity detail
reported by `async-bulkhead-llm`.

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

For OpenAI streaming requests, set
`stream_options: { "include_usage": true }` when supported so Tyr can reconcile
usage from the final stream chunk. Anthropic streaming usage is extracted from
supported `message_start` and `message_delta` events.

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
| `upstreams.openai.baseUrl` | One upstream required | Enables `POST /v1/chat/completions` |
| `timeouts.responseHeadersMs` | No | Maximum wait for upstream response headers |
| `timeouts.streamIdleMs` | No | Maximum gap between upstream stream chunks |
| `timeouts.clientStallMs` | No | Maximum wait for a backpressured client to drain |
| `shutdown.drainTimeoutMs` | No | Bounded graceful-drain deadline; omit for unbounded drain |
| `priority.trustHeader` | No | Trust raw `x-priority`; default `false` |
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

`shutdown.drainTimeoutMs` uses the v3.12 bounded drain result. When the deadline
expires, Tyr records the outstanding count, closes remaining HTTP connections,
and returns the snapshot from `shutdown()`.

## Latchflo managed mode

File configuration can make Latchflo operation part of Tyr's normal process
lifecycle. No package installation or `src/index.ts` modification is required.

```yaml
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
    version: 0.14.0
    endpoint: http://tyr-a:8787
    labels:
      environment: demo
```

The bootstrap credential is read from the named environment variable only when
no persisted agent token exists. After registration, Tyr writes the rotated
agent token atomically with owner-only permissions. Relative token paths are
resolved against the configuration file directory.

Tyr opens its HTTP listener even when Latchflo is temporarily unavailable so
`/healthz` can distinguish process health from control-plane readiness.
Transient registration, heartbeat, and desired-state failures use single-flight,
bounded exponential backoff with jitter; `429` and `503` `Retry-After` values are
honored as a minimum delay. Permanent configuration, authentication, and
protocol failures are not retried continuously. Every control-plane request is
bounded by `requestTimeoutMs`.

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

## Priority safety

Client-supplied `x-priority` is ignored by default. This prevents an
unauthenticated caller from assigning itself the high-priority token reserve.

Raw-header trust can be enabled in file mode:

```yaml
priority:
  trustHeader: true
```

Enable this only behind a trusted proxy that removes client-provided copies,
authenticates the caller, and injects its own header.

Applications that instantiate `createGateway()` directly should prefer
`GatewayOptions.resolvePriority` and derive priority from authenticated
identity or trusted policy:

```ts
createGateway({
  resolvePriority: async (req) => {
    const identity = await authenticate(req);
    return identity.plan === "interactive" ? "high" : "normal";
  },
  // upstreams and pools
});
```

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
docker build -t tyr-admission-controller:0.14.0 .
```

Run it with a read-only mounted configuration:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  tyr-admission-controller:0.14.0
```

Or use the included Compose example:

```bash
docker compose -f compose.example.yaml up --build
```

Pin production deployments to a released version or image digest rather than a
mutable `latest` tag.

An OpenAI SDK can point its base URL at `http://tyr:8787/v1`. An Anthropic client
can send Messages requests to `http://tyr:8787/v1/messages`. In both cases, the
application continues to own and send its provider credentials.

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

`/stats` exposes the live bulkhead statistics plus a `tyr` object for each pool.
That object contains admission mode, advisory admit/reject counts, observe-mode
bypass counts, adaptive correction snapshots, and current Latchflo provenance.

`/metrics` exposes Prometheus text format with only bounded dimensions: configured
pool name, provider shape, priority, status class, outcome, and enumerated reason.
Model strings, request IDs, admission IDs, grant IDs, and tenant-supplied values
never become metric labels. Set `TYR_OPERATOR_BEARER_TOKEN` to require
`Authorization: Bearer <token>` for both `/stats` and `/metrics`. Leave it unset
for the local demo or protect the endpoints at the network layer.

Set `telemetry.audit.enabled: true` or `TYR_AUDIT_ENABLED=true` to emit one JSON
line per admission decision. Audit output is intentionally richer than metrics
and can include model, admission ID, reservation, exact grant provenance, final
usage, and settlement. Audit-sink failures are isolated from proxy behavior and
counted by `tyr_audit_write_failures_total`.

## Known limitations

- Standalone budgets and statistics are per process. Configure Latchflo managed
  mode when replicas must share a bounded fleet-wide capacity envelope.
- Latchflo coordination uses expiring partitioned grants rather than a strict
  distributed lease on every request. Capacity can be temporarily unavailable
  during safe lease handoff.
- Routing, upstream, estimator, timeout, and admission-mode configuration is
  loaded only at startup. Only the v3.12 admission-limit snapshot is remotely
  replaceable at runtime.
- Adaptive calibration is local, learned only from live observations, and is not
  persisted across restarts.
- Provider routes still require authentication and authorization at an upstream gateway or trusted application boundary. The built-in operator token covers only `/stats` and `/metrics`.
- Prometheus export is built in, but OTLP/OpenTelemetry export and durable audit storage remain external integration work.
- SSE usage extraction must be verified against the exact provider API versions
  used in production. Missing usage affects reservation refunds, not proxying.
- Upstream response headers are not generally passed through; Tyr returns the
  upstream status and body with a normalized content type.
- There is no Anthropic/OpenAI format translation.
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
  index.ts          validated process entrypoint and managed-mode lifecycle
  latchflo.ts        built-in Latchflo agent, retry, readiness, and token persistence
  pools.ts          v3.12 policy runtime, versioned limits, observe mode, and drain
  server.ts         HTTP proxy, admission, telemetry, timeouts, and shutdown
  telemetry.ts      Prometheus metrics and structured admission audit events
  sse.ts            Anthropic streaming usage extraction
  sse-openai.ts     OpenAI streaming usage extraction
  validation.ts     provider-agnostic request shape validation
test/
  admission.test.ts request projection and estimator regression tests
  config.test.ts    file-schema and environment compatibility tests
  gateway.test.ts   gateway end-to-end tests
  latchflo.test.ts  managed-agent, readiness, persistence, and expiration tests
  pools-v311.test.ts v3.11 preview, provenance, observe, reconfiguration, and drain tests
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