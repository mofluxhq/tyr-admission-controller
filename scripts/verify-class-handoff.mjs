import assert from "node:assert/strict";
import { LatchfloTyrAgent } from "../dist/latchflo.js";

const pool = "openai-primary";
let desiredRevision = 10;
let premiumInFlight = 8;
let premiumInFlightTokens = 16_000;
let currentLimits = {
  revision: 10,
  maxConcurrent: 8,
  maxQueue: 0,
  tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
  admissionClasses: {
    premium: {
      protectedConcurrent: 4,
      maxConcurrent: 8,
      protectedInFlightTokens: 8_000,
      maxInFlightTokens: 16_000,
    },
    noisy: {
      protectedConcurrent: 0,
      maxConcurrent: 8,
      protectedInFlightTokens: 0,
      maxInFlightTokens: 16_000,
    },
  },
};
const events = [];
const registrations = [];

function classStats(id, inFlight, inFlightTokens) {
  const limits = currentLimits.admissionClasses[id];
  const protectedConcurrent = limits.protectedConcurrent ?? 0;
  const protectedInFlightTokens = limits.protectedInFlightTokens ?? 0;
  const protectedConcurrentInUse = Math.min(inFlight, protectedConcurrent);
  const protectedTokensInUse = Math.min(inFlightTokens, protectedInFlightTokens);
  return {
    limits,
    inFlight,
    protectedConcurrentInUse,
    borrowedConcurrent: Math.max(0, inFlight - protectedConcurrentInUse),
    inFlightTokens,
    protectedTokensInUse,
    borrowedInFlightTokens: Math.max(0, inFlightTokens - protectedTokensInUse),
    admitted: 0,
    released: 0,
    rejected: 0,
    rejectedByReason: {},
    totalReserved: 0,
    totalConsumed: 0,
    totalRefunded: 0,
    totalOverrun: 0,
    totalBorrowedAdmissions: 0,
    totalBorrowedTokensReserved: 0,
  };
}

function stats() {
  const premium = classStats("premium", premiumInFlight, premiumInFlightTokens);
  const noisy = classStats("noisy", 0, 0);
  const protectedConcurrentTotal =
    (currentLimits.admissionClasses.premium.protectedConcurrent ?? 0) +
    (currentLimits.admissionClasses.noisy.protectedConcurrent ?? 0);
  const protectedTokenTotal =
    (currentLimits.admissionClasses.premium.protectedInFlightTokens ?? 0) +
    (currentLimits.admissionClasses.noisy.protectedInFlightTokens ?? 0);
  return {
    bulkhead: { inFlight: premiumInFlight, pending: 0 },
    tokenBudget: {
      inFlightTokens: premiumInFlightTokens,
      available: Math.max(0, 16_000 - premiumInFlightTokens),
    },
    admissionClasses: {
      defaultClass: "noisy",
      classes: { noisy, premium },
      shared: {
        maxConcurrent: Math.max(0, 8 - protectedConcurrentTotal),
        inFlight: premium.borrowedConcurrent + noisy.borrowedConcurrent,
        availableConcurrent: Math.max(
          0,
          8 - protectedConcurrentTotal - premium.borrowedConcurrent - noisy.borrowedConcurrent,
        ),
        tokenBudget: {
          budget: Math.max(0, 16_000 - protectedTokenTotal),
          inFlightTokens:
            premium.borrowedInFlightTokens + noisy.borrowedInFlightTokens,
          available: Math.max(
            0,
            16_000 -
              protectedTokenTotal -
              premium.borrowedInFlightTokens -
              noisy.borrowedInFlightTokens,
          ),
        },
      },
    },
  };
}

function desiredClasses() {
  if (desiredRevision === 10) return currentLimits.admissionClasses;
  return {
    premium: {
      protectedConcurrent: 4,
      maxConcurrent: desiredRevision >= 12 ? 5 : 8,
      protectedInFlightTokens: 8_000,
      maxInFlightTokens: desiredRevision >= 12 ? 10_000 : 16_000,
    },
    noisy: {
      protectedConcurrent: 2,
      maxConcurrent: 8,
      protectedInFlightTokens: 4_000,
      maxInFlightTokens: 16_000,
    },
  };
}

function desiredState() {
  return {
    controllerEpoch: 7,
    serverTime: new Date().toISOString(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
    grants: [
      {
        grantId: `00000000-0000-4000-8000-${String(desiredRevision).padStart(12, "0")}`,
        instanceId: "tyr-a",
        pool,
        controllerEpoch: 7,
        revision: desiredRevision,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        limits: {
          revision: desiredRevision,
          maxConcurrent: 8,
          maxQueue: 0,
          tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
          admissionClasses: desiredClasses(),
        },
      },
    ],
  };
}

const control = {
  limits: () => ({ [pool]: currentLimits }),
  stats: () => ({ [pool]: stats() }),
  applyLimits: (updates) => {
    const update = updates[0];
    assert.equal(update.pool, pool);
    const previous = currentLimits;
    currentLimits = update.limits;
    return {
      applied: true,
      pools: {
        [pool]: {
          previous,
          current: currentLimits,
          ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
        },
      },
    };
  },
};

function demandSnapshot() {
  const currentStats = stats();
  const admissionClasses = Object.keys(currentStats.admissionClasses.classes)
    .sort()
    .map((admissionClass) => {
      const state = currentStats.admissionClasses.classes[admissionClass];
      return {
        admissionClass,
        inFlight: state.inFlight,
        recentAdmissions: 0,
        recentRejections: 0,
        recentBudgetRejections: 0,
        recentConcurrencyRejections: 0,
        protectedConcurrent: state.limits.protectedConcurrent ?? 0,
        protectedConcurrentInUse: state.protectedConcurrentInUse,
        borrowedConcurrent: state.borrowedConcurrent,
        maxConcurrent: state.limits.maxConcurrent,
        inFlightTokens: state.inFlightTokens,
        protectedInFlightTokens: state.limits.protectedInFlightTokens ?? 0,
        protectedTokensInUse: state.protectedTokensInUse,
        borrowedInFlightTokens: state.borrowedInFlightTokens,
        maxInFlightTokens: state.limits.maxInFlightTokens,
      };
    });
  return [
    {
      pool,
      observedAt: new Date().toISOString(),
      inFlight: premiumInFlight,
      pending: 0,
      recentAdmissions: 0,
      recentRejections: 0,
      recentBudgetRejections: 0,
      recentConcurrencyRejections: 0,
      inFlightTokens: premiumInFlightTokens,
      availableTokens: Math.max(0, 16_000 - premiumInFlightTokens),
      admissionClasses,
    },
  ];
}

const fetchImpl = async (input, init = {}) => {
  const url = String(input);
  if (url.endsWith("/v1/agents/register")) {
    registrations.push(JSON.parse(String(init.body ?? "{}")));
    return new globalThis.Response(
      JSON.stringify({ agentToken: "issued-token", controllerEpoch: 7 }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }
  if (url.endsWith("/desired-state")) {
    return new globalThis.Response(JSON.stringify(desiredState()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/ack")) {
    events.push({ type: "ack", body: JSON.parse(String(init.body ?? "{}")) });
    return new globalThis.Response("{}", { status: 200 });
  }
  if (url.endsWith("/heartbeat")) {
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    events.push({ type: "heartbeat", body });
    const premium = body?.demand?.[0]?.admissionClasses?.find(
      (entry) => entry.admissionClass === "premium",
    );
    // Simulate attrition after Latchflo has received the first post-ACK class
    // snapshot. That first snapshot is unsafe under the restored noisy floor,
    // so Tyr must publish again on the accelerated evidence cadence.
    if (desiredRevision === 11 && premium?.borrowedConcurrent === 4) {
      premiumInFlight = 6;
      premiumInFlightTokens = 12_000;
    } else if (desiredRevision === 12 && premium?.inFlight === 6) {
      premiumInFlight = 5;
      premiumInFlightTokens = 10_000;
    }
    return new globalThis.Response("{}", { status: 200 });
  }
  return new globalThis.Response("{}", { status: 200 });
};

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const agent = new LatchfloTyrAgent({
  controlPlaneUrl: "http://latchflo.invalid",
  instanceId: "tyr-a",
  pools: [pool],
  bootstrapToken: "bootstrap-token",
  control,
  fetch: fetchImpl,
  demandProvider: demandSnapshot,
  logger: { info() {}, warn() {}, error() {} },
});

await agent.start();
await waitFor(() => events.some((event) => event.type === "heartbeat"));
assert.equal(registrations.length, 1);
assert.equal(registrations[0].capabilities.admissionClassDemand, true);
assert.equal(registrations[0].capabilities.grantOccupancyAck, true);
assert.equal(registrations[0].capabilities.admissionClassOccupancyAck, true);

events.length = 0;
desiredRevision = 11;
await agent.pollNow();

assert.ok(events.length >= 2, "class restoration should ACK then publish occupancy");
assert.equal(events[0].type, "ack");
assert.equal(events[0].body.status, "applied");
assert.equal(events[0].body.revision, 11);
const ackPremium = events[0].body.occupancy.admissionClasses.find(
  (entry) => entry.admissionClass === "premium",
);
const ackNoisy = events[0].body.occupancy.admissionClasses.find(
  (entry) => entry.admissionClass === "noisy",
);
assert.equal(ackPremium.borrowedConcurrent, 4);
assert.equal(ackPremium.borrowedInFlightTokens, 8_000);
assert.equal(ackNoisy.protectedConcurrent, 2);
assert.equal(ackNoisy.protectedInFlightTokens, 4_000);

assert.equal(events[1].type, "heartbeat");
let firstPremium = events[1].body.demand[0].admissionClasses.find(
  (entry) => entry.admissionClass === "premium",
);
assert.equal(firstPremium.borrowedConcurrent, 4);
assert.equal(firstPremium.borrowedInFlightTokens, 8_000);

await waitFor(
  () => events.filter((event) => event.type === "heartbeat").length >= 2,
  1_500,
);
const finalHeartbeat = events.filter((event) => event.type === "heartbeat").at(-1);
const finalPremium = finalHeartbeat.body.demand[0].admissionClasses.find(
  (entry) => entry.admissionClass === "premium",
);
assert.equal(finalPremium.borrowedConcurrent, 2);
assert.equal(finalPremium.borrowedInFlightTokens, 4_000);

let heartbeatCount = events.filter((event) => event.type === "heartbeat").length;
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(
  events.filter((event) => event.type === "heartbeat").length,
  heartbeatCount,
  "accelerated cadence should stop after a safe class snapshot is published",
);

// A class hard-ceiling reduction is also restrictive even when protected floors
// do not change. Tyr must publish until the class itself is within the new hard
// concurrency and token ceilings.
events.length = 0;
desiredRevision = 12;
await agent.pollNow();
assert.equal(events[0].type, "ack");
assert.equal(events[0].body.revision, 12);
assert.equal(events[1].type, "heartbeat");
const hardLimitFirst = events[1].body.demand[0].admissionClasses.find(
  (entry) => entry.admissionClass === "premium",
);
assert.equal(hardLimitFirst.inFlight, 6);
assert.equal(hardLimitFirst.maxConcurrent, 5);
assert.equal(hardLimitFirst.inFlightTokens, 12_000);
assert.equal(hardLimitFirst.maxInFlightTokens, 10_000);

await waitFor(
  () => events.filter((event) => event.type === "heartbeat").length >= 2,
  1_500,
);
const hardLimitFinal = events
  .filter((event) => event.type === "heartbeat")
  .at(-1).body.demand[0].admissionClasses.find(
    (entry) => entry.admissionClass === "premium",
  );
assert.equal(hardLimitFinal.inFlight, 5);
assert.equal(hardLimitFinal.inFlightTokens, 10_000);
heartbeatCount = events.filter((event) => event.type === "heartbeat").length;
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(
  events.filter((event) => event.type === "heartbeat").length,
  heartbeatCount,
  "hard-limit evidence cadence should stop after the class is safe",
);

agent.stop();
console.log("admission-class handoff verification passed");
