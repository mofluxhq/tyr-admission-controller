# Tyr 0.30.0 verification

Date: 2026-09-03

## Version alignment

- Tyr package version: `0.30.0`
- Runtime version constant: `0.30.0`
- Runtime dependency: `async-bulkhead-llm@3.17.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts:
  - `vendor/async-bulkhead-llm-3.17.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Package repository: `git@github.com:mofluxhq/tyr-admission-controller.git`

## Required release order

`async-bulkhead-llm@3.17.0` must be published before Tyr 0.30.0 is tagged or
released. Tyr's committed lockfile intentionally resolves the exact bundled
`vendor/async-bulkhead-llm-3.17.0.tgz`, so the Tyr build is reproducible while
the dependency release is staged; the vendor artifact is not a substitute for
publishing the declared public package version.

## Borrowed-resource restoration contract

An admission class may configure:

```yaml
borrowedAdmissionSlot:
  releaseMechanism: deadline_abandonment
  deadlineMs: 30000
```

The deadline starts only after admission and applies only when that admission
actually borrowed local concurrency. Expiry has deliberately different meaning
for each constrained resource:

| Resource | Release mechanism | Enforceability | Expiry behavior |
|---|---|---|---|
| Tyr admission slot | `deadline_abandonment` | `enforced` | The borrowed local concurrency slot is returned immediately. |
| Local token accounting | callback settlement | `enforced` locally | The reservation remains held until the callback settles, and unbounded drain waits for it. |
| Upstream capacity | `abort_signal` | `unverified` | Tyr requests cancellation but does not claim provider quota, queue, or accelerator capacity was reclaimed. |

Where provider-side termination cannot be proven, an unlent provider/account
floor or independently enforceable partition remains necessary for an upstream
capacity guarantee.

## Executable restoration verification

Run:

```bash
npm run verify:borrowed-restoration
```

The verifier builds Tyr and checks that:

- an expired borrowed admission returns its local concurrency slot;
- the admission's token hold remains while callback work is unsettled;
- that outstanding token hold cannot be falsely re-admitted as free capacity;
- a protected class can admit after local slot restoration;
- no-timeout drain remains pending until the detached callback settles;
- final callback settlement releases the remaining accounting and allows drain;
- `/stats` and Prometheus distinguish enforced local release from unverified
  upstream cancellation.

Vitest integration coverage additionally verifies the `504
borrowed_admission_deadline` response, response headers, structured audit event,
bounded metrics, and strict rejection of incomplete or misleading policy values.

## Observable contract

Successful admission response headers include exact resource attribution:

- `x-admission-slot-borrowed`
- `x-admission-borrowed-tokens`
- `x-admission-slot-deadline-ms` when the borrowed-slot policy applies

On expiry before response headers are sent, Tyr returns `504` with
`x-admission-reason: borrowed_admission_deadline`. The JSON body states that the
local slot was released, upstream cancellation was requested, and upstream
reclamation is unverified.

`GET /stats` exposes `tyr.restoration` per pool. Prometheus exposes:

- `tyr_resource_release_events_total`
- `tyr_pool_work_in_flight`
- `tyr_pool_borrowed_admission_slot_deadlines_total`
- `tyr_pool_admission_class_borrowed_slot_deadlines_total`

The resource metric uses fixed `resource`, `release_mechanism`,
`enforceability`, and `outcome` values. No provider, model, tenant, request,
admission, or grant identifier is introduced as a label.

## Latchflo compatibility

Tyr registers the additive capability
`borrowedAdmissionSlotDeadlines: true`. Older Latchflo versions may ignore it.
Latchflo continues to replace only numeric admission-class limits; the deadline
and release mechanism remain fixed local Tyr policy. The provider request path
still has no synchronous control-plane call.

## Carried-forward compatibility

Tyr 0.30.0 retains the native Anthropic Messages, OpenAI Chat Completions, and
stateless OpenAI Responses routes from 0.29.0. Existing identity, routing,
managed-mode, provenance, timing, retry-hint, and progressive-reconciliation
paths remain intact. Classes without `borrowedAdmissionSlot` keep the existing
non-preemptive drain behavior.

## Release gate

From a clean dependency install on Node.js 20 or newer:

```bash
npm ci
npm run release:check
```

The release gate verifies vendored tarball integrity, lint, TypeScript, the full
Vitest suite, all executable integration verifiers (including borrowed
restoration), smoke imports, and `npm pack --dry-run`.

For independent configuration checks:

```bash
npm run build
node dist/cli.js validate --config config/tyr.example.yaml
TYR_ROUTING_SECRET=verification-secret \
  node dist/cli.js validate --config config/tyr.latchflo.example.yaml
git diff --check
```

## Recorded results

The full release gate passed in this review environment on 2026-09-03:

- 13 Vitest files passed, containing 194 tests;
- every executable verifier passed, including the six borrowed-restoration
  assertions;
- both shipped YAML examples passed runtime CLI validation;
- telemetry smoke and `git diff --check` passed;
- `npm pack --dry-run` included 48 files, approximately 148.6 kB packed and
  613.0 kB unpacked.

The final ZIP is checked from a fresh extraction before delivery. It excludes
platform-specific `node_modules`; consumers install the locked development
dependencies with `npm ci`.
