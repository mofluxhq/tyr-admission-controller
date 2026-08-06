import { describe, expect, it } from "vitest";
import type { LLMReservationEstimate } from "async-bulkhead-llm";
import {
  chooseCapacityCandidate,
  scoreCapacityCandidate,
  type RoutingPoolCapacity,
} from "../src/routing.js";

function pool(input: Partial<RoutingPoolCapacity> = {}): RoutingPoolCapacity {
  return {
    revision: 1,
    admissionMode: "enforce",
    closed: false,
    maxConcurrent: 8,
    inFlight: 2,
    pending: 0,
    maxQueue: 0,
    availableConcurrency: 6,
    tokenBudget: {
      budget: 10_000,
      inFlightTokens: 2_000,
      normalAvailable: 8_000,
      highAvailable: 8_000,
    },
    ...input,
  };
}

const reservation: LLMReservationEstimate = {
  input: 500,
  maxOutput: 2_500,
  reserved: 3_000,
};

describe("capacity-aware routing", () => {
  it("selects the replica with request-specific token and concurrency headroom", () => {
    const constrained = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: pool({
        availableConcurrency: 4,
        tokenBudget: {
          budget: 10_000,
          inFlightTokens: 6_500,
          normalAvailable: 3_500,
          highAvailable: 3_500,
        },
      }),
      priority: "normal",
      reservation,
    });
    const roomy = scoreCapacityCandidate({
      instanceId: "tyr-b",
      local: false,
      baseUrl: "http://tyr-b:8787",
      pool: pool({ availableConcurrency: 3 }),
      priority: "normal",
      reservation,
    });

    expect(chooseCapacityCandidate([constrained, roomy])?.instanceId).toBe(
      "tyr-b",
    );
  });

  it("prefers the local replica when capacity scores are equal", () => {
    const local = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: pool(),
      priority: "normal",
      reservation,
    });
    const peer = scoreCapacityCandidate({
      instanceId: "tyr-b",
      local: false,
      baseUrl: "http://tyr-b:8787",
      pool: pool(),
      priority: "normal",
      reservation,
    });

    expect(chooseCapacityCandidate([peer, local])?.instanceId).toBe("tyr-a");
  });

  it("uses the high-priority budget instead of the normal reserve boundary", () => {
    const constrained = pool({
      tokenBudget: {
        budget: 10_000,
        inFlightTokens: 6_000,
        normalAvailable: 1_000,
        highAvailable: 4_000,
      },
    });

    expect(
      scoreCapacityCandidate({
        instanceId: "tyr-a",
        local: true,
        pool: constrained,
        priority: "normal",
        reservation,
      }).admissible,
    ).toBe(false);
    expect(
      scoreCapacityCandidate({
        instanceId: "tyr-a",
        local: true,
        pool: constrained,
        priority: "high",
        reservation,
      }).admissible,
    ).toBe(true);
  });


  it("excludes a replica that would violate another class's protected floor", () => {
    const protectedPool: RoutingPoolCapacity = {
      revision: 1,
      admissionMode: "enforce",
      closed: false,
      maxConcurrent: 3,
      inFlight: 2,
      pending: 0,
      maxQueue: 0,
      availableConcurrency: 1,
      admissionClasses: {
        defaultClass: "standard",
        shared: {
          maxConcurrent: 0,
          inFlight: 0,
          availableConcurrency: 0,
        },
        classes: {
          premium: {
            inFlight: 2,
            protectedConcurrent: 2,
            protectedConcurrentInUse: 2,
            borrowedConcurrent: 0,
            availableProtectedConcurrency: 0,
            maxConcurrent: 3,
            availableConcurrency: 1,
            inFlightTokens: 0,
            protectedInFlightTokens: 0,
            protectedTokensInUse: 0,
            borrowedInFlightTokens: 0,
            availableProtectedTokens: 0,
            maxInFlightTokens: null,
            availableTokens: null,
          },
          standard: {
            inFlight: 0,
            protectedConcurrent: 1,
            protectedConcurrentInUse: 0,
            borrowedConcurrent: 0,
            availableProtectedConcurrency: 1,
            maxConcurrent: 3,
            availableConcurrency: 3,
            inFlightTokens: 0,
            protectedInFlightTokens: 0,
            protectedTokensInUse: 0,
            borrowedInFlightTokens: 0,
            availableProtectedTokens: 0,
            maxInFlightTokens: null,
            availableTokens: null,
          },
        },
      },
    };
    const premium = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: protectedPool,
      priority: "normal",
      admissionClass: "premium",
      reservation: null,
    });
    const standard = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: protectedPool,
      priority: "normal",
      admissionClass: "standard",
      reservation: null,
    });

    expect(premium.admissible).toBe(false);
    expect(premium.sharedConcurrencyHeadroom).toBe(-1);
    expect(standard.admissible).toBe(true);
  });

  it("does not route enforce-mode traffic into an observe-mode peer", () => {
    const observePeer = scoreCapacityCandidate({
      instanceId: "tyr-b",
      local: false,
      baseUrl: "http://tyr-b:8787",
      pool: pool({ admissionMode: "observe" }),
      priority: "normal",
      reservation,
    });

    expect(observePeer.admissible).toBe(false);
  });

  it("returns no target when every snapshot predicts an immediate rejection", () => {
    const full = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: pool({ availableConcurrency: 0, inFlight: 8 }),
      priority: "normal",
      reservation,
    });
    expect(chooseCapacityCandidate([full])).toBeUndefined();
  });
});
