/**
 * Retry-After estimation for rejected admissions.
 *
 * Why this lives in Tyr and not in async-bulkhead-llm
 * ---------------------------------------------------
 * The bulkhead documents a deliberate position: "no retry-after estimate is
 * provided — a fail-fast bulkhead has no honest ETA for capacity." That is
 * correct for the library. It sees admission decisions and nothing else: it
 * does not observe how long work actually takes, so any ETA it produced would
 * be invented.
 *
 * Tyr is a proxy. It watches every upstream call complete and therefore does
 * have the missing signal — how often a capacity slot frees up. That is an
 * observation, not a guess, so Tyr can answer the question the library
 * correctly refuses to.
 *
 * The honesty rule carries over intact: when Tyr has not observed enough
 * completions for a pool, it emits no hint at all rather than a fabricated
 * one. A missing header is a truthful "I don't know"; a wrong one costs the
 * caller either a wasted round trip or a needlessly long wait.
 */

import type { LLMRejectDetail, LLMRejectReason } from "async-bulkhead-llm";

export type RetryHintOptions = {
  /** Emit hints at all. Default: true. */
  readonly enabled?: boolean;
  /**
   * Floor for any emitted hint. Guards against a hot retry loop when the
   * observed completion interval is very small. Default: 50ms.
   */
  readonly minMs?: number;
  /**
   * Ceiling for any emitted hint. Past this, "come back later" is not useful
   * advice and the caller is better off failing over. Default: 30_000ms.
   */
  readonly maxMs?: number;
  /**
   * Half-life of the exponentially weighted moving averages. Shorter reacts
   * faster to load changes; longer is steadier. Default: 5_000ms.
   */
  readonly halfLifeMs?: number;
  /**
   * Completions required before a pool will produce a hint. Below this the
   * averages are too noisy to be worth publishing. Default: 3.
   */
  readonly minSamples?: number;
};

const DEFAULTS = {
  enabled: true,
  minMs: 50,
  maxMs: 30_000,
  halfLifeMs: 5_000,
  minSamples: 3,
} as const;

/**
 * Reasons that get a hint.
 *
 * Excluded deliberately:
 * - `shutdown`: this instance is going away; Tyr closes the connection and the
 *   caller should re-resolve, not wait on a corpse.
 * - `aborted`: the caller cancelled. Nobody is waiting for advice.
 * - `unshareable_result`: a deduplication conflict, not a capacity shortage;
 *   waiting does not change the outcome.
 */
const HINTABLE: ReadonlySet<LLMRejectReason> = new Set<LLMRejectReason>([
  "concurrency_limit",
  "queue_limit",
  "budget_limit",
  "timeout",
]);

type PoolState = {
  /** EWMA of the gap between consecutive completions, in ms. */
  intervalMs: number;
  /** EWMA of tokens released per completion. */
  tokensPerCompletion: number;
  lastCompletionAtMs: number;
  samples: number;
};

export class RetryHintEstimator {
  readonly #opts: Required<RetryHintOptions>;
  readonly #pools = new Map<string, PoolState>();

  constructor(options: RetryHintOptions = {}) {
    const opts = { ...DEFAULTS, ...stripUndefined(options) };
    if (opts.minMs < 0) throw new Error("retryHint.minMs must be >= 0");
    if (opts.maxMs < opts.minMs) {
      throw new Error("retryHint.maxMs must be >= retryHint.minMs");
    }
    if (opts.halfLifeMs <= 0) throw new Error("retryHint.halfLifeMs must be > 0");
    if (opts.minSamples < 1) throw new Error("retryHint.minSamples must be >= 1");
    this.#opts = opts;
  }

  /**
   * Record that a request finished and its capacity returned to the pool.
   *
   * `releasedTokens` is the reservation the request was holding; 0 when the
   * pool has no token budget configured.
   */
  observeCompletion(pool: string, releasedTokens: number, nowMs: number): void {
    if (!this.#opts.enabled) return;
    const state = this.#pools.get(pool);
    if (state === undefined) {
      // First completion establishes a baseline but yields no interval yet —
      // an interval needs two points.
      this.#pools.set(pool, {
        intervalMs: 0,
        tokensPerCompletion: Math.max(0, releasedTokens),
        lastCompletionAtMs: nowMs,
        samples: 0,
      });
      return;
    }
    const gap = Math.max(0, nowMs - state.lastCompletionAtMs);
    const alpha = decayFactor(gap, this.#opts.halfLifeMs);
    state.intervalMs =
      state.samples === 0 ? gap : state.intervalMs * alpha + gap * (1 - alpha);
    state.tokensPerCompletion =
      state.tokensPerCompletion * alpha + Math.max(0, releasedTokens) * (1 - alpha);
    state.lastCompletionAtMs = nowMs;
    state.samples += 1;
  }

  /**
   * Milliseconds the caller should wait, or `undefined` when Tyr cannot
   * answer honestly.
   */
  hintMs(
    pool: string,
    reason: LLMRejectReason,
    detail: LLMRejectDetail | undefined,
    nowMs: number,
  ): number | undefined {
    if (!this.#opts.enabled) return undefined;
    if (!HINTABLE.has(reason)) return undefined;
    const state = this.#pools.get(pool);
    if (state === undefined || state.samples < this.#opts.minSamples) return undefined;
    if (!Number.isFinite(state.intervalMs) || state.intervalMs <= 0) return undefined;

    const completionsAhead = this.#completionsAhead(reason, detail, state);
    if (completionsAhead === undefined) return undefined;

    // Time already elapsed since the last completion counts against the wait:
    // if a slot frees every 400ms and 300ms have passed, the answer is 100ms.
    const elapsed = Math.max(0, nowMs - state.lastCompletionAtMs);
    const raw = completionsAhead * state.intervalMs - elapsed;

    const clamped = Math.min(this.#opts.maxMs, Math.max(this.#opts.minMs, raw));
    return Math.round(clamped);
  }

  /** How many completions must land before this request could be admitted. */
  #completionsAhead(
    reason: LLMRejectReason,
    detail: LLMRejectDetail | undefined,
    state: PoolState,
  ): number | undefined {
    if (reason === "budget_limit") {
      const budget = detail?.tokenBudget;
      if (budget === undefined) return undefined;
      const deficit = Math.max(0, budget.requested - budget.available);
      if (deficit === 0) return 1;
      if (state.tokensPerCompletion <= 0) return undefined;
      return Math.max(1, Math.ceil(deficit / state.tokensPerCompletion));
    }
    // Concurrency and queue shortages both clear as in-flight work drains.
    // Everything already queued is served first, so the caller waits for those
    // plus one more slot for itself.
    const pending = detail?.pending ?? 0;
    return Math.max(1, pending + 1);
  }

  /** Test and diagnostic accessor. */
  snapshot(pool: string): Readonly<PoolState> | undefined {
    const state = this.#pools.get(pool);
    return state === undefined ? undefined : { ...state };
  }
}

/**
 * EWMA weight for the previous value given the elapsed gap.
 *
 * Time-based rather than count-based so that a quiet pool's stale average
 * decays instead of persisting indefinitely.
 */
function decayFactor(gapMs: number, halfLifeMs: number): number {
  return Math.pow(0.5, gapMs / halfLifeMs);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Resolution of the `Retry-After` header: RFC 9110 permits whole seconds. */
const RETRY_AFTER_RESOLUTION_MS = 1_000;

/**
 * Whole-second form of a hint, or `undefined` when the header cannot carry it
 * honestly.
 *
 * `Retry-After` has one-second resolution and is a floor, so a 200ms wait can
 * only be published as `Retry-After: 1`. That would park a compliant client
 * five times longer than necessary — worse than the backoff it would have
 * chosen on its own, which makes the header actively harmful at short waits.
 *
 * So below one second Tyr publishes only `x-admission-retry-after-ms` and
 * leaves the client's own policy alone. Above it, rounding up costs at most
 * a few hundred milliseconds against a wait already measured in seconds, and
 * the header keeps its guarantee: a caller that obeys it never arrives before
 * capacity exists.
 */
export function retryAfterSeconds(hintMs: number): number | undefined {
  if (hintMs < RETRY_AFTER_RESOLUTION_MS) return undefined;
  return Math.ceil(hintMs / RETRY_AFTER_RESOLUTION_MS);
}
