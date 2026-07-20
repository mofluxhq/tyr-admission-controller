# tyr-admission-controller (private)

`tyr-admission-controller` is an admission-first proxy for Anthropic Messages and
OpenAI Chat Completions. Before an upstream call starts, it reserves estimated
input tokens plus the request's maximum output allowance against a model-routed
bulkhead. Requests that do not fit are rejected immediately instead of queued
behind saturated capacity.

Built on [`async-bulkhead-llm@3.7`](https://www.npmjs.com/package/async-bulkhead-llm),
which provides admission, exact reservation previews, stable admission IDs,
usage reporting, refunds, priority reserves, rejection detail, and graceful
draining.

> **Status:** v0.7.0, single-process, private / UNLICENSED.

## Capacity semantics

A pool's `inFlightTokenBudget` is an **admission-time in-flight ceiling**. Each
admitted request reserves estimated input plus `max_tokens` or
`max_completion_tokens`, falling back to the pool's
`defaultOutputReservation`. Actual provider usage refunds unused capacity at
completion, and streaming usage can correct the hold while the response is
still running.

Usage reported after admission can exceed the original estimate. In that case,
`async-bulkhead-llm` expands the active hold, so `inFlightTokens` may temporarily
exceed the configured ceiling. Tyr blocks new admissions until capacity
releases; it does not abort the already-running request. This is deliberate
overrun accounting, not a strict post-admission kill switch.

Admission estimation uses the native v3.7 request surfaces instead of folding
the whole provider request into a synthetic user message:

- Anthropic `system` and provider messages remain first-class request fields.
- Tool schemas, tool calls, response formats, roles, and other provider-only
  prompt metadata are charged through `extraInputTokens`.
- Opaque image, audio, document, file, and video blocks use the library's
  `opaqueBlockTokens` policy. The default surcharge is 2,048 tokens per block
  and can be changed per pool.
- Inline binary payload text is removed from the admission projection, so a
  base64 string is not mistaken for literal prompt text.

Tyr computes one exact reservation preview and supplies it as the v3.7 per-call
reservation override. The estimate remains a load-shedding approximation, not
billing-grade token accounting.

## Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Admission-gated proxy to the Anthropic-shaped upstream |
| POST | `/v1/chat/completions` | Admission-gated proxy to the OpenAI-shaped upstream |
| GET | `/stats` | Per-pool live stats |
| GET | `/healthz` | Liveness |

Each provider route is enabled only when its upstream URL is configured.
Malformed requests return `400`; unsupported models return `422`; admission
rejections return `429`, `503`, or `504` with `x-admission-reason` and a
capacity snapshot. Successfully admitted provider responses include a stable
`x-admission-id` UUID for correlating client logs with gateway traces and usage
updates. Tyr never fabricates `Retry-After`.

Provider authentication headers are forwarded verbatim. Tyr stores no provider
keys, and provider credentials do not belong in the Tyr configuration file.

## Quick start with file configuration

Node.js 20 or newer is supported.

1. Install dependencies and verify the repository:
```bash
   npm ci
   npm run release:check
```

2. Copy the example configuration:
```bash
   cp config/tyr.example.yaml tyr.yaml
```

3. Edit `tyr.yaml` for the upstreams, model prefixes, and capacity limits used
   by the deployment.
4. Validate it without opening a listening socket:
```bash
   npm run validate:config -- --config ./tyr.yaml
```

   Successful validation prints the resolved file path, schema version,
   SHA-256 configuration fingerprint, port, pool names, and enabled routes.

5. Start Tyr:
```bash
   TYR_CONFIG_FILE=./tyr.yaml npm start
```

At startup, Tyr validates the complete file before calling `server.listen()`.
Unreadable files, malformed YAML, unknown properties, invalid URLs, duplicate
pool names or model prefixes, unsafe numeric values, and invalid reserve
relationships cause the process to exit nonzero.

Configuration is immutable for the lifetime of the process. To apply a change,
validate the edited file and restart Tyr. Hot reload is intentionally not
implemented because existing pools may still own live concurrency and token
reservations.

## File selection and precedence

Set one environment variable to choose file mode. Relative paths are resolved
from the process working directory:

```bash
TYR_CONFIG_FILE=/etc/tyr/config.yaml
```

Configuration values are literal; Tyr does not expand `${ENV_VAR}` placeholders
inside YAML. Keep provider credentials in the calling application or its secret
manager rather than in this file.

File mode does not merge with legacy Tyr environment variables. When
`TYR_CONFIG_FILE` is present, setting variables such as `PORT`,
`UPSTREAM_URL`, `TOKEN_BUDGET`, or `MAX_CONCURRENT` is a startup error. This
keeps the effective policy deterministic and reviewable.

When `TYR_CONFIG_FILE` is absent, Tyr preserves the original single-pool
environment configuration described in `.env.example`.

## Configuration schema

Every file must declare an explicit schema version:

```yaml
version: 1
```

The shipped example is [`config/tyr.example.yaml`](config/tyr.example.yaml).
A machine-readable editor schema is available at
[`config/tyr.schema.json`](config/tyr.schema.json). Runtime validation remains
the source of truth and additionally checks cross-field rules such as duplicate
pool routing and priority reserve limits.

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

priority:
  trustHeader: false

pools:
  - name: interactive-claude
    modelPrefixes:
      - claude-sonnet-4
      - claude-haiku-4
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
    inFlightTokenBudget: 400000
    highPriorityTokenReserve: 80000
    defaultOutputReservation: 8192
    opaqueMediaInputTokenReservation: 2048

  - name: batch-openai
    modelPrefixes:
      - gpt-4o
      - gpt-5
    estimatorModel: gpt-4o
    maxConcurrent: 20
    inFlightTokenBudget: 250000
    defaultOutputReservation: 4096
```

### Field reference

| Field | Required | Meaning |
|---|---:|---|
| `version` | Yes | Configuration schema version; currently `1` |
| `server.port` | No | Listen port, default `8787` |
| `server.maxRequestBodyBytes` | No | Maximum buffered request body; gateway default is 1 MiB |
| `server.maxOutputTokens` | No | Validation ceiling for request output-limit fields |
| `upstreams.anthropic.baseUrl` | One upstream required | Enables `POST /v1/messages` |
| `upstreams.openai.baseUrl` | One upstream required | Enables `POST /v1/chat/completions` |
| `timeouts.responseHeadersMs` | No | Maximum wait for upstream response headers |
| `timeouts.streamIdleMs` | No | Maximum gap between streaming upstream chunks |
| `timeouts.clientStallMs` | No | Maximum wait for a backpressured client to drain |
| `priority.trustHeader` | No | Trust raw `x-priority`; default `false` |
| `pools[].name` | Yes | Unique pool name used in stats and rejection detail |
| `pools[].modelPrefixes` | Yes | Unique prefixes; longest matching prefix wins |
| `pools[].estimatorModel` | Yes | Model used for estimator ratio lookup; does not rewrite requests |
| `pools[].maxConcurrent` | Yes | Maximum active requests in that pool |
| `pools[].inFlightTokenBudget` | No | Admission-time in-flight token ceiling |
| `pools[].highPriorityTokenReserve` | No | Token headroom reserved for high-priority requests |
| `pools[].defaultOutputReservation` | No | Output reservation when the request omits an output limit |
| `pools[].opaqueMediaInputTokenReservation` | No | Fixed per-block surcharge for opaque media/document content; default `2048`, `0` disables it |

`inFlightTokenBudget` is tri-state:

- Omit it to disable token-budget admission for the pool.
- Set it to `0` to reject all budget-gated requests.
- Set a positive integer to enforce an in-flight ceiling.
`highPriorityTokenReserve` requires `inFlightTokenBudget` and cannot exceed it.
It preserves token headroom only; it does not reserve a concurrent-request slot
or preempt normal work.

`opaqueMediaInputTokenReservation` controls the conservative surcharge applied
to each opaque media/document block. Omit it for 2,048 tokens per block or set
it to `0` only when another estimator or upstream policy accounts for that cost.

## Validate in CI

A deployment repository can validate its checked-in policy before publishing:

```bash
npm ci
npm run validate:config -- --config ./deploy/tyr.yaml
```

The direct built CLI is also available:

```bash
npm run build
node dist/cli.js validate --config ./deploy/tyr.yaml
```

The package declares a `tyr` binary, so an installed package can use:

```bash
tyr validate --config ./deploy/tyr.yaml
```

## Container usage

Build the included image:

```bash
docker build -t tyr-admission-controller:local .
```

Run it with a read-only mounted configuration:

```bash
docker run --rm \
  --name tyr \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  tyr-admission-controller:local
```

Or use the included Compose example:

```bash
docker compose -f compose.example.yaml up --build
```

For a private registry, customers would pull a versioned image and mount their
own policy:

```bash
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -e TYR_CONFIG_FILE=/etc/tyr/config.yaml \
  -v "$PWD/tyr.yaml:/etc/tyr/config.yaml:ro" \
  ghcr.io/your-organization/tyr:VERSION
```

Replace `VERSION` with the released tag. Pin production deployments to a version or image digest rather than a mutable
`latest` tag.

The application continues to own its provider credential and sends ordinary
provider-shaped requests through Tyr. For example, an OpenAI SDK points its
base URL at `http://tyr:8787/v1`; an Anthropic client sends Messages requests to
`http://tyr:8787/v1/messages`.

## Priority safety

Client-supplied `x-priority` is ignored by default. This prevents an
unauthenticated caller from assigning itself the high-priority token reserve.

In file mode, raw-header trust is enabled with:

```yaml
priority:
  trustHeader: true
```

Enable that only behind a trusted proxy that removes client-provided copies,
authenticates the caller, and injects its own header.

For application integrations that instantiate `createGateway()` directly,
prefer `GatewayOptions.resolvePriority` and derive priority from an authenticated
identity or trusted policy:

```ts
createGateway({
  resolvePriority: async (req) => {
    const identity = await authenticate(req);
    return identity.plan === "interactive" ? "high" : "normal";
  },
  // ...upstreams and pools
});
```

## Legacy environment mode

The original environment entrypoint remains available for simple single-pool
deployments:

```bash
UPSTREAM_URL=https://api.anthropic.com \
OPENAI_UPSTREAM_URL=https://api.openai.com \
TOKEN_BUDGET=500000 \
OPAQUE_MEDIA_INPUT_TOKENS=2048 \
MAX_CONCURRENT=50 \
npm start
```

See `.env.example` for every legacy variable. New multi-pool deployments should
use file configuration rather than defining pools in TypeScript or building a
customer-specific image.

## Proxy behavior

Request bodies are buffered up to `maxRequestBodyBytes` (1 MiB by default).
Streaming responses honor downstream backpressure, abort upstream work when
the client disconnects, and support separate response-header, upstream-idle,
and client-stall timeouts. Non-streaming responses are buffered and returned
with an explicit `content-length`.

`SIGTERM` and `SIGINT` stop new admissions, close the HTTP server, and drain
in-flight bulkhead work. Requests reaching an existing keep-alive connection
during shutdown receive `503` with `x-admission-reason: shutdown`.

## Known limitations

- Budgets and stats are per process. N replicas can admit approximately N times
  a per-replica budget unless capacity is partitioned or coordinated outside
  Tyr.
- Configuration is loaded only at startup; there is no hot reload.
- SSE usage extraction should be verified against the exact provider/API
  versions used in production. Missing usage affects refunds, not proxying.
- There is no Anthropic/OpenAI format translation.
- `/stats` and provider routes have no built-in authentication or persistence.
- There is no active-stream termination policy for usage overruns.
## Layout

```text
config/
  tyr.example.yaml documented configuration template
  tyr.schema.json  JSON Schema for editor and CI integration
src/
  admission.ts     native v3.7 request projection and reservation estimator
  adapters.ts      provider validation, admission projection, usage parsing
  cli.ts           offline configuration validation command
  config.ts        YAML and legacy environment configuration loading
  index.ts         validated process entrypoint
  pools.ts         pool validation, routing, and bulkhead construction
  server.ts        HTTP proxy, admission, timeouts, and shutdown
  sse.ts           Anthropic streaming usage extraction
  sse-openai.ts    OpenAI streaming usage extraction
  validation.ts    provider-agnostic request shape validation
test/
  admission.test.ts v3.7 request projection and estimator regression tests
  config.test.ts    file-schema and environment compatibility regression tests
  gateway.test.ts   gateway end-to-end tests
Dockerfile         production multi-stage image
compose.example.yaml local file-configured container example
```

