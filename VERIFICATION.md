# Tyr 0.26.0 verification

Date: 2026-08-19

## Version alignment

- Tyr package version: `0.26.0`
- Runtime version constant: `0.26.0`
- Runtime dependency: `async-bulkhead-llm@3.15.1`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts remain unchanged:
  - `vendor/async-bulkhead-llm-3.15.1.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Managed-mode examples, demo image tag, README examples, and telemetry build-info
  assertions report `0.26.0`.

## Exact admission provenance verification

Tyr 0.26.0 adds bounded successful-admission provenance at
`/stats -> <pool>.tyr.admissionProvenance`.

The executable `npm run verify:admission-provenance` check passed in this review
environment and proves, through the real HTTP gateway path, that:

- a managed revision is applied with a known Latchflo successor grant;
- an admitted provider request receives the same Tyr admission ID, revision, and
  Latchflo grant in its response headers;
- `/stats` retains one `tyr.admission-provenance.v1` event carrying that exact
  admission ID, revision, immutable applied limits, and grant;
- the event is sequence-numbered and timestamped and reports no capture failure
  or retention loss;
- request prompt content is absent from the retained evidence;
- admission IDs and grant IDs are absent from Prometheus labels;
- evidence is already visible inside the pool callback, before upstream work;
- a waiter queued under revision 0 and released by a revision-1 capacity expansion
  is attributed to the exact revision-1 Latchflo grant that woke it;
- observe-mode bypasses do not create successful-admission provenance;
- the fixed 512-event ring drops the oldest record and increments `dropped`
  rather than growing without bound.

The matching TypeScript unit/integration test sources also type-check
successfully in this environment.

## Passed checks in this review environment

- `npm run verify:vendor`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- `npm run verify:admission-provenance`
- `npm run verify:routing`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- Validation of both committed example configuration files
- `npm run smoke:telemetry`, including
  `tyr_build_info{version="0.26.0"}` after its release assertion was updated
- `git diff --check`
- `npm pack --dry-run` for `tyr-admission-controller@0.26.0`: 46 packaged files,
  135,364 bytes packed / 554,776 bytes unpacked in this environment

## Full Vitest suite limitation

`npm test` cannot be reported as passing in this Linux review environment because
Vitest cannot start with the uploaded repository's macOS `node_modules`. The
archive contains the Darwin Rolldown native binding while this host requires
`@rolldown/binding-linux-x64-gnu@1.1.5`; startup fails before any test file is
loaded.

A clean dependency reinstall could not be completed here because this container
has no working npm registry DNS access. This is an environment limitation, not a
passing test result. The complete Vitest suite therefore still needs to be run
from a clean target-platform install before tagging or publishing.

Run:

```bash
rm -rf node_modules
npm ci
npm run release:check
```

`release:check` includes the new exact-admission-provenance executable verifier in
addition to the full Vitest suite and the existing routing, class, demand,
handoff, progressive, lint, typecheck, smoke, vendor, and package checks.

## Compatibility boundary

Tyr 0.26.0 changes no runtime dependency, admission policy, capacity accounting,
or Latchflo wire protocol. It adds a bounded local evidence surface only.

Successful capacity-holding admissions are recorded from
async-bulkhead-llm's synchronous `admit` event after the slot/token reservation is
held and before Tyr invokes the upstream callback. Observe-mode bypasses are not
reported as successful admissions. Exact high-cardinality provenance remains in
`/stats`/audit-style evidence and is not exported as Prometheus labels.

Latchflo 0.12.0 remains compatible without protocol changes. MoFlux Bench can
consume the event's matching `grantId` and `limitRevision` to prove that a batch
admission used the committed successor grant instead of inferring ordering from a
500 ms polling window.
