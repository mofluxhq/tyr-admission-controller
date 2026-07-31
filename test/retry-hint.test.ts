import { describe, expect, it } from "vitest";
import type { LLMRejectDetail } from "async-bulkhead-llm";
import { RetryHintEstimator, retryAfterSeconds } from "../src/retry-hint.js";

function detail(over: Partial<LLMRejectDetail> = {}): LLMRejectDetail {
  return {
    limitRevision: 1,
    inFlight: 4,
    maxConcurrent: 4,
    pending: 0,
    maxQueue: 8,
    ...over,
  };
}

/** Drives `count` completions spaced `gapMs` apart, starting at `startMs`. */
function warm(
  est: RetryHintEstimator,
  pool: string,
  count: number,
  gapMs: number,
  startMs = 1_000,
  tokens = 0,
): number {
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    est.observeCompletion(pool, tokens, t);
    t += gapMs;
  }
  return t - gapMs;
}

describe("RetryHintEstimator honesty rules", () => {
  it("emits nothing before it has observed enough completions", () => {
    const est = new RetryHintEstimator({ minSamples: 3 });
    // Two observations produce only one interval — below the threshold.
    est.observeCompletion("p", 0, 1_000);
    est.observeCompletion("p", 0, 1_400);
    expect(est.hintMs("p", "concurrency_limit", detail(), 1_500)).toBeUndefined();
  });

  it("emits nothing for a pool it has never seen", () => {
    const est = new RetryHintEstimator();
    expect(est.hintMs("unknown", "concurrency_limit", detail(), 1_000)).toBeUndefined();
  });

  it("emits nothing for reasons that waiting cannot fix", () => {
    const est = new RetryHintEstimator();
    const last = warm(est, "p", 6, 400);
    for (const reason of ["shutdown", "aborted", "unshareable_result"] as const) {
      expect(est.hintMs("p", reason, detail(), last + 10)).toBeUndefined();
    }
    // ...but a capacity shortage does get one.
    expect(est.hintMs("p", "concurrency_limit", detail(), last + 10)).toBeDefined();
  });

  it("is disabled wholesale when configured off", () => {
    const est = new RetryHintEstimator({ enabled: false });
    const last = warm(est, "p", 6, 400);
    expect(est.hintMs("p", "concurrency_limit", detail(), last + 10)).toBeUndefined();
  });
});

describe("RetryHintEstimator estimates", () => {
  it("uses roughly one completion interval when nothing is queued", () => {
    const est = new RetryHintEstimator({ minMs: 0 });
    const last = warm(est, "p", 8, 400);
    const hint = est.hintMs("p", "concurrency_limit", detail({ pending: 0 }), last);
    expect(hint).toBeGreaterThan(300);
    expect(hint).toBeLessThan(500);
  });

  it("scales with the queue ahead of the caller", () => {
    const est = new RetryHintEstimator({ minMs: 0 });
    const last = warm(est, "p", 8, 400);
    const alone = est.hintMs("p", "queue_limit", detail({ pending: 0 }), last)!;
    const behindThree = est.hintMs("p", "queue_limit", detail({ pending: 3 }), last)!;
    expect(behindThree).toBeGreaterThan(alone * 3);
  });

  it("counts elapsed time against the wait", () => {
    const est = new RetryHintEstimator({ minMs: 0 });
    const last = warm(est, "p", 8, 400);
    const immediately = est.hintMs("p", "concurrency_limit", detail(), last)!;
    const later = est.hintMs("p", "concurrency_limit", detail(), last + 300)!;
    expect(later).toBeLessThan(immediately);
    expect(immediately - later).toBeCloseTo(300, -1);
  });

  it("derives budget waits from how many completions release enough tokens", () => {
    const est = new RetryHintEstimator({ minMs: 0 });
    const last = warm(est, "p", 8, 400, 1_000, 1_000);
    // Needs 3_000 more tokens; each completion frees ~1_000 => ~3 intervals.
    const hint = est.hintMs(
      "p",
      "budget_limit",
      detail({
        tokenBudget: {
          budget: 10_000,
          inFlightTokens: 9_500,
          effectiveBudget: 10_000,
          available: 500,
          requested: 3_500,
        },
      }),
      last,
    )!;
    expect(hint).toBeGreaterThan(1_000);
    expect(hint).toBeLessThan(1_500);
  });

  it("declines to guess a budget wait with no token detail", () => {
    const est = new RetryHintEstimator();
    const last = warm(est, "p", 8, 400);
    expect(est.hintMs("p", "budget_limit", detail(), last)).toBeUndefined();
  });

  it("clamps to the configured floor and ceiling", () => {
    const fast = new RetryHintEstimator({ minMs: 250 });
    const lastFast = warm(fast, "fast", 8, 1);
    expect(fast.hintMs("fast", "concurrency_limit", detail(), lastFast)).toBe(250);

    const slow = new RetryHintEstimator({ maxMs: 2_000 });
    const lastSlow = warm(slow, "slow", 8, 60_000);
    expect(slow.hintMs("slow", "concurrency_limit", detail(), lastSlow)).toBe(2_000);
  });

  it("keeps pools independent", () => {
    const est = new RetryHintEstimator({ minMs: 0 });
    const lastA = warm(est, "a", 8, 200);
    warm(est, "b", 8, 2_000, 50_000);
    const a = est.hintMs("a", "concurrency_limit", detail(), lastA)!;
    const b = est.hintMs("b", "concurrency_limit", detail(), 50_000 + 7 * 2_000)!;
    expect(b).toBeGreaterThan(a * 5);
  });

  it("rejects incoherent configuration", () => {
    expect(() => new RetryHintEstimator({ minMs: -1 })).toThrow(/minMs/);
    expect(() => new RetryHintEstimator({ minMs: 100, maxMs: 50 })).toThrow(/maxMs/);
    expect(() => new RetryHintEstimator({ halfLifeMs: 0 })).toThrow(/halfLifeMs/);
    expect(() => new RetryHintEstimator({ minSamples: 0 })).toThrow(/minSamples/);
  });
});

describe("retryAfterSeconds", () => {
  it("declines sub-second waits the header cannot express honestly", () => {
    // Publishing `Retry-After: 1` here would park a compliant client far
    // longer than the actual wait — worse than its own backoff.
    expect(retryAfterSeconds(1)).toBeUndefined();
    expect(retryAfterSeconds(400)).toBeUndefined();
    expect(retryAfterSeconds(999)).toBeUndefined();
  });

  it("rounds up so the header is never earlier than capacity", () => {
    expect(retryAfterSeconds(1_000)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(2_000)).toBe(2);
    expect(retryAfterSeconds(2_001)).toBe(3);
  });
});
