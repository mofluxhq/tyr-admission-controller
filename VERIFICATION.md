# Tyr 0.28.0 verification

Date: 2026-08-28

## Version alignment

- Tyr package version: `0.28.0`
- Runtime version constant: `0.28.0`
- Runtime dependency: `async-bulkhead-llm@3.16.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts remain unchanged:
  - `vendor/async-bulkhead-llm-3.16.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Managed-mode examples, demo image tag, README examples, and telemetry build-info
  assertions report `0.28.0`.

## Dynamic fleet-membership verification

Tyr 0.28.0 consumes the optional Latchflo 0.13+ `routingTopology` desired-state
field. The topology is control-plane state only: Latchflo remains outside the
synchronous provider request/admission path.

`npm run verify:routing-topology` builds Tyr and exercises the real runtime
surfaces. It proves that:

- a versioned Latchflo desired-state topology is parsed and endpoint-normalized;
- a Tyr with an empty startup peer list can discover a peer dynamically;
- the local Tyr member is filtered rather than becoming a forwarding target;
- a newer complete topology removes a peer immediately and its cached capacity
  cannot continue routing requests;
- a delayed older topology revision is ignored and cannot resurrect that peer;
- a replacement Tyr with a new `instanceId` becomes routable after a newer
  topology revision and a fresh authenticated capacity snapshot;
- topology updates do not require a Latchflo call on each provider request.

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

The following checks are expected for this release:

- `npm run verify:vendor`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- `npm run smoke:telemetry`
- `npm run verify:admission-provenance`
- `npm run verify:admission-timing`
- `npm run verify:routing`
- `npm run verify:routing-topology`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- Validation of `config/tyr.example.yaml`
- Validation of `config/tyr.latchflo.example.yaml`
- `git diff --check`
- `npm pack --dry-run`

Completed successfully in this review environment:

- `npm run verify:vendor`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- `npm run smoke:telemetry`
- `npm run verify:admission-provenance`
- `npm run verify:admission-timing`
- `npm run verify:routing`
- `npm run verify:routing-topology`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- Validation of `config/tyr.example.yaml`
- Validation of `config/tyr.latchflo.example.yaml` with the routing secret set
- `git diff --check`
- `npm pack --dry-run` and `npm pack`: 46 packaged files, approximately
  140.2 kB packed / 574.0 kB unpacked.

The generated npm package tarball has SHA-256
`92fa8f3313fc9c29d207b5b4413197e3a125a54c8df93dd773866334e3f92132`.

`npm test` was also invoked and failed during Vitest startup for the environment
reason documented below; no test file executed, so it is not counted as a pass.

## Full Vitest suite limitation in this review environment

The uploaded repository contains a macOS-generated `node_modules`. In this Linux
review environment, Vitest 4 cannot start because Rolldown's optional Linux
native binding `@rolldown/binding-linux-x64-gnu` is absent. A clean `npm ci`
cannot be completed here because the execution environment has no npm-registry
network access.

This is an environment startup failure, not a passing test result. The release
therefore keeps executable non-Vitest verification for the new topology behavior,
and the full suite must still be run from a clean dependency install before a
release tag is published:

```bash
rm -rf node_modules
npm ci
npm run release:check
```

`release:check` includes `verify:routing-topology` in addition to the full Vitest
suite and all existing release verifiers.

## Compatibility boundary

Tyr 0.28.0 changes managed capacity-routing membership, not admission policy.
Static/standalone routing remains supported. Upstream request/response semantics,
`tyr.admission-provenance.v1`, admission timing, and the exact runtime dependency
versions are unchanged from 0.27.0.
