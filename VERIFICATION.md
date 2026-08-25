# Tyr 0.27.0 verification

Date: 2026-08-25

## Version alignment

- Tyr package version: `0.27.0`
- Runtime version constant: `0.27.0`
- Runtime dependency: `async-bulkhead-llm@3.16.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts:
  - `vendor/async-bulkhead-llm-3.16.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- The ABL 3.16.0 vendored tarball integrity matches the public npm artifact:
  `sha512-9ZyamC47R4aAo5jFHr6s6V0edTv4aZ8E0ljSsZQ4VI6uQ4tS0fUYftOmeitfVIJ+unccDVgd3biRSb2RBne/XA==`.
- Managed-mode examples, demo image tag, README examples, and telemetry build-info
  assertions report `0.27.0`.

## Admission-decision timing verification

Tyr 0.27.0 consumes the additive `decisionDurationNs` and `queueWaitNs` fields
from async-bulkhead-llm 3.16.0's existing synchronous `admit` and `reject`
events. No unified event or new admission-policy path was introduced.

The executable `npm run verify:admission-timing` verifier passes through the
real OpenAI-compatible gateway path and proves that:

- enforce-mode admitted decisions emit both
  `tyr_admission_decision_seconds` and `tyr_admission_queue_wait_seconds`;
- enforce-mode rejected decisions emit the same two histograms under a distinct
  `outcome="rejected"` series;
- decision and queue-wait `_count` values equal the corresponding bounded
  `tyr_admission_decisions_total` population for each tested outcome;
- a precheck budget rejection contributes exactly `0` to
  `tyr_admission_queue_wait_seconds_sum`;
- a configured admission class is retained as the bounded `admission_class`
  label rather than replaced by a request/model/identity dimension;
- the decision histogram exposes the 5 microsecond lower diagnostic bucket;
- observe-mode bypasses emit no admission timing and no successful-admission
  provenance.

The verifier prints its single-sample timings only as a path check. Those cold,
single-request numbers are not a publishable performance claim and must not be
used as benchmark results.

## Comparison semantics

`tyr_admission_decision_seconds` is the synchronous local admission-decision
span supplied by async-bulkhead-llm and excludes the awaited local concurrency
acquire. `tyr_admission_queue_wait_seconds` reports that wait separately.

For benchmark headline aggregation, consume histogram `_sum` / `_count` per
outcome. Do not pool admitted and rejected decisions: different arms can admit
and reject different mixtures of requests. The fine decision buckets are for
distribution diagnostics, not quantile interpolation of the headline number.

When comparing against an external coordinator whose reserve operation grants or
refuses immediately, Tyr decision duration is the decision-cost comparison;
local queue wait is capacity contention and is not part of that claim.

## Provenance compatibility

`tyr.admission-provenance.v1` was deliberately left unchanged.

A source comparison against the uploaded Tyr 0.26.0 release confirms:

- `TyrAdmissionProvenanceEvent` type block is byte-identical
  (`sha256:16f502903455e65d682e3a8d4a97e37444845e71df1546edc10cf9a48e9fa32b`);
- the `TyrAdmissionProvenanceEvent` record-construction block is byte-identical
  (`sha256:16fc64c36c4282d7a9ba6dee8ac37214ef3836a63299da2261bc4cdd68ce9ae7`);
- `scripts/verify-admission-provenance.mjs` is byte-identical
  (`sha256:e6a69479f3249f129d48ce628360227bcae9d566668552c03e01b19c547053e9`).

`npm run verify:admission-provenance` also passes unchanged against the 0.27.0
runtime.

## Passed checks in this review environment

- `npm run verify:vendor`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke`
- `npm run smoke:telemetry`
- `npm run verify:admission-provenance`
- `npm run verify:admission-timing`
- `npm run verify:routing`
- `npm run verify:admission-classes`
- `npm run verify:demand`
- `npm run verify:handoff`
- `npm run verify:class-handoff`
- `npm run verify:progressive`
- Validation of `config/tyr.example.yaml`
- Validation of `config/tyr.latchflo.example.yaml`
- `git diff --check`
- `npm pack --dry-run` / `npm pack` for `tyr-admission-controller@0.27.0`:
  46 packaged files, approximately 137 kB packed / 562 kB unpacked.

The generated package tarball has SHA-256
`ab4fc4c7c95faa900bc5f5cea59769ec7bf5ee4f826cd32e6cbdce5b9ef514bb`.

## Full Vitest suite limitation

`npm test` cannot be reported as passing in this Linux review environment.
Vitest fails during startup, before loading any test file, because the uploaded
repository's macOS `node_modules` does not contain Rolldown's Linux native
binding `@rolldown/binding-linux-x64-gnu`.

This is an environment startup failure, not a passing test result. Before
committing/tagging the release on the normal development machine, run:

```bash
rm -rf node_modules
npm ci
npm run release:check
```

`release:check` now includes `verify:admission-timing` in addition to the full
Vitest suite and the existing vendor, provenance, routing, admission-class,
demand, handoff, progressive, lint, typecheck, smoke, and package checks.

## Compatibility boundary

Tyr 0.27.0 changes no admission policy, Latchflo wire protocol, upstream request
format, or response semantics. It adds bounded Prometheus instrumentation and
updates the exact vendored async-bulkhead-llm dependency to 3.16.0.

Observe-mode bypasses remain excluded. High-cardinality identifiers remain out
of Prometheus labels. Exact successful-admission provenance remains a separate
bounded `/stats` evidence surface under the unchanged
`tyr.admission-provenance.v1` schema.
