import { describe, expect, it } from "vitest";
import type { LLMRequest } from "async-bulkhead-llm";
import {
  normalizeAdmissionClassesConfig,
  resolveAdmissionClass,
} from "../src/admission-policy.js";
import { createPools } from "../src/pools.js";
import {
  chooseCapacityCandidate,
  scoreCapacityCandidate,
  type RoutingPoolCapacity,
} from "../src/routing.js";

const policy = normalizeAdmissionClassesConfig(
  {
    defaultClass: "standard",
    classes: {
      standard: { maxConcurrent: 1, maxInFlightTokens: 2_000 },
      premium: { maxConcurrent: 1, maxInFlightTokens: 2_000 },
    },
    rules: [
      { admissionClass: "premium", tenantIds: ["tenant-paid"] },
      {
        admissionClass: "premium",
        applicationIds: ["interactive"],
        roles: ["tier.premium"],
      },
    ],
  },
  "policy",
  true,
);

const request: LLMRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 100,
};

describe("identity-aware admission classes", () => {
  it("uses first-match rules with AND selectors and a bounded default", () => {
    expect(
      resolveAdmissionClass(policy, {
        subject: "user-a",
        tenantId: "tenant-paid",
        roles: [],
      }),
    ).toBe("premium");
    expect(
      resolveAdmissionClass(policy, {
        subject: "user-b",
        applicationId: "interactive",
        roles: [],
      }),
    ).toBe("standard");
    expect(
      resolveAdmissionClass(policy, {
        subject: "user-c",
        applicationId: "interactive",
        roles: ["tier.premium"],
      }),
    ).toBe("premium");
  });

  it("isolates concurrency while preserving unused global capacity", async () => {
    const pools = createPools([
      {
        name: "openai",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        budget: 4_000,
        adaptiveEstimation: { enabled: false },
        admissionClasses: policy,
      },
    ]);
    const pool = pools.get("openai")!;
    const prepared = pool.prepare(request, "normal", "premium");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = pool.run(
      request,
      prepared,
      async () => gate,
      { priority: "normal", admissionClass: "premium" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pool.prepare(request, "normal", "premium").advisory).toMatchObject({
      admit: false,
      reason: "concurrency_limit",
    });
    const standard = pool.prepare(request, "normal", "standard");
    expect(standard.advisory.admit).toBe(true);
    await pool.run(request, standard, async () => undefined, {
      priority: "normal",
      admissionClass: "standard",
    });

    release();
    await held;
  });

  it("preserves protected concurrency floors before lending shared capacity", async () => {
    const protectedPolicy = normalizeAdmissionClassesConfig(
      {
        defaultClass: "standard",
        classes: {
          standard: { protectedConcurrent: 1, maxConcurrent: 3 },
          premium: { protectedConcurrent: 2, maxConcurrent: 3 },
        },
      },
      "policy",
      false,
    );
    const pools = createPools([
      {
        name: "openai",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 3,
        adaptiveEstimation: { enabled: false },
        admissionClasses: protectedPolicy,
      },
    ]);
    const pool = pools.get("openai")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = [0, 1].map((index) => {
      const premiumRequest = {
        ...request,
        messages: [{ role: "user" as const, content: `premium-${index}` }],
      };
      const prepared = pool.prepare(premiumRequest, "normal", "premium");
      return pool.run(premiumRequest, prepared, async () => gate, {
        priority: "normal",
        admissionClass: "premium",
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pool.prepare(request, "normal", "premium").advisory).toMatchObject({
      admit: false,
      reason: "concurrency_limit",
      detail: { constraint: "admission_class_protection" },
    });
    const standard = pool.prepare(request, "normal", "standard");
    expect(standard.advisory.admit).toBe(true);
    await pool.run(request, standard, async () => undefined, {
      priority: "normal",
      admissionClass: "standard",
    });

    const classes = pool.stats().admissionClasses!;
    expect(classes.shared.maxConcurrent).toBe(0);
    expect(classes.classes.premium).toMatchObject({
      protectedConcurrentInUse: 2,
      borrowedConcurrent: 0,
    });

    release();
    await Promise.all(held);
  });

  it("records the default class and rejects prepare/run class drift", async () => {
    const pools = createPools([
      {
        name: "openai",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        budget: 4_000,
        adaptiveEstimation: { enabled: false },
        admissionClasses: policy,
      },
    ]);
    const pool = pools.get("openai")!;
    const prepared = pool.prepare(request, "normal");
    expect(prepared.admissionClass).toBe("standard");
    await expect(
      pool.run(request, prepared, async () => undefined, {
        priority: "normal",
        admissionClass: "premium",
      }),
    ).rejects.toThrow(/changed between prepare/);
  });

  it("routes around class-specific exhaustion", () => {
    const base: RoutingPoolCapacity = {
      revision: 1,
      admissionMode: "enforce",
      closed: false,
      maxConcurrent: 4,
      inFlight: 1,
      pending: 0,
      maxQueue: 0,
      availableConcurrency: 3,
      admissionClasses: {
        defaultClass: "standard",
        shared: {
          maxConcurrent: 4,
          inFlight: 1,
          availableConcurrency: 3,
        },
        classes: {
          standard: {
            inFlight: 0,
            protectedConcurrent: 0,
            protectedConcurrentInUse: 0,
            borrowedConcurrent: 0,
            availableProtectedConcurrency: 0,
            maxConcurrent: 1,
            availableConcurrency: 1,
            inFlightTokens: 0,
            protectedInFlightTokens: 0,
            protectedTokensInUse: 0,
            borrowedInFlightTokens: 0,
            availableProtectedTokens: 0,
            maxInFlightTokens: null,
            availableTokens: null,
          },
          premium: {
            inFlight: 1,
            protectedConcurrent: 0,
            protectedConcurrentInUse: 0,
            borrowedConcurrent: 1,
            availableProtectedConcurrency: 0,
            maxConcurrent: 1,
            availableConcurrency: 0,
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
    const local = scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: base,
      priority: "normal",
      admissionClass: "premium",
      reservation: null,
    });
    const peer = scoreCapacityCandidate({
      instanceId: "tyr-b",
      local: false,
      baseUrl: "http://tyr-b:8787",
      pool: {
        ...base,
        inFlight: 0,
        availableConcurrency: 4,
        admissionClasses: {
          ...base.admissionClasses!,
          shared: {
            ...base.admissionClasses!.shared,
            inFlight: 0,
            availableConcurrency: 4,
          },
          classes: {
            ...base.admissionClasses!.classes,
            premium: {
              ...base.admissionClasses!.classes.premium!,
              inFlight: 0,
              borrowedConcurrent: 0,
              availableConcurrency: 1,
            },
          },
        },
      },
      priority: "normal",
      admissionClass: "premium",
      reservation: null,
    });

    expect(local.admissible).toBe(false);
    expect(chooseCapacityCandidate([local, peer])?.instanceId).toBe("tyr-b");
  });

  it("rejects unbounded or invalid policies at startup", () => {
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "missing",
          classes: { standard: { maxConcurrent: 1 } },
        },
        "policy",
        false,
      ),
    ).toThrow(/defaultClass/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "standard",
          classes: { standard: { maxInFlightTokens: 1 } },
        },
        "policy",
        false,
      ),
    ).toThrow(/requires an in-flight token budget/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "standard",
          classes: {
            standard: { protectedConcurrent: 2, maxConcurrent: 1 },
          },
        },
        "policy",
        false,
      ),
    ).toThrow(/protectedConcurrent/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "standard",
          classes: { standard: { protectedInFlightTokens: 1 } },
        },
        "policy",
        false,
      ),
    ).toThrow(/protectedInFlightTokens requires an in-flight token budget/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "standard",
          classes: {
            standard: { maxConcurrent: 1 },
            " standard ": { maxConcurrent: 1 },
          },
        },
        "policy",
        false,
      ),
    ).toThrow(/duplicate normalized class ID/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "toString",
          classes: { standard: { maxConcurrent: 1 } },
        },
        "policy",
        false,
      ),
    ).toThrow(/defaultClass/);
    expect(() =>
      normalizeAdmissionClassesConfig(
        {
          defaultClass: "standard",
          classes: Object.fromEntries([
            ["standard", { maxConcurrent: 1 }],
            ["__proto__", { maxConcurrent: 1 }],
          ]),
        },
        "policy",
        false,
      ),
    ).toThrow(/reserved class ID/);
  });
});
