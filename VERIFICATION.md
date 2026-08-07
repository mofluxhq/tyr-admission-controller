# Tyr 0.23.0 verification

Date: 2026-08-07

## Version alignment

- Tyr package version: `0.23.0`
- Runtime dependency: `async-bulkhead-llm@3.15.1`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Bundled runtime artifacts remain unchanged:
  - `vendor/async-bulkhead-llm-3.15.1.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- `src/version.ts`, package metadata, examples, Compose image tag, and telemetry
  build-info assertions report `0.23.0`.

## Passed checks

- ESLint with zero warnings.
- Strict TypeScript type-check.
- Production TypeScript build.
- Validation of `config/tyr.example.yaml`.
- Validation of `config/tyr.latchflo.example.yaml`.
- Capacity-aware routing executable verification.
- Protected admission-class executable verification.
- Latchflo demand-reporting executable verification, including:
  - bounded per-class snapshots;
  - deterministic class ordering;
  - accepted-heartbeat admission/rejection deltas;
  - protected and borrowed concurrency/token utilization;
  - retry retention when a capture is not committed;
  - `admissionClassDemand: true` registration capability.
- Progressive-reconciliation executable verification.
- ESM smoke imports.
- Prometheus telemetry smoke verification, including build-version alignment.
- npm package dry run for `tyr-admission-controller@0.23.0`; the dry-run file
  list contains no nested `.tgz` artifact.
- Compatibility check against the uploaded Latchflo 0.8.0 parser: additive
  `admissionClassDemand` registration capability and nested class demand are
  accepted/ignored without changing the existing parsed pool-level contract.
- `git diff --check`.

## Full test-suite limitation

`npm test` could not start in this verification environment. The uploaded
repository contains the macOS Rolldown optional native binding, while this host
requires `@rolldown/binding-linux-x64-gnu@1.1.5`. Vitest exits during startup
before loading any test file.

An attempt to install the missing Linux binding also failed because the
configured environment npm mirror returned HTTP 404 for that package. This is
not recorded as a passing test run.

Run `npm ci` on the target platform and then `npm run release:check` before
tagging or publishing `v0.23.0`.

## Compatibility boundary

Tyr 0.23.0 changes no runtime dependencies and does not autonomously resize
protected class floors. It adds bounded nested class-demand fields to the
existing Latchflo heartbeat and advertises the additive
`admissionClassDemand` capability. Latchflo 0.8.x ignores those unknown fields,
so existing pool-level demand behavior remains unchanged until a newer control
plane explicitly consumes class demand.
