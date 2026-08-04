import type { LLMReservationEstimate, TokenUsage, UsageReport } from "async-bulkhead-llm";

export const DEFAULT_UPDATE_STEP_TOKENS = 256;
export const DEFAULT_OUTPUT_SAFETY_MARGIN_TOKENS = 256;

export type ProgressiveUsageResult = UsageReport & {
  /** Whether this report shrank the retained future-output hold. */
  applied: boolean;
  /** Tokens released back to the budget by this report (0 when coalesced). */
  releasedTokens: number;
};

export type ProgressiveUsageReconcilerOptions = {
  reservation: LLMReservationEstimate | null;
  reportUsage: (
    usage: TokenUsage,
    options?: { remainingOutputTokens: number; safetyMarginTokens?: number },
  ) => UsageReport;
  updateStepTokens: number;
  outputSafetyMarginTokens: number;
};

/**
 * async-bulkhead-llm's `reportUsage(usage, { remainingOutputTokens, safetyMarginTokens })`
 * recomputes the retained hold on every call. Streaming callers can report
 * usage many times per second; recomputing (and re-emitting a `usage`
 * event) on every chunk is wasted churn once the hold has already shrunk
 * close to its floor. This wrapper only forwards a *shrinking* reconciliation
 * once the newly computed future-output floor has dropped by at least
 * `updateStepTokens` since the last one that was actually applied — every
 * other call still reports cumulative usage but reuses the last applied
 * floor, leaving the hold unchanged.
 *
 * The retained floor is `max(outputSafetyMarginTokens, maxOutput - output)`:
 * once known-remaining output drops below the safety margin, the margin
 * itself becomes the floor until final release.
 */
export function createProgressiveUsageReconciler(
  options: ProgressiveUsageReconcilerOptions,
): { reportUsage(usage: TokenUsage): ProgressiveUsageResult } {
  const { reservation, reportUsage, updateStepTokens, outputSafetyMarginTokens } =
    options;
  let lastAppliedRemaining: number | undefined;
  let lastHeld: number | undefined = reservation?.reserved;

  return {
    reportUsage(usage: TokenUsage): ProgressiveUsageResult {
      if (reservation === null) {
        const report = reportUsage(usage);
        lastHeld = report.held;
        return { ...report, applied: false, releasedTokens: 0 };
      }

      const candidateRemaining = Math.max(
        0,
        reservation.maxOutput - usage.output - outputSafetyMarginTokens,
      );
      const applied =
        lastAppliedRemaining === undefined ||
        lastAppliedRemaining - candidateRemaining >= updateStepTokens;
      const remainingOutputTokens = applied
        ? candidateRemaining
        : lastAppliedRemaining!;

      const previousHeld = lastHeld;
      const report = reportUsage(usage, {
        remainingOutputTokens,
        safetyMarginTokens: outputSafetyMarginTokens,
      });
      lastHeld = report.held;
      if (applied) lastAppliedRemaining = candidateRemaining;

      const releasedTokens =
        applied && previousHeld !== undefined
          ? Math.max(0, previousHeld - report.held)
          : 0;

      return { ...report, applied, releasedTokens };
    },
  };
}
