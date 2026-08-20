import { describe, expect, it } from "vitest";
import type { LLMAdmissionLimits } from "async-bulkhead-llm";
import { TyrDemandReporter } from "../src/demand.js";
import { createLatchfloManagedMode } from "../src/latchflo.js";
import type {
  AdmissionProvenance,
  PoolLimitsUpdate,
  TyrPoolStats,
} from "../src/pools.js";
import type { TyrControlPlane } from "../src/server.js";

function poolStats(input: {
  admitted?: number;
  rejected?: number;
  budgetRejected?: number;
  concurrencyRejected?: number;
  inFlight?: number;
  pending?: number;
  inFlightTokens?: number;
  availableTokens?: number;
} = {}): TyrPoolStats {
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
      admissionProvenance: {
        capacity: 512,
        retained: 0,
        dropped: 0,
        captureFailures: 0,
        nextSequence: 1,
        events: [],
      },
    },
  };
}


function classPoolStats(input: {
  premiumAdmitted?: number;
  premiumRejected?: number;
  premiumBudgetRejected?: number;
  premiumConcurrencyRejected?: number;
  noisyAdmitted?: number;
  noisyRejected?: number;
} = {}): TyrPoolStats {
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
        tokenBudget: {
          budget: 2_500,
          inFlightTokens: 500,
          available: 2_000,
        },
      },
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
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

describe("Tyr Latchflo demand reporting", () => {
  it("reports live pressure and deltas since the last accepted heartbeat", () => {
    let now = Date.parse("2026-08-01T20:00:00.000Z");
    let current = poolStats();
    const control = {
      limits: () => ({}),
      stats: () => ({ interactive: current }),
      applyLimits: () => ({
        applied: false as const,
        reason: "unknown_pool" as const,
        pool: "interactive",
      }),
    } satisfies TyrControlPlane;
    const reporter = new TyrDemandReporter(control, ["interactive"], () => now);

    expect(reporter.capture()).toEqual([
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
    expect(reporter.capture()).toEqual([
      {
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
      },
    ]);
    reporter.commit();

    now += 1_000;
    expect(reporter.capture()[0]).toMatchObject({
      recentAdmissions: 0,
      recentRejections: 0,
      lastRequestAt: "2026-08-01T20:00:01.000Z",
      inFlight: 2,
    });
  });

  it("does not lose activity when a captured heartbeat is not accepted", () => {
    let current = poolStats({ admitted: 2, rejected: 1, budgetRejected: 1 });
    const control = {
      limits: () => ({}),
      stats: () => ({ interactive: current }),
      applyLimits: () => ({
        applied: false as const,
        reason: "unknown_pool" as const,
        pool: "interactive",
      }),
    } satisfies TyrControlPlane;
    const reporter = new TyrDemandReporter(control, ["interactive"], () => 1_000);

    expect(reporter.capture()[0]).toMatchObject({
      recentAdmissions: 2,
      recentRejections: 1,
      recentBudgetRejections: 1,
    });
    // No commit: simulate a failed heartbeat.
    current = poolStats({ admitted: 4, rejected: 3, budgetRejected: 2, concurrencyRejected: 1 });
    expect(reporter.capture()[0]).toMatchObject({
      recentAdmissions: 4,
      recentRejections: 3,
      recentBudgetRejections: 2,
      recentConcurrencyRejections: 1,
    });
  });

  it("reports bounded per-class demand and protected/borrowed utilization", () => {
    let now = Date.parse("2026-08-07T20:00:00.000Z");
    let current = classPoolStats({
      premiumAdmitted: 5,
      premiumRejected: 2,
      premiumBudgetRejected: 1,
      premiumConcurrencyRejected: 1,
      noisyAdmitted: 1,
    });
    const control = {
      limits: () => ({}),
      stats: () => ({ interactive: current }),
      applyLimits: () => ({
        applied: false as const,
        reason: "unknown_pool" as const,
        pool: "interactive",
      }),
    } satisfies TyrControlPlane;
    const reporter = new TyrDemandReporter(control, ["interactive"], () => now);

    expect(reporter.capture()[0]?.admissionClasses).toEqual([
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
        maxConcurrent: 4,
        inFlightTokens: 1_000,
        protectedInFlightTokens: 3_000,
        protectedTokensInUse: 1_000,
        borrowedInFlightTokens: 0,
        maxInFlightTokens: 5_000,
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
        maxConcurrent: 4,
        inFlightTokens: 2_500,
        protectedInFlightTokens: 2_000,
        protectedTokensInUse: 2_000,
        borrowedInFlightTokens: 500,
        maxInFlightTokens: 5_000,
        lastRequestAt: "2026-08-07T20:00:00.000Z",
      },
    ]);
    reporter.commit();

    now += 1_000;
    current = classPoolStats({
      premiumAdmitted: 7,
      premiumRejected: 3,
      premiumBudgetRejected: 2,
      premiumConcurrencyRejected: 1,
      noisyAdmitted: 1,
    });
    expect(reporter.capture()[0]?.admissionClasses).toEqual([
      expect.objectContaining({
        admissionClass: "noisy",
        recentAdmissions: 0,
        recentRejections: 0,
        lastRequestAt: "2026-08-07T20:00:00.000Z",
      }),
      expect.objectContaining({
        admissionClass: "premium",
        recentAdmissions: 2,
        recentRejections: 1,
        recentBudgetRejections: 1,
        recentConcurrencyRejections: 0,
        lastRequestAt: "2026-08-07T20:00:01.000Z",
      }),
    ]);
  });

  it("retains per-class deltas until the heartbeat is accepted", () => {
    let current = classPoolStats({ premiumAdmitted: 2, premiumRejected: 1 });
    const control = {
      limits: () => ({}),
      stats: () => ({ interactive: current }),
      applyLimits: () => ({
        applied: false as const,
        reason: "unknown_pool" as const,
        pool: "interactive",
      }),
    } satisfies TyrControlPlane;
    const reporter = new TyrDemandReporter(control, ["interactive"], () => 1_000);

    expect(reporter.capture()[0]?.admissionClasses?.find(
      (entry) => entry.admissionClass === "premium",
    )).toMatchObject({ recentAdmissions: 2, recentRejections: 1 });

    current = classPoolStats({ premiumAdmitted: 4, premiumRejected: 3 });
    expect(reporter.capture()[0]?.admissionClasses?.find(
      (entry) => entry.admissionClass === "premium",
    )).toMatchObject({ recentAdmissions: 4, recentRejections: 3 });
  });

  it("automatically includes demand snapshots in managed-mode heartbeats", async () => {
    let current = poolStats({
      admitted: 4,
      rejected: 2,
      budgetRejected: 2,
      inFlight: 1,
      inFlightTokens: 700,
      availableTokens: 6_800,
    });
    const limits: Record<string, LLMAdmissionLimits> = {
      interactive: { revision: 0, maxConcurrent: 0, maxQueue: 0 },
    };
    const control: TyrControlPlane = {
      limits: () => ({ ...limits }),
      stats: () => ({ interactive: current }),
      applyLimits: (updates: readonly PoolLimitsUpdate[]) => {
        const applied: Record<string, {
          previous: LLMAdmissionLimits;
          current: LLMAdmissionLimits;
          provenance?: AdmissionProvenance;
        }> = {};
        for (const update of updates) {
          const previous = limits[update.pool];
          if (previous === undefined) {
            return { applied: false, reason: "unknown_pool", pool: update.pool };
          }
          limits[update.pool] = update.limits;
          applied[update.pool] = {
            previous,
            current: update.limits,
            ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
          };
        }
        return { applied: true, pools: applied };
      },
    };

    const heartbeatBodies: unknown[] = [];
    const fetchStub: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        return new Response(
          JSON.stringify({ agentToken: "agent-token", controllerEpoch: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/desired-state")) {
        return new Response(
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
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
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

    mode.start();
    await waitFor(() => heartbeatBodies.length > 0);
    expect(heartbeatBodies[0]).toMatchObject({
      demand: [
        {
          pool: "interactive",
          inFlight: 1,
          recentAdmissions: 4,
          recentRejections: 2,
          recentBudgetRejections: 2,
          recentConcurrencyRejections: 0,
          inFlightTokens: 700,
          availableTokens: 6_800,
        },
      ],
    });

    const heartbeatCountBeforeIdle = heartbeatBodies.length;
    current = poolStats({ admitted: 4, rejected: 2, budgetRejected: 2 });

    // Tyr 0.25 may emit an additional post-ACK occupancy heartbeat when the
    // applied grant tightens any capacity dimension. Do not assume the next
    // managed heartbeat has a fixed array index; wait for a heartbeat emitted
    // after this state transition that reflects the new idle occupancy.
    const idleHeartbeat = (): unknown =>
      heartbeatBodies.slice(heartbeatCountBeforeIdle).find((body) => {
        const snapshot = (body as {
          demand?: Array<{
            inFlight?: number;
            recentAdmissions?: number;
            recentRejections?: number;
          }>;
        }).demand?.[0];
        return (
          snapshot?.inFlight === 0 &&
          snapshot.recentAdmissions === 0 &&
          snapshot.recentRejections === 0
        );
      });

    await waitFor(() => idleHeartbeat() !== undefined);
    expect(idleHeartbeat()).toMatchObject({
      demand: [
        {
          recentAdmissions: 0,
          recentRejections: 0,
          inFlight: 0,
        },
      ],
    });
    mode.stop();
  });
});
