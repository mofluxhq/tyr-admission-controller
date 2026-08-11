# Tyr 0.25.0 verification

Date: 2026-08-11

## Version alignment

- Tyr package version: `0.25.0`
- Runtime dependency: `async-bulkhead-llm@3.15.1`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Bundled runtime artifacts remain unchanged:
  - `vendor/async-bulkhead-llm-3.15.1.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- `src/version.ts`, package metadata, managed-mode examples, demo image tag, and
  telemetry build-info assertions report `0.25.0`.

## Passed checks in this review environment

- ESLint with zero warnings.
- Strict TypeScript type-check, including the new class-handoff unit coverage.
- Production TypeScript build.
- Validation of `config/tyr.example.yaml`.
- Validation of `config/tyr.latchflo.example.yaml`.
- Capacity-aware routing executable verification, synchronized on completed
  peer snapshot refreshes rather than a fixed startup sleep.
- Protected admission-class executable verification.
- Latchflo demand-reporting executable verification, including additive hard
  `maxConcurrent` / `maxInFlightTokens` class evidence and the
  `admissionClassOccupancyAck` registration capability.
- Existing acknowledged physical capacity-handoff executable verification.
- New acknowledged admission-class handoff executable verification, including:
  - class-only protected-floor restoration with no physical-pool shrink;
  - lower shared concurrency and token remainder after the restored floor is
    installed;
  - successful `applied` acknowledgement before the fresh class heartbeat;
  - bounded class occupancy in the acknowledgement;
  - an intentionally unsafe first post-ack class snapshot;
  - attrition from 4 borrowed concurrent / 8,000 borrowed tokens to the safe
    target of 2 borrowed concurrent / 4,000 borrowed tokens;
  - continued bounded 500 ms evidence publication until the exact sent snapshot
    is safe, then automatic return to the ordinary cadence;
  - a second class-only transition lowering premium hard concurrency/token
    ceilings from 8 / 16,000 to 5 / 10,000 while occupancy is 6 / 12,000, with
    evidence continuing until attrition reaches the new hard limits.
- Progressive-reconciliation executable verification.
- ESM smoke imports.
- Prometheus telemetry smoke verification, including
  `tyr_build_info{version="0.25.0"}`.
- `npm pack --dry-run` for `tyr-admission-controller@0.25.0`: 46 packaged files,
  132.1 kB packed / 543.4 kB unpacked in this environment.
- `git diff --check`.

## Full Vitest suite limitation

`npm test` does **not** pass in this review environment because Vitest cannot
start. The uploaded repository contains the macOS Rolldown optional native
binding, while this Linux host requires
`@rolldown/binding-linux-x64-gnu@1.1.5`. Vitest exits during startup before
loading any test file.

An attempt to install the missing optional binding could not complete because
this container has no working npm/DNS access. This is an environment limitation,
not a passing test result. The TypeScript test sources do type-check and the new
class-handoff behavior has executable verification coverage, but the complete
Vitest suite must still be run on a target platform with a clean dependency
install before tagging or publishing.

Run `npm ci` and then `npm run release:check` on the target platform before
publishing `v0.25.0`.

## Compatibility boundary

Tyr 0.25.0 changes no runtime dependencies and never revokes active work. It
adds bounded admission-class occupancy to successful grant acknowledgements,
adds active hard ceilings to class-demand snapshots, advertises the additive
`admissionClassOccupancyAck` capability, and treats restrictive class-only grant
transitions as drain targets.

Latchflo 0.10.0 remains wire-compatible: it can ignore the additive capability,
class acknowledgement evidence, and hard-limit heartbeat fields while retaining
Tyr 0.24's physical handoff behavior. Latchflo 0.11+ can combine a successful
`applied` acknowledgement with a fresh post-ack class heartbeat to prove that
restored protected capacity is no longer consumed as shared capacity before the
old lease expires. If acknowledgement or evidence publication fails, local
limits remain enforced and lease expiry remains the conservative control-plane
fallback.
