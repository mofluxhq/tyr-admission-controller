# Tyr Admission Controller

Tyr is an admission-first proxy for Anthropic Messages and OpenAI Chat
Completions. Before an upstream request begins, Tyr projects the request into a
token reservation, evaluates current concurrency and token pressure, and either
enforces or observes the resulting admission decision.

Tyr 0.9.0 is built on
[`async-bulkhead-llm@3.8.0`](https://www.npmjs.com/package/async-bulkhead-llm).
The pool runtime uses immutable reservation previews, detailed `wouldAdmit()`
snapshots, per-model adaptive estimation, stable admission identities, streaming
usage reconciliation, priority reserves, and bounded drain results.

> **Status:** v0.9.0, single-process, proprietary software. See
> [`LICENSE.txt`](LICENSE.txt). Tyr is suitable for controlled design-partner
> pilots; distributed capacity coordination and standard telemetry exporters
> remain roadmap work.

## What shipped in v0.9.0

- A pool runtime that separates HTTP forwarding from admission policy.
- Exact v3.8 reservation objects passed verbatim to advisory and authoritative
  admission paths.
- Detailed capacity previews on every validated request.
- Per-pool `enforce` and `observe` modes for safe shadow rollouts.
- Adaptive per-model input estimation using provider-reported release usage.
- Bounded shutdown drains with per-pool outstanding-work snapshots.
- Admission-preview headers and expanded `/stats` policy telemetry.
- Focused v3.8 regression tests in addition to the existing gateway suite.

See [`CHANGELOG.md`](CHANGELOG.md) for the complete release history and
[`ROADMAP.md`](ROADMAP.md) for planned work.

## Request lifecycle

For each provider request, Tyr:

1. Buffers and validates the JSON body within the configured size limit.
2. Routes the model to the longest matching pool prefix.
3. Projects provider prompt content into an admission request.
4. Computes one immutable reservation preview.
5. Calls v3.8 `wouldAdmit(..., { detail: true })` with that exact reservation.
6. In `enforce` mode, performs authoritative admission with the same object. In
   `observe` mode, capacity rejections are recorded but proxied upstream.
7. Reconciles live and final provider usage. Adaptive pools feed completed input
   usage back into their per-model estimator.
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

Admission estimation uses the v3.8 request surfaces instead of folding the
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
| `GET` | `/stats` | Live per-pool bulkhead statistics |
| `GET` | `/healthz` | Process liveness |

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
| `x-admission-preview-reason` | Present when the advisory result rejects |
| `x-admission-reserved-tokens` | Exact input-plus-output reservation when a token budget exists |
| `x-admission-id` | Bulkhead UUID, or `shadow-...` for an observe-mode bypass |

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

Configuration is immutable for the lifetime of the process. Validate the edited
file and restart Tyr to apply a change. Hot reload is intentionally not
implemented because existing pools may still own live concurrency and token
reservations.

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

pools:
  - name: interactive-claude
    modelPrefixes: [claude-sonnet-4, claude-haiku-4]
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
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
| `pools[].name` | Yes | Unique pool name used in stats and rejection details |
| `pools[].modelPrefixes` | Yes | Unique prefixes; longest matching prefix wins |
| `pools[].estimatorModel` | Yes | Model used for estimator ratios; requests are not rewritten |
| `pools[].maxConcurrent` | Yes | Maximum active requests in the pool |
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

`shutdown.drainTimeoutMs` uses the v3.8 bounded drain result. When the deadline
expires, Tyr records the outstanding count, closes remaining HTTP connections,
and returns the snapshot from `shutdown()`.

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
docker build -t tyr-admission-controller:0.9.0 .
```

Run it with a read-only mounted configuration:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  tyr-admission-controller:0.9.0
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
the bounded v3.8 drain snapshot reports outstanding work.

`/stats` exposes the live bulkhead statistics plus a `tyr` object for each pool.
That object contains admission mode, advisory admit/reject counts, observe-mode
bypass counts, and adaptive correction snapshots. The endpoint is operational
data and is currently unauthenticated; protect it at the network or
reverse-proxy layer.

## Known limitations

- Budgets and statistics are per process. N replicas can collectively admit
  approximately N times a per-replica budget unless capacity is externally
  partitioned or coordinated.
- Configuration and adaptive calibration are local to one process. Calibration is loaded only from live observations and is not persisted across restarts.
- Configuration is loaded only at startup; there is no hot reload.
- `/stats` and provider routes have no built-in authentication or authorization.
- There is no OpenTelemetry or Prometheus exporter and no durable audit trail.
- SSE usage extraction must be verified against the exact provider API versions
  used in production. Missing usage affects reservation refunds, not proxying.
- Upstream response headers are not generally passed through; Tyr returns the
  upstream status and body with a normalized content type.
- There is no Anthropic/OpenAI format translation.
- There is no active-stream termination policy for post-admission usage
  overruns.
- Distributed leases, tenant policy, and supported Helm packaging remain roadmap
  work.

## Repository layout

```text
config/
  tyr.example.yaml  documented configuration template
  tyr.schema.json   JSON Schema for editor and CI integration
src/
  admission.ts      v3.8 request projection and estimator policy
  adapters.ts       provider validation, projection, and usage parsing
  cli.ts            offline configuration validation command
  config.ts         YAML and legacy environment configuration loading
  index.ts          validated process entrypoint
  pools.ts          v3.8 policy runtime, shadow mode, adaptation, and drain
  server.ts         HTTP proxy, admission, timeouts, and shutdown
  sse.ts            Anthropic streaming usage extraction
  sse-openai.ts     OpenAI streaming usage extraction
  validation.ts     provider-agnostic request shape validation
test/
  admission.test.ts request projection and estimator regression tests
  config.test.ts    file-schema and environment compatibility tests
  gateway.test.ts   gateway end-to-end tests
  pools-v38.test.ts exact preview, observe, adaptive, and drain tests
Dockerfile          production multi-stage image
compose.example.yaml local file-configured container example
```

## Development commands

```bash
npm run typecheck
npm test
npm run build
npm run smoke
npm run release:check
```

## License

Tyr is proprietary software licensed under [`LICENSE.txt`](LICENSE.txt) and an
applicable Order Form or other written authorization. Third-party notices are
provided in [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).