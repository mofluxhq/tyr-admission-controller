import assert from "node:assert/strict";
import { LatchfloTyrAgent } from "../dist/latchflo.js";

const pool = "openai-primary";
let inFlight = 6;
let inFlightTokens = 12_000;
let desiredRevision = 10;
let desiredMaxConcurrent = 8;
let desiredTokenBudget = 16_000;
let currentLimits = {
  revision: 0,
  maxConcurrent: 0,
  maxQueue: 0,
  tokenBudget: { budget: 0, highPriorityReserve: 0 },
};
const events = [];
const registrations = [];

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
          maxConcurrent: desiredMaxConcurrent,
          maxQueue: 0,
          tokenBudget: { budget: desiredTokenBudget, highPriorityReserve: 0 },
        },
      },
    ],
  };
}

const control = {
  limits: () => ({ [pool]: currentLimits }),
  stats: () => ({
    [pool]: {
      bulkhead: { inFlight, pending: 0 },
      tokenBudget: { inFlightTokens },
    },
  }),
  applyLimits: (updates) => {
    const previous = currentLimits;
    const update = updates[0];
    assert.equal(update.pool, pool);
    currentLimits = update.limits;
    return {
      applied: true,
      pools: {
        [pool]: {
          previous,
          current: currentLimits,
          ...(update.provenance === undefined
            ? {}
            : { provenance: update.provenance }),
        },
      },
    };
  },
};

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
    // Simulate local attrition racing with the HTTP response. The snapshot that
    // Latchflo actually received is still above the target, so Tyr must send
    // another accelerated heartbeat rather than trusting newer local state.
    if (desiredRevision === 11 && body?.demand?.[0]?.inFlight === 6) {
      inFlight = 4;
      inFlightTokens = 8_000;
    }
    return new globalThis.Response("{}", { status: 200 });
  }
  return new globalThis.Response("{}", { status: 200 });
};

function demandSnapshot() {
  return [
    {
      pool,
      observedAt: new Date().toISOString(),
      inFlight,
      pending: 0,
      recentAdmissions: 0,
      recentRejections: 0,
      recentBudgetRejections: 0,
      recentConcurrencyRejections: 0,
      inFlightTokens,
      availableTokens: Math.max(
        0,
        currentLimits.tokenBudget.budget - inFlightTokens,
      ),
    },
  ];
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
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
assert.equal(registrations[0].capabilities.grantOccupancyAck, true);

events.length = 0;
desiredRevision = 11;
desiredMaxConcurrent = 4;
desiredTokenBudget = 8_000;
await agent.pollNow();

assert.ok(events.length >= 2, "shrink should ACK and immediately publish occupancy");
assert.equal(events[0].type, "ack");
assert.equal(events[0].body.status, "applied");
assert.equal(events[0].body.revision, 11);
assert.equal(events[0].body.occupancy.inFlight, 6);
assert.equal(events[0].body.occupancy.inFlightTokens, 12_000);
assert.equal(events[1].type, "heartbeat");
assert.equal(events[1].body.demand[0].inFlight, 6);
assert.equal(events[1].body.demand[0].inFlightTokens, 12_000);
assert.equal(inFlight, 4);
assert.equal(inFlightTokens, 8_000);

await waitFor(
  () => events.filter((event) => event.type === "heartbeat").length >= 2,
  1_500,
);
const finalHeartbeat = events.filter((event) => event.type === "heartbeat").at(-1);
assert.equal(finalHeartbeat.body.demand[0].inFlight, 4);
assert.equal(finalHeartbeat.body.demand[0].inFlightTokens, 8_000);

agent.stop();
console.log("capacity handoff verification passed");
