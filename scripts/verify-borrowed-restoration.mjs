#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  LLMBorrowedConcurrencyDeadlineError,
  LLMBulkheadRejectedError,
} from "async-bulkhead-llm";
import { createPools } from "../dist/pools.js";
import { TyrTelemetry } from "../dist/telemetry.js";

const request = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "resource restoration proof" }],
  max_tokens: 350,
};

const pools = createPools([
  {
    name: "verify",
    modelPrefixes: ["gpt"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 1_000,
    adaptiveEstimation: { enabled: false },
    progressiveReconciliation: { enabled: false },
    admissionClasses: {
      defaultClass: "background",
      classes: {
        interactive: {
          protectedConcurrent: 1,
          protectedInFlightTokens: 600,
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
        },
        background: {
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
          borrowedAdmissionSlot: {
            releaseMechanism: "deadline_abandonment",
            deadlineMs: 25,
          },
        },
      },
    },
  },
]);
const pool = pools.get("verify");
assert.ok(pool);

let finish;
let callbackSignal;
const borrowed = pool.run(
  request,
  pool.prepare(request, "normal", "background"),
  async (signal, context) => {
    callbackSignal = signal;
    assert.equal(context.resources.borrowedConcurrency, true);
    assert.ok(context.resources.borrowedTokens > 0);
    await new Promise((resolve) => {
      finish = resolve;
    });
  },
  { priority: "normal", admissionClass: "background" },
);

await assert.rejects(borrowed, LLMBorrowedConcurrencyDeadlineError);
assert.equal(callbackSignal.aborted, true);

const whileDetached = pool.stats();
assert.equal(whileDetached.bulkhead.inFlight, 0);
assert.equal(whileDetached.llm.inFlight, 1);
assert.equal(whileDetached.llm.borrowedConcurrencyAbandoned, 1);
// The slot came back because the lease expired, not via an explicit call.
assert.deepEqual(whileDetached.llm.borrowedConcurrencyAbandonedByCause, {
  deadline: 1,
});
assert.deepEqual(
  whileDetached.tyr.restoration.admissionSlots.releasedByCause,
  { deadline: 1 },
);
assert.equal(
  whileDetached.tyr.restoration.upstreamCapacity.cancellationRequested,
  1,
);
assert.ok(whileDetached.tokenBudget.inFlightTokens > 0);
assert.deepEqual(
  whileDetached.tyr.restoration.admissionSlots.configuredDeadlinesMs,
  { background: 25 },
);
assert.equal(
  whileDetached.tyr.restoration.upstreamCapacity.enforceability,
  "unverified",
);
assert.equal(
  whileDetached.tyr.restoration.upstreamCapacity.activeAccountingHolds,
  1,
);
console.log("PASS local borrowed slot released while token accounting remains held");

const blocked = pool.run(
  request,
  pool.prepare(request, "normal", "background"),
  async () => undefined,
  { priority: "normal", admissionClass: "background" },
);
await assert.rejects(blocked, (error) => {
  assert.ok(error instanceof LLMBulkheadRejectedError);
  assert.equal(error.reason, "budget_limit");
  return true;
});
console.log("PASS outstanding borrowed tokens cannot be falsely re-admitted");

await pool.run(
  request,
  pool.prepare(request, "normal", "interactive"),
  async (_signal, context) => {
    assert.equal(context.resources.borrowedConcurrency, false);
    return "protected";
  },
  { priority: "normal", admissionClass: "interactive" },
);
console.log("PASS protected class remains admissible during borrowed accounting hold");

let unboundedDrained = false;
const unboundedDrain = pool.drain().then(() => {
  unboundedDrained = true;
});
await Promise.resolve();
assert.equal(unboundedDrained, false);
console.log("PASS unbounded drain waits for final token settlement after slot release");

finish();
await unboundedDrain;
assert.equal(unboundedDrained, true);
assert.deepEqual(await pool.drain(250), {
  drained: true,
  inFlight: 0,
  pending: 0,
});
assert.equal(pool.stats().tokenBudget.inFlightTokens, 0);
console.log("PASS final settlement releases the retained token hold and drain completes");

const metrics = new TyrTelemetry().renderPrometheus(pools.stats(), true);
assert.match(
  metrics,
  /tyr_resource_release_events_total\{enforceability="enforced",outcome="released",pool="verify",release_mechanism="deadline_abandonment",resource="admission_slot"\} 1/,
);
assert.match(
  metrics,
  /tyr_resource_release_events_total\{enforceability="unverified",outcome="cancellation_requested",pool="verify",release_mechanism="abort_signal",resource="upstream_capacity"\} 1/,
);
console.log("PASS resource-specific enforceability is exported without claiming upstream reclamation");

assert.match(
  metrics,
  /tyr_pool_borrowed_admission_slot_deadlines_total\{pool="verify"\} 1/,
);
console.log("PASS deadline-caused slot returns are counted as deadline expiries");
