# Tyr 0.33.0 verification

Date: 2026-09-23

## Version alignment

- Tyr package version: `0.33.0`
- Runtime version constant: `0.33.0`
- Runtime dependency: `async-bulkhead-llm@3.17.0`
- Transitive bulkhead dependency: `async-bulkhead-ts@1.0.1`
- Vendored runtime artifacts:
  - `vendor/async-bulkhead-llm-3.17.0.tgz`
  - `vendor/async-bulkhead-ts-1.0.1.tgz`
  - `vendor/yaml-2.9.0.tgz`
- Package repository: `https://github.com/mofluxhq/tyr-admission-controller.git`

## Required release order

`async-bulkhead-llm@3.17.0` was published for Tyr 0.30.0; 0.33.0 uses the same
release. Tyr's committed lockfile intentionally resolves the exact bundled
`vendor/async-bulkhead-llm-3.17.0.tgz`, so the Tyr build is reproducible while
the dependency release is staged; the vendor artifact is not a substitute for
publishing the declared public package version.

## Self-serve evaluation (0.33.0)

`npm run verify:eval` runs the evaluation for 5 seconds per phase and passes
only if the direct phase shows contention, every interactive request completes
through Tyr, the provider rejects nothing behind Tyr, and Tyr rejects batch
work. It is part of `release:check` and runs in CI on Node 20, 22, and 24.

A full `npm run eval` on the development Mac completed 12 of 188 interactive
requests (6%) directly and 60 of 60 through Tyr. The provider rejected 1,380
requests directly and none behind Tyr, and Tyr rejected 1,387 batch requests
with `concurrency_limit`. Batch throughput fell from 14.9 to 9.8 requests per
second. Provider peak concurrency was 8 of 8 in both phases.

With `npm run eval:serve` running, `eval/sdk/quickstart.mjs` (openai-node
7.23.0) and `eval/sdk/quickstart.py` (openai-python 3.19.1) each completed
`responses.create(...)` and a Chat Completions call through Tyr and reported
`class=interactive outcome=admitted`. Interrupting the runner stopped all three
processes and freed ports 8787, 9101, and 9102.

Against the evaluation stack, a request without an identity token returned
`401`, and `max_completion_tokens: 1000` returned `400` because it exceeds
`server.maxOutputTokens: 256`. `/metrics` is readable without an operator token.
A model outside the pool's prefixes stopped the run at the first `422`, and the
runner shut the stack down.

Live mode refuses to start without `OPENAI_API_KEY`, `--model`, and
`--confirm-live`. Run with an invalid key, Tyr forwarded the request over HTTPS
to api.openai.com, OpenAI returned `401 invalid_api_key`, and the runner stopped
at that first error. A billed run against OpenAI was not performed.

## Apache-2.0 license and Korrx removal (0.32.0)

`LICENSE.txt` is byte-identical to the Apache License 2.0 text (SHA-256
`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`), and
`package.json` declares `Apache-2.0`. `npm pack` includes `LICENSE.txt`,
`NOTICE.txt` and `THIRD_PARTY_NOTICES.txt`. An image built from this tree
contains all three files in `/app` and carries the
`org.opencontainers.image.licenses=Apache-2.0` and `source` labels.

`test/gateway.test.ts` asserts that admitted, observe-mode and rejected
responses carry the `x-latchflo-*` grant headers and no `x-korrx-*` headers.
`test/pools-v311.test.ts` asserts that `source: "zab"` and `source: "korrx"`
are rejected with `provenance.source must be "latchflo"` before any pool
changes, and that `source: "latchflo"` applies. `npm run release:check` passes.

## Upstream failure diagnostics (0.31.0)

`test/upstream-failure.test.ts` checks the cause-chain helper on synthetic
chains: it takes the deepest bounded code, rejects unbounded codes and names,
and caps the detail at 300 characters. It also runs two real gateway cases:
- an upstream port that refuses connections must return
  `502 { cause: { name: "Error", code: "ECONNREFUSED" } }`;
- an upstream that destroys the socket after reading the request must return
  `UND_ERR_SOCKET` or `ECONNRESET`.

In both cases the response body must not contain the upstream address, and
exactly one `upstream_failure` diagnostic event must be emitted. The refused
case also checks that `tyr_upstream_failures_total` carries the code label.

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

Tyr 0.33.0 retains the native Anthropic Messages, OpenAI Chat Completions, and
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
