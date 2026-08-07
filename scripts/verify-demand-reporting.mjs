import assert from "node:assert/strict";
import { TyrDemandReporter } from "../dist/demand.js";
import { createLatchfloManagedMode } from "../dist/latchflo.js";

function poolStats(input = {}) {
  return {
    limits: {
      revision: 1,
      maxConcurrent: 8,
      maxQueue: 0,
      tokenBudget: { budget: 7_500, highPriorityReserve: 0 },
    },
    bulkhead: {
      inFlight: input.inFlight ?? 0,
      pending: input.pending ?? 0,
      maxConcurrent: 8,
      maxQueue: 0,
      closed: false,
      totalAdmitted: input.admitted ?? 0,
      totalReleased: 0,
    },
    llm: {
      admitted: input.admitted ?? 0,
      released: 0,
      rejected: input.rejected ?? 0,
      rejectedByReason: {
        budget_limit: input.budgetRejected ?? 0,
        concurrency_limit: input.concurrencyRejected ?? 0,
      },
    },
    tokenBudget: {
      budget: 7_500,
      inFlightTokens: input.inFlightTokens ?? 0,
      available: input.availableTokens ?? 7_500,
      totalReserved: 0,
      totalConsumed: 0,
      totalRefunded: 0,
      totalOverrun: 0,
      highPriorityReserve: 0,
    },
    tyr: {
      admissionMode: "enforce",
      advisory: {
        checked: 0,
        wouldAdmit: 0,
        wouldReject: 0,
        rejectedByReason: {},
      },
      observe: {
        bypassed: 0,
        raceBypassed: 0,
        bypassedByReason: {},
        usageReported: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      adaptiveEstimation: { enabled: false, corrections: [] },
      progressiveReconciliation: {
        enabled: false,
        updateStepTokens: 256,
        outputSafetyMarginTokens: 256,
        reports: 0,
        updates: 0,
        coalesced: 0,
        earlyReleasedTokens: 0,
      },
      provenance: { retainedRevisions: 0 },
    },
  };
}


function classPoolStats(input = {}) {
  const base = poolStats({
    admitted: (input.premiumAdmitted ?? 0) + (input.noisyAdmitted ?? 0),
    rejected: (input.premiumRejected ?? 0) + (input.noisyRejected ?? 0),
    budgetRejected: input.premiumBudgetRejected ?? 0,
    concurrencyRejected: input.premiumConcurrencyRejected ?? 0,
    inFlight: 4,
    inFlightTokens: 3_500,
    availableTokens: 4_000,
  });
  return {
    ...base,
    limits: {
      ...base.limits,
      admissionClasses: {
        premium: {
          protectedConcurrent: 2,
          maxConcurrent: 4,
          protectedInFlightTokens: 2_000,
          maxInFlightTokens: 5_000,
        },
        noisy: {
          protectedConcurrent: 2,
          maxConcurrent: 4,
          protectedInFlightTokens: 3_000,
          maxInFlightTokens: 5_000,
        },
      },
    },
    admissionClasses: {
      defaultClass: "premium",
      classes: {
        premium: {
          limits: {
            protectedConcurrent: 2,
            maxConcurrent: 4,
            protectedInFlightTokens: 2_000,
            maxInFlightTokens: 5_000,
          },
          inFlight: 3,
          protectedConcurrentInUse: 2,
          borrowedConcurrent: 1,
          inFlightTokens: 2_500,
          protectedTokensInUse: 2_000,
          borrowedInFlightTokens: 500,
          admitted: input.premiumAdmitted ?? 0,
          released: 0,
          rejected: input.premiumRejected ?? 0,
          rejectedByReason: {
            budget_limit: input.premiumBudgetRejected ?? 0,
            concurrency_limit: input.premiumConcurrencyRejected ?? 0,
          },
          totalReserved: 0,
          totalConsumed: 0,
          totalRefunded: 0,
          totalOverrun: 0,
          totalBorrowedAdmissions: 0,
          totalBorrowedTokensReserved: 0,
        },
        noisy: {
          limits: {
            protectedConcurrent: 2,
            maxConcurrent: 4,
            protectedInFlightTokens: 3_000,
            maxInFlightTokens: 5_000,
          },
          inFlight: 1,
          protectedConcurrentInUse: 1,
          borrowedConcurrent: 0,
          inFlightTokens: 1_000,
          protectedTokensInUse: 1_000,
          borrowedInFlightTokens: 0,
          admitted: input.noisyAdmitted ?? 0,
          released: 0,
          rejected: input.noisyRejected ?? 0,
          rejectedByReason: {},
          totalReserved: 0,
          totalConsumed: 0,
          totalRefunded: 0,
          totalOverrun: 0,
          totalBorrowedAdmissions: 0,
          totalBorrowedTokensReserved: 0,
        },
      },
      shared: {
        maxConcurrent: 4,
        inFlight: 1,
        availableConcurrent: 3,
        tokenBudget: { budget: 2_500, inFlightTokens: 500, available: 2_000 },
      },
    },
  };
}

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) {
        reject(new Error("condition was not met before timeout"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

let now = Date.parse("2026-08-01T20:00:00.000Z");
let current = poolStats();
const statsOnlyControl = {
  limits: () => ({}),
  stats: () => ({ interactive: current }),
  applyLimits: () => ({ applied: false, reason: "unknown_pool", pool: "interactive" }),
};
const reporter = new TyrDemandReporter(statsOnlyControl, ["interactive"], () => now);
assert.deepEqual(reporter.capture(), [
  {
    pool: "interactive",
    observedAt: "2026-08-01T20:00:00.000Z",
    inFlight: 0,
    pending: 0,
    recentAdmissions: 0,
    recentRejections: 0,
    recentBudgetRejections: 0,
    recentConcurrencyRejections: 0,
    inFlightTokens: 0,
    availableTokens: 7_500,
  },
]);
reporter.commit();

now += 1_000;
current = poolStats({
  admitted: 3,
  rejected: 2,
  budgetRejected: 1,
  concurrencyRejected: 1,
  inFlight: 2,
  inFlightTokens: 1_400,
  availableTokens: 6_100,
});
const pressure = reporter.capture()[0];
assert.deepEqual(pressure, {
  pool: "interactive",
  observedAt: "2026-08-01T20:00:01.000Z",
  inFlight: 2,
  pending: 0,
  recentAdmissions: 3,
  recentRejections: 2,
  recentBudgetRejections: 1,
  recentConcurrencyRejections: 1,
  inFlightTokens: 1_400,
  availableTokens: 6_100,
  lastRequestAt: "2026-08-01T20:00:01.000Z",
});
// Deliberately do not commit; a retry must retain all pressure.
current = poolStats({
  admitted: 5,
  rejected: 4,
  budgetRejected: 2,
  concurrencyRejected: 2,
});
assert.deepEqual(reporter.capture()[0], {
  pool: "interactive",
  observedAt: "2026-08-01T20:00:01.000Z",
  inFlight: 0,
  pending: 0,
  recentAdmissions: 5,
  recentRejections: 4,
  recentBudgetRejections: 2,
  recentConcurrencyRejections: 2,
  inFlightTokens: 0,
  availableTokens: 7_500,
  lastRequestAt: "2026-08-01T20:00:01.000Z",
});

let classNow = Date.parse("2026-08-07T20:00:00.000Z");
let classCurrent = classPoolStats({
  premiumAdmitted: 5,
  premiumRejected: 2,
  premiumBudgetRejected: 1,
  premiumConcurrencyRejected: 1,
  noisyAdmitted: 1,
});
const classControl = {
  limits: () => ({}),
  stats: () => ({ interactive: classCurrent }),
  applyLimits: () => ({ applied: false, reason: "unknown_pool", pool: "interactive" }),
};
const classReporter = new TyrDemandReporter(classControl, ["interactive"], () => classNow);
const classDemand = classReporter.capture()[0].admissionClasses;
assert.deepEqual(classDemand, [
  {
    admissionClass: "noisy",
    inFlight: 1,
    recentAdmissions: 1,
    recentRejections: 0,
    recentBudgetRejections: 0,
    recentConcurrencyRejections: 0,
    protectedConcurrent: 2,
    protectedConcurrentInUse: 1,
    borrowedConcurrent: 0,
    inFlightTokens: 1_000,
    protectedInFlightTokens: 3_000,
    protectedTokensInUse: 1_000,
    borrowedInFlightTokens: 0,
    lastRequestAt: "2026-08-07T20:00:00.000Z",
  },
  {
    admissionClass: "premium",
    inFlight: 3,
    recentAdmissions: 5,
    recentRejections: 2,
    recentBudgetRejections: 1,
    recentConcurrencyRejections: 1,
    protectedConcurrent: 2,
    protectedConcurrentInUse: 2,
    borrowedConcurrent: 1,
    inFlightTokens: 2_500,
    protectedInFlightTokens: 2_000,
    protectedTokensInUse: 2_000,
    borrowedInFlightTokens: 500,
    lastRequestAt: "2026-08-07T20:00:00.000Z",
  },
]);
classReporter.commit();
classNow += 1_000;
classCurrent = classPoolStats({
  premiumAdmitted: 7,
  premiumRejected: 3,
  premiumBudgetRejected: 2,
  premiumConcurrencyRejected: 1,
  noisyAdmitted: 1,
});
const nextClassDemand = classReporter.capture()[0].admissionClasses;
assert.equal(nextClassDemand.find((entry) => entry.admissionClass === "premium").recentAdmissions, 2);
assert.equal(nextClassDemand.find((entry) => entry.admissionClass === "premium").recentRejections, 1);
assert.equal(nextClassDemand.find((entry) => entry.admissionClass === "noisy").recentAdmissions, 0);

const limits = {
  interactive: { revision: 0, maxConcurrent: 0, maxQueue: 0 },
};
current = poolStats({
  admitted: 4,
  rejected: 2,
  budgetRejected: 2,
  inFlight: 1,
  inFlightTokens: 700,
  availableTokens: 6_800,
});
const control = {
  limits: () => ({ ...limits }),
  stats: () => ({ interactive: current }),
  applyLimits: (updates) => {
    const pools = {};
    for (const update of updates) {
      const previous = limits[update.pool];
      if (previous === undefined) {
        return { applied: false, reason: "unknown_pool", pool: update.pool };
      }
      limits[update.pool] = update.limits;
      pools[update.pool] = {
        previous,
        current: update.limits,
        ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
      };
    }
    return { applied: true, pools };
  },
};
const heartbeatBodies = [];
const registrationBodies = [];
const fetchStub = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/v1/agents/register")) {
    registrationBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new globalThis.Response(
      JSON.stringify({ agentToken: "agent-token", controllerEpoch: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.endsWith("/desired-state")) {
    return new globalThis.Response(
      JSON.stringify({
        controllerEpoch: 1,
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: 10,
        pollIntervalMs: 10_000,
        grants: [
          {
            grantId: "00000000-0000-4000-8000-000000000001",
            instanceId: "tyr-a",
            pool: "interactive",
            controllerEpoch: 1,
            revision: 1,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
            limits: {
              revision: 1,
              maxConcurrent: 8,
              maxQueue: 0,
              tokenBudget: { budget: 7_500, highPriorityReserve: 0 },
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.endsWith("/heartbeat")) {
    heartbeatBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new globalThis.Response("{}", { status: 200 });
  }
  return new globalThis.Response("{}", { status: 200 });
};

const mode = createLatchfloManagedMode({
  config: {
    url: "http://latchflo.invalid",
    instanceId: "tyr-a",
    pools: ["interactive"],
    bootstrapTokenEnv: "BOOTSTRAP",
    retryIntervalMs: 10,
    retryMaxIntervalMs: 100,
    requestTimeoutMs: 1_000,
  },
  control,
  env: { BOOTSTRAP: "bootstrap-token" },
  fetch: fetchStub,
  random: () => 0.5,
  logger: { info() {}, warn() {}, error() {} },
});

try {
  mode.start();
  await waitFor(() => heartbeatBodies.length > 0);
  assert.deepEqual(registrationBodies[0]?.capabilities, {
    admissionClasses: true,
    admissionClassDemand: true,
  });
  assert.equal(mode.ready(), true);
  assert.deepEqual(
    {
      ...heartbeatBodies[0].demand[0],
      observedAt: "<timestamp>",
      lastRequestAt: "<timestamp>",
    },
    {
      pool: "interactive",
      observedAt: "<timestamp>",
      inFlight: 1,
      pending: 0,
      recentAdmissions: 4,
      recentRejections: 2,
      recentBudgetRejections: 2,
      recentConcurrencyRejections: 0,
      inFlightTokens: 700,
      availableTokens: 6_800,
      lastRequestAt: "<timestamp>",
    },
  );

  current = poolStats({ admitted: 4, rejected: 2, budgetRejected: 2 });
  await waitFor(() => heartbeatBodies.length > 1);
  assert.equal(heartbeatBodies[1].demand[0].recentAdmissions, 0);
  assert.equal(heartbeatBodies[1].demand[0].recentRejections, 0);
  assert.equal(heartbeatBodies[1].demand[0].inFlight, 0);
} finally {
  mode.stop();
}

console.log("Tyr demand reporting verified");
