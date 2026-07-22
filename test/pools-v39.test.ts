import { describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "async-bulkhead-llm";
import { createPools } from "../src/pools.js";

const request = (content = "hello"): LLMRequest => ({
  model: "gpt-4o",
  messages: [{ role: "user", content }],
  max_tokens: 0,
});

describe("async-bulkhead-llm v3.9 pool runtime", () => {
  it("reuses the immutable estimate and exposes the native admitted context", async () => {
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
    const llmRequest = request("a".repeat(400));
    const prepared = pool.prepare(llmRequest, "normal");

    expect(prepared.reservation).not.toBeNull();
    expect(prepared.reservation?.reserved).toBe(
      prepared.reservation!.input + prepared.reservation!.maxOutput,
    );
    expect(prepared.advisory.admit).toBe(true);
    expect(prepared.advisory.detail?.tokenBudget?.requested).toBe(
      prepared.reservation?.reserved,
    );

    await pool.run(
      llmRequest,
      prepared,
      async (_signal, context) => {
        expect(context).toMatchObject({
          admission: "admitted",
          reservation: prepared.reservation,
        });
        expect(context?.bypassReason).toBeUndefined();
        expect(context?.reportUsage({ input: 10, output: 0 })).toMatchObject({
          admissionId: context?.admissionId,
          sequence: 1,
          consumed: 10,
        });
        return undefined;
      },
      { priority: "normal" },
    );

    expect(pool.stats().tyr.advisory).toMatchObject({
      checked: 1,
      wouldAdmit: 1,
      wouldReject: 0,
    });
  });

  it("delegates observe bypasses and usage accounting to v3.9", async () => {
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
        expect(context).toMatchObject({
          admission: "bypassed",
          bypassReason: "budget_limit",
          reservation: prepared.reservation,
        });
        expect(context?.admissionId).toMatch(/^shadow-/);
        expect(context?.bypassDetail?.tokenBudget).toMatchObject({
          budget: 0,
          requested: prepared.reservation?.reserved,
        });
        expect(context?.reportUsage({ input: 3, output: 2 })).toMatchObject({
          sequence: 1,
          held: 0,
          consumed: 5,
        });
        return "proxied";
      },
      { priority: "normal" },
    );

    expect(value).toBe("proxied");
    const stats = pool.stats();
    expect(stats.llm.admitted).toBe(0);
    expect(stats.observe).toMatchObject({
      bypassed: 1,
      bypassedByReason: { budget_limit: 1 },
      usageReported: 1,
      totalInputTokens: 3,
      totalOutputTokens: 2,
    });
    expect(stats.tyr.observe).toEqual(stats.observe);
    expect(stats.tyr.advisory.rejectedByReason.budget_limit).toBe(1);
  });

  it("learns adaptive corrections from bypassRelease usage", async () => {
    const pools = createPools([
      {
        name: "adaptive-shadow",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        budget: 0,
        admissionMode: "observe",
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

  it("honors a restricted shadowReasons list", async () => {
    const pools = createPools([
      {
        name: "restricted",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        budget: 0,
        admissionMode: "observe",
        shadowReasons: ["concurrency_limit"],
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const llmRequest = request();
    const callback = vi.fn(async () => "must not run");

    await expect(
      pool.run(llmRequest, pool.prepare(llmRequest, "normal"), callback, {
        priority: "normal",
      }),
    ).rejects.toMatchObject({ reason: "budget_limit" });
    expect(callback).not.toHaveBeenCalled();
    expect(pool.stats().tyr.observe.bypassed).toBe(0);
  });

  it("never bypasses an already-aborted client request", async () => {
    const pools = createPools([
      {
        name: "aborted",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        budget: 0,
        admissionMode: "observe",
      },
    ]);
    const pool = pools.select("gpt-4o")!;
    const llmRequest = request();
    const controller = new AbortController();
    const callback = vi.fn(async () => "must not run");
    controller.abort();

    await expect(
      pool.run(llmRequest, pool.prepare(llmRequest, "normal"), callback, {
        priority: "normal",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(callback).not.toHaveBeenCalled();
    expect(pool.stats().tyr.observe.bypassed).toBe(0);
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
    const callback = vi.fn(async () => "must not run");

    await expect(
      pool.run(llmRequest, pool.prepare(llmRequest, "normal"), callback, {
        priority: "normal",
      }),
    ).rejects.toMatchObject({ reason: "shutdown" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("validates shadowReasons and adaptive-estimation requirements", () => {
    expect(() =>
      createPools([
        {
          name: "invalid-shadow",
          modelPrefixes: ["gpt"],
          model: "gpt-4o",
          maxConcurrent: 1,
          shadowReasons: ["budget_limit", "budget_limit"],
        },
      ]),
    ).toThrow(/shadowReasons must not contain duplicates/);

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
