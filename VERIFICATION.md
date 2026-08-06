# Tyr 0.22.0 verification

Date: 2026-08-06

## Version alignment

- Tyr package version: `0.22.0`
- Runtime dependency: `async-bulkhead-llm@3.15.1`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Bundled runtime artifacts:
  - `vendor/async-bulkhead-llm-3.15.1.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- The lockfile resolves all three runtime packages from the bundled artifacts.

## Passed checks

- ESLint with zero warnings
- Strict TypeScript type-check
- Production TypeScript build
- Validation of `config/tyr.example.yaml`
- Validation of `config/tyr.latchflo.example.yaml`
- Capacity-aware routing executable verification
- Protected admission-class executable verification, including lease-expiration
  fail-closed behavior and restoration from a later class-omitting grant
- Latchflo demand-reporting executable verification
- Progressive-reconciliation executable verification
- Gateway-level Anthropic SSE verification showing:
  - processed input capacity returned before stream completion;
  - the configured future-output safety hold retained mid-stream;
  - final settlement to zero in-flight tokens;
  - final provider usage recorded as 20 input plus 40 output tokens.
- ESM smoke imports
- Prometheus telemetry smoke verification, including bounded live per-class
  gauges and counters plus build-version alignment with `package.json`
- npm package dry run for `tyr-admission-controller@0.22.0`
- Clean production-only `npm ci --offline` from the source archive's bundled
  runtime artifacts
- Runtime import verification after the production-only install
- `git diff --check`

## Full test-suite limitation

`npm test` could not start in the verification container. The uploaded repository
contained the macOS Rolldown native optional dependency, while the verification
host requires `@rolldown/binding-linux-x64-gnu`. Vitest exited during startup
before loading any test file.

This is not recorded as a passing test run. The returned repository archive omits `node_modules`; run `npm ci` on the
target platform and then `npm run release:check` before tagging or publishing
`v0.22.0`. Publish `async-bulkhead-llm@3.15.1` first: Tyr's npm package uses
that exact registry dependency, while the source archive retains a vendored
copy for reproducible offline production installs.
