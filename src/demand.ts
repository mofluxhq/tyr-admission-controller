import type { LLMAdmissionClassStats, LLMRejectReason } from "async-bulkhead-llm";
import type { TyrPoolStats } from "./pools.js";
import type { TyrControlPlane } from "./server.js";

/**
 * Bounded demand for one configured admission class.
 *
 * Class IDs come only from Tyr's fixed, validated admission-class table; this
 * structure therefore cannot grow from tenant/application churn. Counter
 * fields are deltas since the last heartbeat accepted by Latchflo.
 */
export type AdmissionClassDemandSnapshot = {
  readonly admissionClass: string;
  readonly inFlight: number;
  readonly recentAdmissions: number;
  readonly recentRejections: number;
  readonly recentBudgetRejections: number;
  readonly recentConcurrencyRejections: number;
  readonly protectedConcurrent: number;
  readonly protectedConcurrentInUse: number;
  readonly borrowedConcurrent: number;
  readonly inFlightTokens?: number;
  readonly protectedInFlightTokens?: number;
  readonly protectedTokensInUse?: number;
  readonly borrowedInFlightTokens?: number;
  readonly lastRequestAt?: string;
};

/** Demand snapshot accepted by Latchflo agent heartbeats. */
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
  /**
   * Optional bounded per-class demand. Latchflo versions that predate class
   * demand can ignore this field while continuing to consume the pool-level
   * snapshot above.
   */
  readonly admissionClasses?: readonly AdmissionClassDemandSnapshot[];
};

type DemandCheckpoint = {
  readonly admitted: number;
  readonly rejected: number;
  readonly budgetRejected: number;
  readonly concurrencyRejected: number;
};

type PendingCapture = {
  readonly checkpoints: ReadonlyMap<string, DemandCheckpoint>;
  readonly classCheckpoints: ReadonlyMap<string, ReadonlyMap<string, DemandCheckpoint>>;
  readonly lastRequestAt: ReadonlyMap<string, string>;
  readonly classLastRequestAt: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

const ZERO_CHECKPOINT: DemandCheckpoint = Object.freeze({
  admitted: 0,
  rejected: 0,
  budgetRejected: 0,
  concurrencyRejected: 0,
});

function rejectionCount(
  stats: Pick<TyrPoolStats["llm"], "rejectedByReason">,
  reason: LLMRejectReason,
): number {
  return stats.rejectedByReason[reason] ?? 0;
}

function checkpoint(
  stats: Pick<TyrPoolStats["llm"], "admitted" | "rejected" | "rejectedByReason">,
): DemandCheckpoint {
  return {
    admitted: stats.admitted,
    rejected: stats.rejected,
    budgetRejected: rejectionCount(stats, "budget_limit"),
    concurrencyRejected: rejectionCount(stats, "concurrency_limit"),
  };
}

function classCheckpoint(stats: LLMAdmissionClassStats): DemandCheckpoint {
  return {
    admitted: stats.admitted,
    rejected: stats.rejected,
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

function copyNestedMap<T>(
  source: ReadonlyMap<string, ReadonlyMap<string, T>>,
): Map<string, Map<string, T>> {
  const result = new Map<string, Map<string, T>>();
  for (const [outerKey, inner] of source) {
    result.set(outerKey, new Map(inner));
  }
  return result;
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
  readonly #acceptedClasses = new Map<string, Map<string, DemandCheckpoint>>();
  readonly #lastRequestAt = new Map<string, string>();
  readonly #classLastRequestAt = new Map<string, Map<string, string>>();
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
    const classCheckpoints = copyNestedMap(this.#acceptedClasses);
    const nextLastRequestAt = new Map(this.#lastRequestAt);
    const nextClassLastRequestAt = copyNestedMap(this.#classLastRequestAt);
    const snapshots: PoolDemandSnapshot[] = [];

    for (const pool of this.pools) {
      const stats = statsByPool[pool];
      if (stats === undefined) {
        throw new Error(`managed Tyr pool ${pool} is missing from local statistics`);
      }

      const current = checkpoint(stats.llm);
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

      let admissionClasses: AdmissionClassDemandSnapshot[] | undefined;
      if (stats.admissionClasses !== undefined) {
        admissionClasses = [];
        const previousByClass = this.#acceptedClasses.get(pool) ?? new Map();
        const checkpointByClass = new Map<string, DemandCheckpoint>();
        const lastRequestByClass =
          nextClassLastRequestAt.get(pool) ?? new Map<string, string>();

        for (const admissionClass of Object.keys(stats.admissionClasses.classes).sort()) {
          const classStats = stats.admissionClasses.classes[admissionClass];
          if (classStats === undefined) continue;

          const classCurrent = classCheckpoint(classStats);
          const classPrevious = previousByClass.get(admissionClass) ?? ZERO_CHECKPOINT;
          const classRecentAdmissions = delta(
            classCurrent.admitted,
            classPrevious.admitted,
          );
          const classRecentRejections = delta(
            classCurrent.rejected,
            classPrevious.rejected,
          );
          const classRecentBudgetRejections = delta(
            classCurrent.budgetRejected,
            classPrevious.budgetRejected,
          );
          const classRecentConcurrencyRejections = delta(
            classCurrent.concurrencyRejected,
            classPrevious.concurrencyRejected,
          );

          if (classRecentAdmissions > 0 || classRecentRejections > 0) {
            lastRequestByClass.set(admissionClass, observedAt);
          }
          const classLastRequestAt = lastRequestByClass.get(admissionClass);

          admissionClasses.push({
            admissionClass,
            inFlight: classStats.inFlight,
            recentAdmissions: classRecentAdmissions,
            recentRejections: classRecentRejections,
            recentBudgetRejections: classRecentBudgetRejections,
            recentConcurrencyRejections: classRecentConcurrencyRejections,
            protectedConcurrent: classStats.limits.protectedConcurrent ?? 0,
            protectedConcurrentInUse: classStats.protectedConcurrentInUse,
            borrowedConcurrent: classStats.borrowedConcurrent,
            ...(stats.tokenBudget === undefined
              ? {}
              : {
                  inFlightTokens: classStats.inFlightTokens,
                  protectedInFlightTokens:
                    classStats.limits.protectedInFlightTokens ?? 0,
                  protectedTokensInUse: classStats.protectedTokensInUse,
                  borrowedInFlightTokens: classStats.borrowedInFlightTokens,
                }),
            ...(classLastRequestAt === undefined
              ? {}
              : { lastRequestAt: classLastRequestAt }),
          });
          checkpointByClass.set(admissionClass, classCurrent);
        }

        classCheckpoints.set(pool, checkpointByClass);
        nextClassLastRequestAt.set(pool, lastRequestByClass);
      } else {
        classCheckpoints.delete(pool);
        nextClassLastRequestAt.delete(pool);
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
        ...(admissionClasses === undefined ? {} : { admissionClasses }),
      });
      checkpoints.set(pool, current);
    }

    this.#pending = {
      checkpoints,
      classCheckpoints,
      lastRequestAt: nextLastRequestAt,
      classLastRequestAt: nextClassLastRequestAt,
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
    this.#acceptedClasses.clear();
    for (const [pool, values] of pending.classCheckpoints) {
      this.#acceptedClasses.set(pool, new Map(values));
    }
    this.#lastRequestAt.clear();
    for (const [pool, value] of pending.lastRequestAt) {
      this.#lastRequestAt.set(pool, value);
    }
    this.#classLastRequestAt.clear();
    for (const [pool, values] of pending.classLastRequestAt) {
      this.#classLastRequestAt.set(pool, new Map(values));
    }
    this.#pending = undefined;
  }
}
