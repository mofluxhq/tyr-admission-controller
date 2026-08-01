import type { LLMRejectReason } from "async-bulkhead-llm";
import type { TyrPoolStats } from "./pools.js";
import type { TyrControlPlane } from "./server.js";

/** Demand snapshot accepted by Latchflo 0.6.0 agent heartbeats. */
export type PoolDemandSnapshot = {
  readonly pool: string;
  readonly observedAt: string;
  readonly inFlight: number;
  readonly pending: number;
  readonly recentAdmissions: number;
  readonly recentRejections: number;
  readonly recentBudgetRejections: number;
  readonly recentConcurrencyRejections: number;
  readonly inFlightTokens?: number;
  readonly availableTokens?: number;
  readonly oldestPendingMs?: number;
  readonly lastRequestAt?: string;
};

type DemandCheckpoint = {
  readonly admitted: number;
  readonly rejected: number;
  readonly budgetRejected: number;
  readonly concurrencyRejected: number;
};

type PendingCapture = {
  readonly checkpoints: ReadonlyMap<string, DemandCheckpoint>;
  readonly lastRequestAt: ReadonlyMap<string, string>;
};

const ZERO_CHECKPOINT: DemandCheckpoint = Object.freeze({
  admitted: 0,
  rejected: 0,
  budgetRejected: 0,
  concurrencyRejected: 0,
});

function rejectionCount(
  stats: TyrPoolStats,
  reason: LLMRejectReason,
): number {
  return stats.llm.rejectedByReason[reason] ?? 0;
}

function checkpoint(stats: TyrPoolStats): DemandCheckpoint {
  return {
    admitted: stats.llm.admitted,
    rejected: stats.llm.rejected,
    budgetRejected: rejectionCount(stats, "budget_limit"),
    concurrencyRejected: rejectionCount(stats, "concurrency_limit"),
  };
}

/**
 * Returns the increase since the last accepted heartbeat. A counter reset is
 * treated as a process-local restart and reports the new value rather than a
 * negative delta.
 */
function delta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

/**
 * Converts Tyr's live pool statistics into Latchflo demand heartbeats.
 *
 * Deltas advance only after Latchflo accepts a heartbeat. A transient heartbeat
 * failure therefore cannot lose admission or rejection pressure. The next
 * attempt includes all activity since the last accepted report.
 */
export class TyrDemandReporter {
  readonly #accepted = new Map<string, DemandCheckpoint>();
  readonly #lastRequestAt = new Map<string, string>();
  #pending: PendingCapture | undefined;

  constructor(
    private readonly control: TyrControlPlane,
    private readonly pools: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    if (pools.length === 0) {
      throw new Error("at least one managed Tyr pool is required for demand reporting");
    }
    if (new Set(pools).size !== pools.length) {
      throw new Error("demand-reporting pools must not contain duplicates");
    }
  }

  capture(): readonly PoolDemandSnapshot[] {
    const observedAt = new Date(this.now()).toISOString();
    const statsByPool = this.control.stats();
    const checkpoints = new Map<string, DemandCheckpoint>();
    const nextLastRequestAt = new Map(this.#lastRequestAt);
    const snapshots: PoolDemandSnapshot[] = [];

    for (const pool of this.pools) {
      const stats = statsByPool[pool];
      if (stats === undefined) {
        throw new Error(`managed Tyr pool ${pool} is missing from local statistics`);
      }

      const current = checkpoint(stats);
      const previous = this.#accepted.get(pool) ?? ZERO_CHECKPOINT;
      const recentAdmissions = delta(current.admitted, previous.admitted);
      const recentRejections = delta(current.rejected, previous.rejected);
      const recentBudgetRejections = delta(
        current.budgetRejected,
        previous.budgetRejected,
      );
      const recentConcurrencyRejections = delta(
        current.concurrencyRejected,
        previous.concurrencyRejected,
      );

      if (recentAdmissions > 0 || recentRejections > 0) {
        nextLastRequestAt.set(pool, observedAt);
      }

      const tokenBudget = stats.tokenBudget;
      const lastRequestAt = nextLastRequestAt.get(pool);
      snapshots.push({
        pool,
        observedAt,
        inFlight: stats.bulkhead.inFlight,
        pending: stats.bulkhead.pending,
        recentAdmissions,
        recentRejections,
        recentBudgetRejections,
        recentConcurrencyRejections,
        ...(tokenBudget === undefined
          ? {}
          : {
              inFlightTokens: tokenBudget.inFlightTokens,
              availableTokens: tokenBudget.available,
            }),
        ...(lastRequestAt === undefined ? {} : { lastRequestAt }),
      });
      checkpoints.set(pool, current);
    }

    this.#pending = {
      checkpoints,
      lastRequestAt: nextLastRequestAt,
    };
    return snapshots;
  }

  /** Commits the most recently captured counters after a successful heartbeat. */
  commit(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#accepted.clear();
    for (const [pool, value] of pending.checkpoints) {
      this.#accepted.set(pool, value);
    }
    this.#lastRequestAt.clear();
    for (const [pool, value] of pending.lastRequestAt) {
      this.#lastRequestAt.set(pool, value);
    }
    this.#pending = undefined;
  }
}
