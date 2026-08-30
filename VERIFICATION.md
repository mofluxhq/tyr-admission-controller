# Tyr 0.29.0 verification

Date: 2026-08-30

## Version alignment

- Tyr package version: `0.29.0`
- Runtime version constant: `0.29.0`
- Runtime dependency: `async-bulkhead-llm@3.16.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts are unchanged:
  - `vendor/async-bulkhead-llm-3.16.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Managed-mode examples, demo image tag, README examples, and telemetry build-info
  assertions report `0.29.0`.

## OpenAI Responses verification

Tyr 0.29.0 adds admission-gated `POST /v1/responses` beside the existing
`POST /v1/chat/completions` route when the OpenAI upstream is configured. The
request remains in native Responses API shape; Tyr creates a separate local
admission projection and forwards the original request body upstream.

`npm run verify:openai-responses` builds Tyr and exercises the real adapter and
gateway path. It verifies that:

- string and message-array `input`, `instructions`, `max_output_tokens`,
  multimodal input blocks, and request-visible function/custom tools contribute
  to the local admission projection;
- the request forwarded to the provider retains the original Responses wire
  shape rather than the admission-only normalization;
- `authorization`, `openai-organization`, and `openai-project` remain forwarded
  by Tyr;
- non-streaming `usage.input_tokens` / `usage.output_tokens` reconcile the local
  reservation;
- semantic Responses SSE lifecycle events reconcile final usage after
  `response.completed`;
- unsupported hidden/server-managed prompt state is rejected before upstream
  invocation.

### Initial token-safety boundary

The 0.29.0 Responses path supports stateless synchronous and streaming requests.
Tyr rejects the following request modes because they can introduce prompt or
execution state that is not fully visible when Tyr must reserve tokens before
calling the provider:

- `previous_response_id`;
- server-side `conversation` state;
- stored `prompt` templates;
- `item_reference` inputs;
- `background: true`;
- provider-managed retrieval/computer tools.

Request-visible `function` and `custom` tools are supported. This boundary is
intentional: Tyr does not silently label a hidden-state request token-safe when
it cannot reserve for all of the provider-visible work.

## Carried-forward dynamic fleet-membership verification

The 0.28.0 Latchflo 0.13+ `routingTopology` behavior remains part of the 0.29.0
release candidate. `npm run verify:routing-topology` still verifies versioned
complete topology parsing, dynamic discovery, local-member filtering, removal,
stale-revision rejection, replacement discovery, and the fact that Latchflo
remains outside the synchronous provider request path.

The normal static `routing.capacityAware.peers` list remains the startup/fallback
set. If desired state omits `routingTopology` (for example, with an older
Latchflo), Tyr leaves that configured set unchanged.

## Configuration safety

When `controlPlane.type: latchflo` and `routing.capacityAware` are both enabled,
Tyr requires `routing.capacityAware.instanceId` to match
`controlPlane.instanceId`. This prevents a managed topology from advertising the
same process under one identity while its router treats itself as another.

Latchflo topology endpoints accept only absolute HTTP(S) origins without
credentials, path, query, or fragment. The Tyr-to-Tyr shared secret remains
local configuration and is not accepted from desired state.

## Verification commands

The release gate is expected to include:

- `npm run verify:vendor`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run smoke`
- `npm run smoke:telemetry`
- `npm run verify:admission-provenance`
- `npm run verify:admission-timing`
- `npm run verify:routing`
- `npm run verify:routing-topology`
- `npm run verify:openai-responses`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- validation of `config/tyr.example.yaml`
- validation of `config/tyr.latchflo.example.yaml`
- `git diff --check`
- `npm pack --dry-run`

Completed successfully in this review environment before final packaging:

- `npm run verify:vendor`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run smoke`
- `npm run smoke:telemetry`
- `npm run verify:admission-provenance`
- `npm run verify:admission-timing`
- `npm run verify:routing`
- `npm run verify:routing-topology`
- `npm run verify:openai-responses`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- validation of `config/tyr.example.yaml`
- validation of `config/tyr.latchflo.example.yaml` with `TYR_ROUTING_SECRET` set
- `git diff --check`
- `npm pack --dry-run`: 48 packaged files, approximately 143.7 kB packed /
  591.2 kB unpacked

`npm test` was also invoked but did not start Vitest because of the environment
limitation documented in the next section. No Vitest test file executed, so the
suite is **not** counted as passing.

## Full Vitest suite limitation in this review environment

The uploaded repository contains a macOS-generated `node_modules`. In this Linux
review environment, Vitest 4 cannot start because Rolldown's optional Linux
native binding `@rolldown/binding-linux-x64-gnu` is absent. Registry access is
not available here to replace the uploaded dependency tree with a clean Linux
install.

This is an environment startup failure, not a passing test result. Before a
0.29.0 tag or publication, run the complete release gate from a clean dependency
install on a supported environment:

```bash
rm -rf node_modules
npm ci
npm run release:check
```

`release:check` includes the new `verify:openai-responses` verifier as well as the
existing full Vitest suite and release verifiers.

## Compatibility boundary

Tyr 0.29.0 adds one OpenAI endpoint and intentionally does not translate between
Responses and Chat Completions. Existing Anthropic Messages, OpenAI Chat
Completions, identity, pool selection, capacity-aware routing, Latchflo desired
state, admission provenance/timing, and static-routing behavior remain on their
existing paths. Runtime dependency versions are unchanged from 0.28.0.
