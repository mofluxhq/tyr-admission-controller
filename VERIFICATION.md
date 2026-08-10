# Tyr 0.24.0 verification

Date: 2026-08-07

## Version alignment

- Tyr package version: `0.24.0`
- Runtime dependency: `async-bulkhead-llm@3.15.1`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Bundled runtime artifacts remain unchanged:
  - `vendor/async-bulkhead-llm-3.15.1.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- `src/version.ts`, package metadata, examples, Compose image tag, and telemetry
  build-info assertions report `0.24.0`.

## Passed checks

- ESLint with zero warnings.
- Strict TypeScript type-check.
- Production TypeScript build.
- Validation of `config/tyr.example.yaml`.
- Validation of `config/tyr.latchflo.example.yaml`.
- Capacity-aware routing executable verification.
- Protected admission-class executable verification.
- Latchflo demand-reporting executable verification.
- Acknowledged capacity-handoff executable verification, including:
  - additive `grantOccupancyAck: true` registration capability;
  - lower grant installed before an `applied` acknowledgement;
  - acknowledgement occupancy evidence for concurrency and token pressure;
  - a distinct post-ack heartbeat carrying the unsafe occupancy snapshot;
  - race coverage where local work drains while that heartbeat response is in
    flight;
  - continued bounded evidence publication until Tyr has actually published a
    snapshot within the shrink target.
- Progressive-reconciliation executable verification.
- ESM smoke imports.
- Prometheus telemetry smoke verification, including `tyr_build_info{version="0.24.0"}`.
- `npm pack --dry-run` for `tyr-admission-controller@0.24.0` (46 packaged files; no nested release archive).
- A temporary Latchflo 0.10.0 compatibility run against the packed Tyr 0.24.0 artifact passed all four existing integration scenarios after updating only their Tyr fixture/version assertions: managed grant application/expiration, capacity-aware peer routing, progressive demand snapshots, and protected-class lending.
- `git diff --check`.

## Full test-suite limitation

`npm test` cannot start in this verification environment. The uploaded
repository contains the macOS Rolldown optional native binding, while this host
requires `@rolldown/binding-linux-x64-gnu@1.1.5`. Vitest exits during startup
before loading any test file.

An attempt to rebuild dependencies with `npm ci` also failed because the
configured environment npm mirror returned HTTP 404 for `yocto-queue@0.1.0`.
This is not recorded as a passing test run. The new handoff behavior therefore
has executable verification coverage here, but the Vitest suite must still be
run on a target platform with a complete dependency install before tagging or
publishing.

Run `npm ci` and then `npm run release:check` on the target platform before
tagging or publishing `v0.24.0`.

## Compatibility boundary

Tyr 0.24.0 changes no runtime dependencies and never revokes active work. It
adds bounded acknowledgement occupancy fields and the additive
`grantOccupancyAck` capability, then accelerates demand publication after an
acknowledged physical-pool shrink. Latchflo 0.10.0 ignores the unknown additive
fields and continues to use the existing successful acknowledgement plus a fresh
post-ack heartbeat as the safety proof for a handoff. If acknowledgement or
evidence publication fails, local shrink enforcement remains in effect and the
control plane retains its lease-expiry fallback.
