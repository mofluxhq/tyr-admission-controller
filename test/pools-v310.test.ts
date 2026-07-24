import { describe, expect, it } from "vitest";
import type { LLMRequest } from "async-bulkhead-llm";
import { createPools } from "../src/pools.js";

const request = (content = "hello"): LLMRequest => ({
  model: "gpt-4o",
  messages: [{ role: "user", content }],
  max_tokens: 0,
});

describe("async-bulkhead-llm v3.10 pool runtime", () => {
  it("reuses the immutable estimate for detailed preview and admission", async () => {
    const pools = createPools([
      {
        name: "exact",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        budget: 10_000,
        adaptiveEstimation: { enabled: false },
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const prepared = pool.prepare(request("a".repeat(400)), "normal");

    expect(prepared.reservation).not.toBeNull();
    expect(prepared.reservation?.reserved).toBe(
      prepared.reservation!.input + prepared.reservation!.maxOutput,
    );
    expect(prepared.advisory.admit).toBe(true);
    expect(prepared.advisory.detail?.tokenBudget?.requested).toBe(
      prepared.reservation?.reserved,
    );

    let callbackReservation: number | undefined;
    await pool.run(
      request("a".repeat(400)),
      prepared,
      async (_signal, context) => {
        callbackReservation = context?.reservation?.reserved;
        return { usage: { input: 10, output: 0 } };
      },
      {
        priority: "normal",
        getUsage: (result) => result.usage,
      },
    );

    expect(callbackReservation).toBe(prepared.reservation?.reserved);
    expect(pool.stats().tyr.advisory).toMatchObject({
      checked: 1,
      wouldAdmit: 1,
      wouldReject: 0,
    });
  });

  it("executes shadow traffic while preserving the simulated rejection", async () => {
    const pools = createPools([
      {
        name: "shadow",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        budget: 0,
        admissionMode: "observe",
        adaptiveEstimation: { enabled: false },
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const llmRequest = request();
    const prepared = pool.prepare(llmRequest, "normal");

    expect(prepared.advisory).toMatchObject({
      admit: false,
      reason: "budget_limit",
    });

    const value = await pool.run(
      llmRequest,
      prepared,
      async (_signal, context) => {
        expect(context?.admissionId).toMatch(/^shadow-/);
        context?.reportUsage({ input: 3, output: 2 });
        return "proxied";
      },
      { priority: "normal" },
    );

    expect(value).toBe("proxied");
    const stats = pool.stats();
    expect(stats.llm.admitted).toBe(0);
    expect(stats.tyr.observe).toMatchObject({
      bypassed: 1,
      usageReported: 1,
      totalInputTokens: 3,
      totalOutputTokens: 2,
    });
    expect(stats.tyr.advisory.rejectedByReason.budget_limit).toBe(1);
  });

  it("learns a per-model correction from release usage", async () => {
    const pools = createPools([
      {
        name: "adaptive",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        budget: 100_000,
        adaptiveEstimation: {
          enabled: true,
          minSamples: 1,
          smoothing: 1,
          minCorrection: 0.25,
          maxCorrection: 4,
        },
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const llmRequest = request("x".repeat(800));
    const before = pool.prepare(llmRequest, "normal");
    const baseInput = before.reservation!.input;

    await pool.run(
      llmRequest,
      before,
      async () => ({ usage: { input: baseInput * 2, output: 0 } }),
      {
        priority: "normal",
        getUsage: (result) => result.usage,
      },
    );

    const after = pool.prepare(llmRequest, "normal");
    expect(after.reservation?.input).toBe(baseInput * 2);
    expect(pool.stats().tyr.adaptiveEstimation.corrections).toEqual([
      {
        model: "gpt-4o",
        samples: 1,
        factor: 2,
        applied: 2,
      },
    ]);
  });

  it("returns outstanding work when bounded drain expires", async () => {
    const pools = createPools([
      {
        name: "drain",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const llmRequest = request();
    const prepared = pool.prepare(llmRequest, "normal");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = pool.run(
      llmRequest,
      prepared,
      async () => {
        await blocked;
        return undefined;
      },
      { priority: "normal" },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await pools.drain(10);
    expect(result).toMatchObject({ drained: false, inFlight: 1, pending: 0 });
    expect(result.pools.drain).toMatchObject({
      drained: false,
      inFlight: 1,
      pending: 0,
    });

    release();
    await running;
  });

  it("never shadows shutdown rejections", async () => {
    const pools = createPools([
      {
        name: "closed",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        admissionMode: "observe",
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    pools.close();
    const llmRequest = request();
    const prepared = pool.prepare(llmRequest, "normal");

    await expect(
      pool.run(llmRequest, prepared, async () => "must not run", {
        priority: "normal",
      }),
    ).rejects.toMatchObject({ reason: "shutdown" });
  });
  it("rejects enabled adaptive estimation without a token budget", () => {
    expect(() =>
      createPools([
        {
          name: "invalid-adaptive",
          modelPrefixes: ["gpt"],
          model: "gpt-4o",
          maxConcurrent: 1,
          adaptiveEstimation: { enabled: true },
        },
      ]),
    ).toThrow(/adaptiveEstimation requires.*budget/);
  });

});

describe("v3.10 versioned pool limits", () => {
  it("seeds and exposes complete versioned snapshots", () => {
    const pools = createPools([
      {
        name: "versioned",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 3,
        maxQueue: 2,
        initialRevision: 41,
        budget: 20_000,
        highPriorityReserve: 4_000,
        adaptiveEstimation: { enabled: false },
      },
    ]);

    expect(pools.limits()).toEqual({
      versioned: {
        revision: 41,
        maxConcurrent: 3,
        maxQueue: 2,
        tokenBudget: { budget: 20_000, highPriorityReserve: 4_000 },
      },
    });
    expect(pools.get("versioned")?.controller.limits()).toEqual(
      pools.limits().versioned,
    );
  });

  it("applies a complete higher-revision update and supports a kill switch", async () => {
    const pools = createPools([
      {
        name: "controlled",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        initialRevision: 5,
        budget: 20_000,
        adaptiveEstimation: { enabled: false },
      },
    ]);

    const result = pools.applyLimits([
      {
        pool: "controlled",
        limits: {
          revision: 6,
          maxConcurrent: 0,
          maxQueue: 10,
          tokenBudget: { budget: 0, highPriorityReserve: 0 },
        },
      },
    ]);

    expect(result).toMatchObject({ applied: true });
    expect(pools.limits().controlled).toEqual({
      revision: 6,
      maxConcurrent: 0,
      maxQueue: 10,
      tokenBudget: { budget: 0, highPriorityReserve: 0 },
    });

    const pool = pools.get("controlled")!;
    const llmRequest = request();
    const prepared = pool.prepare(llmRequest, "normal");
    expect(prepared.limits.revision).toBe(6);
    expect(prepared.advisory).toMatchObject({
      admit: false,
      reason: "budget_limit",
    });
    await expect(
      pool.run(llmRequest, prepared, async () => "must not run", {
        priority: "normal",
      }),
    ).rejects.toMatchObject({ reason: "budget_limit" });
  });

  it("preflights a multi-pool update so stale input cannot partially mutate", () => {
    const pools = createPools([
      {
        name: "a",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        initialRevision: 10,
      },
      {
        name: "b",
        modelPrefixes: ["claude"],
        model: "claude-sonnet-4",
        maxConcurrent: 2,
        initialRevision: 20,
      },
    ]);

    const before = pools.limits();
    const result = pools.applyLimits([
      {
        pool: "a",
        limits: { revision: 11, maxConcurrent: 4, maxQueue: 0 },
      },
      {
        pool: "b",
        limits: { revision: 20, maxConcurrent: 8, maxQueue: 0 },
      },
    ]);

    expect(result).toMatchObject({
      applied: false,
      reason: "stale_revision",
      pool: "b",
    });
    expect(pools.limits()).toEqual(before);
  });

  it("snapshots external limit objects once before applying them", () => {
    const pools = createPools([
      {
        name: "accessors",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        initialRevision: 3,
      },
    ]);
    const reads = { revision: 0, maxConcurrent: 0, maxQueue: 0 };
    const limits = {
      get revision() {
        reads.revision += 1;
        return reads.revision === 1 ? 4 : 0;
      },
      get maxConcurrent() {
        reads.maxConcurrent += 1;
        return reads.maxConcurrent === 1 ? 2 : 99;
      },
      get maxQueue() {
        reads.maxQueue += 1;
        return reads.maxQueue === 1 ? 1 : 99;
      },
    };

    expect(pools.applyLimits([{ pool: "accessors", limits }])).toMatchObject({
      applied: true,
    });
    expect(reads).toEqual({ revision: 1, maxConcurrent: 1, maxQueue: 1 });
    expect(pools.limits().accessors).toEqual({
      revision: 4,
      maxConcurrent: 2,
      maxQueue: 1,
    });
  });

  it("starts accepted waiters immediately when a new revision raises concurrency", async () => {
    const pools = createPools([
      {
        name: "scale-up",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        maxQueue: 1,
        initialRevision: 1,
      },
    ]);
    const pool = pools.get("scale-up")!;
    const firstRequest = request("first");
    const secondRequest = request("second");

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted!: () => void;
    const secondDidStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let releaseSecond!: () => void;
    const secondBlocked = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = pool.run(
      firstRequest,
      pool.prepare(firstRequest, "normal"),
      async () => {
        await firstBlocked;
      },
      { priority: "normal" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = pool.run(
      secondRequest,
      pool.prepare(secondRequest, "normal"),
      async () => {
        secondStarted();
        await secondBlocked;
      },
      { priority: "normal" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(pool.stats().bulkhead).toMatchObject({ inFlight: 1, pending: 1 });
    expect(
      pools.applyLimits([
        {
          pool: "scale-up",
          limits: { revision: 2, maxConcurrent: 2, maxQueue: 1 },
        },
      ]),
    ).toMatchObject({ applied: true });

    await secondDidStart;
    expect(pool.stats().bulkhead).toMatchObject({ inFlight: 2, pending: 0 });
    releaseSecond();
    releaseFirst();
    await Promise.all([first, second]);
  });

  it("uses native observe context and reports the applied limit revision", async () => {
    const pools = createPools([
      {
        name: "native-observe",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        initialRevision: 8,
        budget: 0,
        admissionMode: "observe",
        adaptiveEstimation: { enabled: false },
      },
    ]);
    const pool = pools.get("native-observe")!;
    const llmRequest = request();
    const prepared = pool.prepare(llmRequest, "normal");

    await pool.run(
      llmRequest,
      prepared,
      async (_signal, context) => {
        expect(context).toMatchObject({
          admission: "bypassed",
          bypassReason: "budget_limit",
          limitRevision: 8,
        });
        expect(context?.admissionId).toMatch(/^shadow-/);
        context?.reportUsage({ input: 2, output: 1 });
        return "proxied";
      },
      { priority: "normal" },
    );

    expect(pool.stats().tyr.observe).toMatchObject({
      bypassed: 1,
      bypassedByReason: { budget_limit: 1 },
      usageReported: 1,
      totalInputTokens: 2,
      totalOutputTokens: 1,
    });
  });
});
