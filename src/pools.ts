import {
  createAdaptiveTokenEstimator,
  createLLMBulkhead,
  type AdaptiveModelCorrection,
  type LLMAdmissionClassLimits,
  type LLMAdmissionResources,
  type LLMBorrowedConcurrencyAbandonCause,
  type LLMAdmissionLimits,
  type LLMAdmissionMode,
  type LLMApplyLimitsResult,
  type LLMDrainResult,
  type LLMObserveStats,
  type LLMPriority,
  type LLMRejectDetail,
  type LLMRejectReason,
  type LLMRequest,
  type LLMReservationEstimate,
  type LLMRunAdmission,
  type LLMShadowableRejectReason,
  type LLMStats,
  type LLMWouldAdmitResult,
  type TokenUsage,
  type UsageReport,
} from "async-bulkhead-llm";
import {
  admissionEstimatorOptions,
  createAdmissionTokenEstimator,
} from "./admission.js";
import {
  createProgressiveUsageReconciler,
  DEFAULT_OUTPUT_SAFETY_MARGIN_TOKENS,
  DEFAULT_UPDATE_STEP_TOKENS,
} from "./progressive-reconciliation.js";
import {
  normalizeAdmissionClassesConfig,
  resolveAdmissionClass,
  llmAdmissionClassLimits,
  type BorrowedAdmissionSlotPolicy,
  type AdmissionClassesConfig,
} from "./admission-policy.js";
import type { TyrRequestIdentity } from "./identity.js";

export type AdmissionMode = LLMAdmissionMode;

/**
 * Control-plane brand names Tyr accepts on admission provenance.
 *
 * `"korrx"` is the legacy value, retained for the Latchflo rebrand transition.
 * Tyr and the control plane are deployed independently, and a provenance
 * mismatch throws out of `applyLimits` rather than returning a rejection, so
 * the agent never acks, readiness goes stale, and the expiration kill switch
 * drives capacity to zero. Accepting both values means there is no ordering
 * constraint between the two rollouts. Drop `"korrx"` only once every
 * control plane in the fleet emits `"latchflo"`.
 */
export const ADMISSION_PROVENANCE_SOURCES = ["korrx", "latchflo"] as const;

export type AdmissionProvenanceSource =
  (typeof ADMISSION_PROVENANCE_SOURCES)[number];

/** Immutable control-plane metadata attached to one applied limit revision. */
export type AdmissionProvenance = {
  readonly source: AdmissionProvenanceSource;
  readonly grantId: string;
  readonly controllerEpoch: number;
  /** Must equal the associated admission-limit revision. */
  readonly revision: number;
  readonly expiresAt: string;
};

/**
 * Exact, bounded evidence for one successful capacity-holding admission.
 *
 * The event is recorded at async-bulkhead-llm's admission linearization point,
 * before Tyr invokes the upstream callback. It deliberately contains no request
 * body, model prompt, identity, or client-supplied request identifier.
 */
export type TyrAdmissionProvenanceEvent = {
  readonly schema: "tyr.admission-provenance.v1";
  /** Tyr-local monotonic sequence; unique within this pool process lifetime. */
  readonly sequence: number;
  readonly admittedAt: string;
  readonly admissionId: string;
  readonly pool: string;
  readonly priority: LLMPriority;
  readonly admissionClass?: string;
  readonly limitRevision: number;
  readonly reservedTokens: number;
  /** Exact local slot/token borrowing attribution at admission time. */
  readonly resources: LLMAdmissionResources;
  /** Exact applied limits observed at the admission linearization point. */
  readonly limits: LLMAdmissionLimits;
  /** Exact Latchflo grant associated with limitRevision, when managed. */
  readonly grant?: AdmissionProvenance;
};

export type AdaptiveEstimationConfig = {
  /** Enabled by default for token-budgeted pools. */
  enabled?: boolean;
  /** EWMA smoothing factor in (0, 1]. Default: library default (0.2). */
  smoothing?: number;
  /** Samples required before correction is applied. Default: 5. */
  minSamples?: number;
  /** Lower correction clamp. Default: 0.5. */
  minCorrection?: number;
  /** Upper correction clamp. Default: 2. */
  maxCorrection?: number;
  /** Maximum distinct models retained. Default: 64. */
  maxModels?: number;
};

export type ProgressiveReconciliationConfig = {
  /** Enabled by default for token-budgeted pools. */
  enabled?: boolean;
  /** Minimum decrease before another hold update is applied. Default: 256. */
  updateStepTokens?: number;
  /** Future-output floor retained until final release. Default: 256. */
  outputSafetyMarginTokens?: number;
};

export type PoolAdmissionDecisionTiming = {
  readonly pool: string;
  readonly outcome: "admitted" | "rejected";
  readonly admissionClass?: string;
  /** Synchronous local decision time reported by async-bulkhead-llm. */
  readonly decisionDurationNs: number;
  /** Time spent awaiting the underlying local concurrency acquire. */
  readonly queueWaitNs: number;
};

export type PoolsInstrumentation = {
  /** Called synchronously for instrumented enforce-mode admission decisions. */
  readonly onAdmissionDecisionTiming?: (event: PoolAdmissionDecisionTiming) => void;
};

export type PoolConfig = {
  /** Pool name for stats, control-plane updates, and logs. */
  name: string;
  /** Model-string prefixes routed to this pool; longest match wins. */
  modelPrefixes: string[];
  /** Default model for estimator ratio lookup. */
  model: string;
  /** Initial concurrency ceiling. Runtime updates may set this to 0. */
  maxConcurrent: number;
  /** Initial queue ceiling. Default: 0 (fail fast). */
  maxQueue?: number;
  /** Queue wait timeout in milliseconds. Construction-time behavior. */
  queueTimeoutMs?: number;
  /** Initial version for the complete admission-limit snapshot. Default: 0. */
  initialRevision?: number;
  /**
   * Admission-time in-flight token ceiling. Omit to disable token-aware
   * admission, use 0 to admit no budget-gated work, or set a positive ceiling.
   */
  budget?: number;
  /** Budget headroom reserved for priority: "high" requests. */
  highPriorityReserve?: number;
  /** Fallback output reservation when max_tokens is absent. */
  outputCap?: number;
  /** Fixed surcharge for each opaque media/document block. Defaults to 2,048. */
  opaqueMediaInputTokens?: number;
  /** Enforce rejections or only observe what would have been rejected. */
  admissionMode?: AdmissionMode;
  /** Per-model adaptive input-estimation calibration. */
  adaptiveEstimation?: AdaptiveEstimationConfig;
  /** Streaming future-work token release powered by async-bulkhead-llm. */
  progressiveReconciliation?: ProgressiveReconciliationConfig;
  /** Bounded identity-aware capacity classes within this physical pool. */
  admissionClasses?: AdmissionClassesConfig;
};

export type AdmissionPreparation = {
  mode: AdmissionMode;
  /** Limit snapshot used for the advisory preview. */
  limits: LLMAdmissionLimits;
  /** Exact revision captured by the advisory capacity decision. */
  limitRevision: number;
  reservation: LLMReservationEstimate | null;
  /** Bounded policy class selected for this request, when configured. */
  admissionClass?: string;
  advisory: LLMWouldAdmitResult;
};

export type AdmissionRunContext = {
  readonly admissionId: string;
  readonly reservation: LLMReservationEstimate | null;
  /** Exact local slot/token borrowing attribution for this admission. */
  readonly resources: LLMAdmissionResources;
  /** Present only when this callback holds a deadline-governed borrowed slot. */
  readonly borrowedAdmissionSlot?: BorrowedAdmissionSlotPolicy;
  /** Whether this callback holds capacity or is a native observe bypass. */
  readonly admission: LLMRunAdmission;
  /** Limit revision in effect when the callback began. */
  readonly limitRevision: number;
  readonly admissionClass?: string;
  /** Exact external grant associated with `limitRevision`, when managed by Latchflo. */
  readonly provenance?: AdmissionProvenance;
  readonly bypassReason?: LLMShadowableRejectReason;
  readonly bypassDetail?: LLMRejectDetail;
  reportUsage(usage: TokenUsage): UsageReport;
};

type AdvisoryStats = {
  checked: number;
  wouldAdmit: number;
  wouldReject: number;
  rejectedByReason: Partial<Record<LLMRejectReason, number>>;
};

export type TyrPoolStats = LLMStats & {
  tyr: {
    admissionMode: AdmissionMode;
    advisory: AdvisoryStats;
    /** Native async-bulkhead-llm v3.11 observe-mode statistics. */
    observe: LLMObserveStats;
    adaptiveEstimation: {
      enabled: boolean;
      corrections: AdaptiveModelCorrection[];
    };
    progressiveReconciliation: {
      enabled: boolean;
      updateStepTokens: number;
      outputSafetyMarginTokens: number;
      reports: number;
      updates: number;
      coalesced: number;
      earlyReleasedTokens: number;
    };
    provenance: {
      retainedRevisions: number;
      current?: AdmissionProvenance;
    };
    admissionProvenance: {
      /** Fixed per-pool ring capacity. */
      capacity: number;
      retained: number;
      dropped: number;
      /** Admission events not published because an internal revision invariant failed. */
      captureFailures: number;
      /** Sequence that will be assigned to the next successful admission. */
      nextSequence: number;
      events: TyrAdmissionProvenanceEvent[];
    };
    restoration: {
      admissionSlots: {
        releaseMechanism: "deadline_abandonment";
        enforceability: "enforced";
        configuredDeadlinesMs: Readonly<Record<string, number>>;
        /** Local slots returned early, whichever cause returned them. */
        released: number;
        /**
         * Split by cause. Only `deadline` reflects an expired lease, so a
         * rising `deadline` share means the configured lease is too tight.
         * Tyr never abandons manually, so `manual` stays absent unless an
         * embedder calls `abandonBorrowedConcurrency()` itself.
         */
        releasedByCause: Readonly<
          Partial<Record<LLMBorrowedConcurrencyAbandonCause, number>>
        >;
      };
      upstreamCapacity: {
        releaseMechanism: "abort_signal";
        enforceability: "unverified";
        cancellationRequested: number;
        activeAccountingHolds: number;
      };
    };
  };
};

/** Narrow control-plane surface; the underlying bulkhead is intentionally hidden. */
export type PoolController = {
  limits(): LLMAdmissionLimits;
  provenance(revision: number): AdmissionProvenance | undefined;
  applyLimits(
    next: LLMAdmissionLimits,
    provenance?: AdmissionProvenance,
  ): LLMApplyLimitsResult;
};

export type Pool = {
  name: string;
  mode: AdmissionMode;
  controller: PoolController;
  /** Exact immutable reservation preview used by capacity-aware routing. */
  estimate(request: LLMRequest): LLMReservationEstimate | null;
  resolveAdmissionClass(identity?: TyrRequestIdentity): string | undefined;
  prepare(
    request: LLMRequest,
    priority: LLMPriority,
    admissionClass?: string,
  ): AdmissionPreparation;
  run<T>(
    request: LLMRequest,
    preparation: AdmissionPreparation,
    fn: (signal?: AbortSignal, ctx?: AdmissionRunContext) => Promise<T>,
    opts: {
      priority: LLMPriority;
      admissionClass?: string;
      signal?: AbortSignal;
      getUsage?: (result: T) => TokenUsage | undefined;
    },
  ): Promise<T>;
  stats(): TyrPoolStats;
  close(): void;
  /**
   * Waits for base concurrency and final LLM token settlement. After a
   * borrowed slot deadline, an omitted timeout can remain pending until the
   * detached callback settles; pass a timeout to bound the wait.
   */
  drain(timeoutMs?: number): Promise<LLMDrainResult>;
};

export type PoolsDrainResult = LLMDrainResult & {
  pools: Record<string, LLMDrainResult>;
};

export type PoolLimitsUpdate = {
  pool: string;
  limits: LLMAdmissionLimits;
  provenance?: AdmissionProvenance;
};

export type PoolsApplyLimitsResult =
  | {
      applied: true;
      pools: Record<
        string,
        {
          previous: LLMAdmissionLimits;
          current: LLMAdmissionLimits;
          provenance?: AdmissionProvenance;
        }
      >;
    }
  | {
      applied: false;
      reason: "unknown_pool" | "duplicate_pool" | "stale_revision";
      pool: string;
      current?: LLMAdmissionLimits;
    };

export type Pools = {
  /** Longest-prefix match across all pools; undefined if no pool matches. */
  select(model: string): Pool | undefined;
  /** Exact pool-name lookup for local control-plane integrations. */
  get(name: string): Pool | undefined;
  stats(): Record<string, TyrPoolStats>;
  limits(): Record<string, LLMAdmissionLimits>;
  /**
   * Applies one or more complete snapshots as one Tyr-local transaction.
   * Every update is validated and checked for staleness before any pool mutates.
   */
  applyLimits(updates: readonly PoolLimitsUpdate[]): PoolsApplyLimitsResult;
  close(): void;
  /**
   * Stops admission and waits for base concurrency plus final LLM token
   * settlement, optionally with a bound.
   */
  drain(timeoutMs?: number): Promise<PoolsDrainResult>;
};

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertInteger(
  value: unknown,
  field: string,
  opts: { min: number },
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < opts.min) {
    throw new Error(`${field} must be a safe integer >= ${opts.min}`);
  }
}

function assertOptionalNumberRange(
  value: number | undefined,
  field: string,
  opts: { exclusiveMin?: number; min?: number; max?: number },
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value)) throw new Error(`${field} must be finite`);
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    throw new Error(`${field} must be > ${opts.exclusiveMin}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${field} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${field} must be <= ${opts.max}`);
  }
}

function validatePoolConfigs(configs: PoolConfig[]): void {
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error("at least one pool is required");
  }

  const names = new Set<string>();
  const prefixes = new Map<string, string>();
  configs.forEach((config, index) => {
    const base = `pools[${index}]`;
    assertNonEmptyString(config.name, `${base}.name`);
    if (names.has(config.name)) throw new Error(`duplicate pool name: ${config.name}`);
    names.add(config.name);

    assertNonEmptyString(config.model, `${base}.model`);
    // async-bulkhead-llm 3.13 allows a fail-closed zero-capacity start.
    assertInteger(config.maxConcurrent, `${base}.maxConcurrent`, { min: 0 });
    if (config.maxQueue !== undefined) {
      assertInteger(config.maxQueue, `${base}.maxQueue`, { min: 0 });
    }
    if (config.queueTimeoutMs !== undefined) {
      assertInteger(config.queueTimeoutMs, `${base}.queueTimeoutMs`, { min: 0 });
    }
    if (config.initialRevision !== undefined) {
      assertInteger(config.initialRevision, `${base}.initialRevision`, { min: 0 });
    }

    if (!Array.isArray(config.modelPrefixes) || config.modelPrefixes.length === 0) {
      throw new Error(`${base}.modelPrefixes must be a non-empty array`);
    }
    config.modelPrefixes.forEach((prefix, prefixIndex) => {
      assertNonEmptyString(prefix, `${base}.modelPrefixes[${prefixIndex}]`);
      const existing = prefixes.get(prefix);
      if (existing !== undefined) {
        throw new Error(
          `duplicate model prefix ${JSON.stringify(prefix)} in pools ${existing} and ${config.name}`,
        );
      }
      prefixes.set(prefix, config.name);
    });

    if (config.budget !== undefined) assertInteger(config.budget, `${base}.budget`, { min: 0 });
    if (config.highPriorityReserve !== undefined) {
      assertInteger(config.highPriorityReserve, `${base}.highPriorityReserve`, { min: 0 });
      if (config.budget === undefined) {
        throw new Error(`${base}.highPriorityReserve requires ${base}.budget`);
      }
      if (config.highPriorityReserve > config.budget) {
        throw new Error(`${base}.highPriorityReserve must not exceed ${base}.budget`);
      }
    }
    if (config.outputCap !== undefined) assertInteger(config.outputCap, `${base}.outputCap`, { min: 0 });
    if (config.opaqueMediaInputTokens !== undefined) {
      assertInteger(config.opaqueMediaInputTokens, `${base}.opaqueMediaInputTokens`, { min: 0 });
    }
    if (
      config.admissionMode !== undefined &&
      config.admissionMode !== "enforce" &&
      config.admissionMode !== "observe"
    ) {
      throw new Error(`${base}.admissionMode must be "enforce" or "observe"`);
    }

    const progressive = config.progressiveReconciliation;
    if (
      config.budget === undefined &&
      progressive !== undefined &&
      (progressive.enabled ?? true)
    ) {
      throw new Error(`${base}.progressiveReconciliation requires ${base}.budget`);
    }
    if (progressive !== undefined) {
      if (progressive.enabled !== undefined && typeof progressive.enabled !== "boolean") {
        throw new Error(`${base}.progressiveReconciliation.enabled must be a boolean`);
      }
      if (progressive.updateStepTokens !== undefined) {
        assertInteger(
          progressive.updateStepTokens,
          `${base}.progressiveReconciliation.updateStepTokens`,
          { min: 1 },
        );
      }
      if (progressive.outputSafetyMarginTokens !== undefined) {
        assertInteger(
          progressive.outputSafetyMarginTokens,
          `${base}.progressiveReconciliation.outputSafetyMarginTokens`,
          { min: 0 },
        );
      }
    }

    const adaptive = config.adaptiveEstimation;
    if (
      config.budget === undefined &&
      adaptive !== undefined &&
      (adaptive.enabled ?? true)
    ) {
      throw new Error(`${base}.adaptiveEstimation requires ${base}.budget`);
    }
    if (adaptive !== undefined) {
      if (adaptive.enabled !== undefined && typeof adaptive.enabled !== "boolean") {
        throw new Error(`${base}.adaptiveEstimation.enabled must be a boolean`);
      }
      assertOptionalNumberRange(adaptive.smoothing, `${base}.adaptiveEstimation.smoothing`, {
        exclusiveMin: 0,
        max: 1,
      });
      if (adaptive.minSamples !== undefined) {
        assertInteger(adaptive.minSamples, `${base}.adaptiveEstimation.minSamples`, { min: 1 });
      }
      assertOptionalNumberRange(
        adaptive.minCorrection,
        `${base}.adaptiveEstimation.minCorrection`,
        { exclusiveMin: 0 },
      );
      assertOptionalNumberRange(
        adaptive.maxCorrection,
        `${base}.adaptiveEstimation.maxCorrection`,
        { exclusiveMin: 0 },
      );
      if (
        adaptive.minCorrection !== undefined &&
        adaptive.maxCorrection !== undefined &&
        adaptive.maxCorrection < adaptive.minCorrection
      ) {
        throw new Error(
          `${base}.adaptiveEstimation.maxCorrection must be >= ${base}.adaptiveEstimation.minCorrection`,
        );
      }
      if (adaptive.maxModels !== undefined) {
        assertInteger(adaptive.maxModels, `${base}.adaptiveEstimation.maxModels`, { min: 1 });
      }
    }

    if (config.admissionClasses !== undefined) {
      normalizeAdmissionClassesConfig(
        config.admissionClasses,
        `${base}.admissionClasses`,
        config.budget !== undefined,
      );
    }
  });
}

function noteReason(
  target: Partial<Record<LLMRejectReason, number>>,
  reason: LLMRejectReason,
): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function zeroObserveStats(): LLMObserveStats {
  return {
    bypassed: 0,
    raceBypassed: 0,
    bypassedByReason: {},
    usageReported: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

const MAX_RETAINED_PROVENANCE_REVISIONS = 64;
/**
 * Enough to cover the current deterministic MoFlux benchmark sweeps while
 * remaining bounded for long-lived gateways. Exact grant/revision evidence is
 * intentionally exposed only through /stats, never as Prometheus labels.
 */
export const MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS = 512;

function validateAdmissionProvenance(
  poolName: string,
  limitRevision: number,
  value: AdmissionProvenance | undefined,
): AdmissionProvenance | undefined {
  if (value === undefined) return undefined;

  // Snapshot each externally supplied field once for the same reason limit
  // snapshots are copied before application: accessor-backed objects must not
  // be able to change between preflight and commit.
  const source = value.source;
  const grantId = value.grantId;
  const controllerEpoch = value.controllerEpoch;
  const revision = value.revision;
  const expiresAt = value.expiresAt;

  if (
    !ADMISSION_PROVENANCE_SOURCES.includes(source as AdmissionProvenanceSource)
  ) {
    const accepted = ADMISSION_PROVENANCE_SOURCES.map((s) => `"${s}"`).join(
      " or ",
    );
    throw new Error(`${poolName}.provenance.source must be ${accepted}`);
  }
  assertNonEmptyString(grantId, `${poolName}.provenance.grantId`);
  assertInteger(controllerEpoch, `${poolName}.provenance.controllerEpoch`, {
    min: 1,
  });
  assertInteger(revision, `${poolName}.provenance.revision`, { min: 0 });
  if (revision !== limitRevision) {
    throw new Error(
      `${poolName}.provenance.revision must equal limits.revision`,
    );
  }
  assertNonEmptyString(expiresAt, `${poolName}.provenance.expiresAt`);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(`${poolName}.provenance.expiresAt must be a valid timestamp`);
  }

  return Object.freeze({
    source,
    grantId: grantId.trim(),
    controllerEpoch,
    revision,
    expiresAt,
  });
}

function createPool(
  config: PoolConfig,
  instrumentation: PoolsInstrumentation = {},
): Pool {
  const mode = config.admissionMode ?? "enforce";
  const adaptiveEnabled =
    config.budget !== undefined && (config.adaptiveEstimation?.enabled ?? true);
  const progressiveEnabled =
    config.budget !== undefined &&
    (config.progressiveReconciliation?.enabled ?? true);
  const progressiveUpdateStepTokens =
    config.progressiveReconciliation?.updateStepTokens ??
    DEFAULT_UPDATE_STEP_TOKENS;
  const progressiveOutputSafetyMarginTokens =
    config.progressiveReconciliation?.outputSafetyMarginTokens ??
    DEFAULT_OUTPUT_SAFETY_MARGIN_TOKENS;
  const admissionClasses =
    config.admissionClasses === undefined
      ? undefined
      : normalizeAdmissionClassesConfig(
          config.admissionClasses,
          `${config.name}.admissionClasses`,
          config.budget !== undefined,
        );

  const adaptive = adaptiveEnabled
    ? createAdaptiveTokenEstimator({
        ...admissionEstimatorOptions(
          config.model,
          config.outputCap,
          config.opaqueMediaInputTokens,
        ),
        ...(config.adaptiveEstimation?.smoothing !== undefined
          ? { smoothing: config.adaptiveEstimation.smoothing }
          : {}),
        ...(config.adaptiveEstimation?.minSamples !== undefined
          ? { minSamples: config.adaptiveEstimation.minSamples }
          : {}),
        ...(config.adaptiveEstimation?.minCorrection !== undefined
          ? { minCorrection: config.adaptiveEstimation.minCorrection }
          : {}),
        ...(config.adaptiveEstimation?.maxCorrection !== undefined
          ? { maxCorrection: config.adaptiveEstimation.maxCorrection }
          : {}),
        ...(config.adaptiveEstimation?.maxModels !== undefined
          ? { maxModels: config.adaptiveEstimation.maxModels }
          : {}),
      })
    : undefined;

  const bulkhead = createLLMBulkhead({
    model: config.model,
    maxConcurrent: config.maxConcurrent,
    ...(config.maxQueue !== undefined ? { maxQueue: config.maxQueue } : {}),
    ...(config.queueTimeoutMs !== undefined
      ? { timeoutMs: config.queueTimeoutMs }
      : {}),
    ...(config.initialRevision !== undefined
      ? { initialRevision: config.initialRevision }
      : {}),
    ...(config.budget !== undefined
      ? {
          tokenBudget: {
            budget: config.budget,
            estimator:
              adaptive?.estimator ??
              createAdmissionTokenEstimator(
                config.model,
                config.outputCap,
                config.opaqueMediaInputTokens,
              ),
            ...(config.highPriorityReserve !== undefined
              ? { highPriorityReserve: config.highPriorityReserve }
              : {}),
            ...(config.outputCap !== undefined ? { outputCap: config.outputCap } : {}),
          },
        }
      : {}),
    ...(admissionClasses === undefined
      ? {}
      : {
          admissionClasses: {
            defaultClass: admissionClasses.defaultClass,
            classes: Object.freeze(
              Object.fromEntries(
                Object.entries(admissionClasses.classes).map(([name, limits]) => [
                  name,
                  llmAdmissionClassLimits(limits),
                ]),
              ),
            ),
          },
        }),
  });
  const provenanceByRevision = new Map<number, AdmissionProvenance>();
  const admissionProvenanceEvents: TyrAdmissionProvenanceEvent[] = [];
  let admissionProvenanceDropped = 0;
  let admissionProvenanceCaptureFailures = 0;
  let admissionProvenanceNextSequence = 1;

  function recordAdmissionDecisionTiming(
    outcome: "admitted" | "rejected",
    event: {
      readonly admissionClass?: string;
      readonly decisionDurationNs?: number;
      readonly queueWaitNs?: number;
    },
  ): void {
    if (mode !== "enforce") return;
    if (
      event.decisionDurationNs === undefined ||
      event.queueWaitNs === undefined
    ) {
      return;
    }
    instrumentation.onAdmissionDecisionTiming?.({
      pool: config.name,
      outcome,
      ...(event.admissionClass === undefined
        ? {}
        : { admissionClass: event.admissionClass }),
      decisionDurationNs: event.decisionDurationNs,
      queueWaitNs: event.queueWaitNs,
    });
  }

  function retainProvenance(provenance: AdmissionProvenance): void {
    provenanceByRevision.set(provenance.revision, provenance);
    while (provenanceByRevision.size > MAX_RETAINED_PROVENANCE_REVISIONS) {
      const oldest = provenanceByRevision.keys().next().value as
        | number
        | undefined;
      if (oldest === undefined) break;
      provenanceByRevision.delete(oldest);
    }
  }

  bulkhead.on("admit", (event) => {
    recordAdmissionDecisionTiming("admitted", event);

    // async-bulkhead-llm emits this synchronously after the concurrency slot
    // and token reservation are both held, before any user callback runs. The
    // currently exposed limits therefore correspond to event.limitRevision.
    const liveLimits = bulkhead.limits();
    if (liveLimits.revision !== event.limitRevision) {
      // This would violate the upstream library's documented admission
      // linearization contract. Do not publish fabricated provenance, but make
      // the evidence loss explicit to operators and benchmark integrity gates.
      admissionProvenanceCaptureFailures += 1;
      return;
    }
    const limits = Object.freeze({
      revision: liveLimits.revision,
      maxConcurrent: liveLimits.maxConcurrent,
      maxQueue: liveLimits.maxQueue,
      ...(liveLimits.tokenBudget === undefined
        ? {}
        : {
            tokenBudget: Object.freeze({
              budget: liveLimits.tokenBudget.budget,
              highPriorityReserve: liveLimits.tokenBudget.highPriorityReserve,
            }),
          }),
      ...(liveLimits.admissionClasses === undefined
        ? {}
        : {
            admissionClasses: Object.freeze(
              Object.fromEntries(
                Object.entries(liveLimits.admissionClasses).map(([name, value]) => [
                  name,
                  Object.freeze({ ...value }),
                ]),
              ),
            ),
          }),
    }) as LLMAdmissionLimits;
    const grant = provenanceByRevision.get(event.limitRevision);
    const record: TyrAdmissionProvenanceEvent = Object.freeze({
      schema: "tyr.admission-provenance.v1",
      sequence: admissionProvenanceNextSequence,
      admittedAt: new Date().toISOString(),
      admissionId: event.admissionId,
      pool: config.name,
      priority: event.priority,
      ...(event.admissionClass === undefined
        ? {}
        : { admissionClass: event.admissionClass }),
      limitRevision: event.limitRevision,
      reservedTokens: event.reservedTokens,
      resources: event.resources,
      limits,
      ...(grant === undefined ? {} : { grant }),
    });
    admissionProvenanceNextSequence += 1;
    admissionProvenanceEvents.push(record);
    if (
      admissionProvenanceEvents.length >
      MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS
    ) {
      admissionProvenanceEvents.shift();
      admissionProvenanceDropped += 1;
    }
  });

  bulkhead.on("reject", (event) => {
    recordAdmissionDecisionTiming("rejected", event);
  });

  if (adaptive !== undefined) {
    bulkhead.on("release", (event) => {
      if (event.usage !== undefined) adaptive.observe(event.request, event.usage);
    });
    // Native v3.11 observe mode has a separate release event because bypassed
    // calls never held local capacity. They still provide valuable calibration.
    bulkhead.on("bypassRelease", (event) => {
      if (event.usage !== undefined) adaptive.observe(event.request, event.usage);
    });
  }

  const advisory: AdvisoryStats = {
    checked: 0,
    wouldAdmit: 0,
    wouldReject: 0,
    rejectedByReason: {},
  };
  const progressiveStats = {
    reports: 0,
    updates: 0,
    coalesced: 0,
    earlyReleasedTokens: 0,
  };

  function prepare(
    request: LLMRequest,
    priority: LLMPriority,
    admissionClass?: string,
  ): AdmissionPreparation {
    const effectiveAdmissionClass =
      admissionClass ?? admissionClasses?.defaultClass;
    const reservation = bulkhead.estimate(request);
    const decision = bulkhead.wouldAdmit(request, {
      priority,
      ...(effectiveAdmissionClass === undefined
        ? {}
        : { admissionClass: effectiveAdmissionClass }),
      ...(reservation !== null ? { reservation } : {}),
      detail: true,
    });
    const limits = bulkhead.limits();
    const limitRevision = decision.detail?.limitRevision ?? limits.revision;

    advisory.checked += 1;
    if (decision.admit) advisory.wouldAdmit += 1;
    else {
      advisory.wouldReject += 1;
      if (decision.reason !== undefined) noteReason(advisory.rejectedByReason, decision.reason);
    }

    return {
      mode,
      limits,
      limitRevision,
      reservation,
      ...(effectiveAdmissionClass === undefined
        ? {}
        : { admissionClass: effectiveAdmissionClass }),
      advisory: decision,
    };
  }

  async function run<T>(
    request: LLMRequest,
    preparation: AdmissionPreparation,
    fn: (signal?: AbortSignal, ctx?: AdmissionRunContext) => Promise<T>,
    opts: {
      priority: LLMPriority;
      admissionClass?: string;
      signal?: AbortSignal;
      getUsage?: (result: T) => TokenUsage | undefined;
    },
  ): Promise<T> {
    const effectiveAdmissionClass =
      opts.admissionClass ?? preparation.admissionClass;
    if (effectiveAdmissionClass !== preparation.admissionClass) {
      throw new Error(
        `${config.name} admission class changed between prepare() and run()`,
      );
    }
    const borrowedAdmissionSlot =
      effectiveAdmissionClass === undefined
        ? undefined
        : admissionClasses?.classes[effectiveAdmissionClass]
            ?.borrowedAdmissionSlot;
    return bulkhead.run(
      request,
      (signal, context) => {
        if (context === undefined) return fn(signal);
        const provenance = provenanceByRevision.get(context.limitRevision);
        const reconciler =
          progressiveEnabled && context.admission === "admitted"
            ? createProgressiveUsageReconciler({
                reservation: context.reservation,
                reportUsage: (usage, options) =>
                  context.reportUsage(usage, options),
                updateStepTokens: progressiveUpdateStepTokens,
                outputSafetyMarginTokens:
                  progressiveOutputSafetyMarginTokens,
              })
            : undefined;
        return fn(signal, {
          admissionId: context.admissionId,
          reservation: context.reservation,
          resources: context.resources,
          admission: context.admission,
          limitRevision: context.limitRevision,
          ...(context.admissionClass === undefined
            ? {}
            : { admissionClass: context.admissionClass }),
          ...(provenance !== undefined ? { provenance } : {}),
          ...(context.resources.borrowedConcurrency &&
          borrowedAdmissionSlot !== undefined
            ? { borrowedAdmissionSlot }
            : {}),
          ...(context.bypassReason !== undefined
            ? { bypassReason: context.bypassReason }
            : {}),
          ...(context.bypassDetail !== undefined
            ? { bypassDetail: context.bypassDetail }
            : {}),
          reportUsage(usage) {
            if (reconciler === undefined) return context.reportUsage(usage);
            progressiveStats.reports += 1;
            const report = reconciler.reportUsage(usage);
            if (report.applied) progressiveStats.updates += 1;
            else progressiveStats.coalesced += 1;
            progressiveStats.earlyReleasedTokens += report.releasedTokens;
            return report;
          },
        });
      },
      {
        mode,
        priority: opts.priority,
        ...(effectiveAdmissionClass === undefined
          ? {}
          : { admissionClass: effectiveAdmissionClass }),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(preparation.reservation !== null
          ? { reservation: preparation.reservation }
          : {}),
        ...(opts.getUsage !== undefined ? { getUsage: opts.getUsage } : {}),
        ...(borrowedAdmissionSlot === undefined
          ? {}
          : {
              borrowedConcurrencyDeadlineMs:
                borrowedAdmissionSlot.deadlineMs,
            }),
      },
    );
  }

  function stats(): TyrPoolStats {
    const snapshot = bulkhead.stats();
    const currentProvenance = provenanceByRevision.get(
      snapshot.limits.revision,
    );
    return {
      ...snapshot,
      tyr: {
        admissionMode: mode,
        advisory: {
          ...advisory,
          rejectedByReason: { ...advisory.rejectedByReason },
        },
        observe: snapshot.observe
          ? {
              ...snapshot.observe,
              bypassedByReason: { ...snapshot.observe.bypassedByReason },
            }
          : zeroObserveStats(),
        adaptiveEstimation: {
          enabled: adaptive !== undefined,
          corrections: adaptive?.corrections() ?? [],
        },
        progressiveReconciliation: {
          enabled: progressiveEnabled,
          updateStepTokens: progressiveUpdateStepTokens,
          outputSafetyMarginTokens:
            progressiveOutputSafetyMarginTokens,
          ...progressiveStats,
        },
        provenance: {
          retainedRevisions: provenanceByRevision.size,
          ...(currentProvenance !== undefined
            ? { current: currentProvenance }
            : {}),
        },
        admissionProvenance: {
          capacity: MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS,
          retained: admissionProvenanceEvents.length,
          dropped: admissionProvenanceDropped,
          captureFailures: admissionProvenanceCaptureFailures,
          nextSequence: admissionProvenanceNextSequence,
          events: admissionProvenanceEvents.map((event) => ({ ...event })),
        },
        restoration: {
          admissionSlots: {
            releaseMechanism: "deadline_abandonment",
            enforceability: "enforced",
            configuredDeadlinesMs: Object.freeze(
              Object.fromEntries(
                Object.entries(admissionClasses?.classes ?? {}).flatMap(
                  ([name, limits]) =>
                    limits.borrowedAdmissionSlot === undefined
                      ? []
                      : [[name, limits.borrowedAdmissionSlot.deadlineMs]],
                ),
              ),
            ),
            released: snapshot.llm.borrowedConcurrencyAbandoned,
            releasedByCause: Object.freeze({
              ...snapshot.llm.borrowedConcurrencyAbandonedByCause,
            }),
          },
          upstreamCapacity: {
            releaseMechanism: "abort_signal",
            enforceability: "unverified",
            // Only deadline expiry aborts the callback signal. A manual
            // abandonment returns the local slot without asking upstream to
            // stop, so it must not be counted as a cancellation request.
            cancellationRequested:
              snapshot.llm.borrowedConcurrencyAbandonedByCause.deadline ?? 0,
            activeAccountingHolds: Math.max(
              0,
              snapshot.llm.inFlight - snapshot.bulkhead.inFlight,
            ),
          },
        },
      },
    };
  }

  function close(): void {
    bulkhead.close();
  }

  async function drain(timeoutMs?: number): Promise<LLMDrainResult> {
    if (timeoutMs === undefined) {
      await bulkhead.drain();
      return { drained: true, inFlight: 0, pending: 0 };
    }
    return bulkhead.drain({ timeoutMs });
  }

  const controller: PoolController = {
    limits: () => bulkhead.limits(),
    provenance: (revision) => provenanceByRevision.get(revision),
    applyLimits: (next, provenance) => {
      const normalized = validateAdmissionProvenance(
        config.name,
        next.revision,
        provenance,
      );
      const result = bulkhead.applyLimits(next);
      if (result.applied && normalized !== undefined) {
        retainProvenance(normalized);
      }
      return result;
    },
  };

  return {
    name: config.name,
    mode,
    controller,
    estimate: (request) => bulkhead.estimate(request),
    resolveAdmissionClass: (identity) =>
      resolveAdmissionClass(admissionClasses, identity),
    prepare,
    run,
    stats,
    close,
    drain,
  };
}

function validateLimitSnapshot(
  poolName: string,
  current: LLMAdmissionLimits,
  next: LLMAdmissionLimits,
): LLMAdmissionLimits {
  // Snapshot each externally supplied property exactly once. Besides producing
  // a plain immutable payload for the underlying bulkhead, this prevents
  // accessor objects from returning different values during Tyr's preflight
  // and the later synchronous application phase.
  const revision = next.revision;
  const maxConcurrent = next.maxConcurrent;
  const maxQueue = next.maxQueue;
  const suppliedTokenBudget = next.tokenBudget;
  const suppliedAdmissionClasses = next.admissionClasses;

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`${poolName}.limits.revision must be a non-negative safe integer`);
  }
  assertInteger(maxConcurrent, `${poolName}.limits.maxConcurrent`, { min: 0 });
  assertInteger(maxQueue, `${poolName}.limits.maxQueue`, { min: 0 });

  let tokenBudget: LLMAdmissionLimits["tokenBudget"];
  if (current.tokenBudget !== undefined) {
    if (suppliedTokenBudget === undefined) {
      throw new Error(`${poolName}.limits.tokenBudget is required`);
    }
    const budget = suppliedTokenBudget.budget;
    const highPriorityReserve = suppliedTokenBudget.highPriorityReserve;
    assertInteger(budget, `${poolName}.limits.tokenBudget.budget`, { min: 0 });
    assertInteger(
      highPriorityReserve,
      `${poolName}.limits.tokenBudget.highPriorityReserve`,
      { min: 0 },
    );
    if (highPriorityReserve > budget) {
      throw new Error(
        `${poolName}.limits.tokenBudget.highPriorityReserve must not exceed budget`,
      );
    }
    tokenBudget = Object.freeze({ budget, highPriorityReserve });
  } else if (suppliedTokenBudget !== undefined) {
    throw new Error(`${poolName}.limits.tokenBudget must be omitted`);
  }

  let admissionClasses: Readonly<Record<string, LLMAdmissionClassLimits>> | undefined;
  if (current.admissionClasses !== undefined) {
    if (suppliedAdmissionClasses === undefined) {
      throw new Error(`${poolName}.limits.admissionClasses is required`);
    }
    const currentKeys = Object.keys(current.admissionClasses).sort();
    const suppliedKeys = Object.keys(suppliedAdmissionClasses).sort();
    if (
      currentKeys.length !== suppliedKeys.length ||
      currentKeys.some((key, index) => key !== suppliedKeys[index])
    ) {
      throw new Error(
        `${poolName}.limits.admissionClasses must preserve the configured class keys`,
      );
    }
    const normalized: Record<string, LLMAdmissionClassLimits> = {};
    let protectedConcurrentTotal = 0;
    let protectedInFlightTokensTotal = 0;
    for (const key of currentKeys) {
      const value = suppliedAdmissionClasses[key];
      const classField = `${poolName}.limits.admissionClasses[${JSON.stringify(key)}]`;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${classField} must be an object`);
      }
      for (const property of Object.keys(value)) {
        if (
          property !== "protectedConcurrent" &&
          property !== "maxConcurrent" &&
          property !== "protectedInFlightTokens" &&
          property !== "maxInFlightTokens"
        ) {
          throw new Error(
            `${classField} contains unknown property ${JSON.stringify(property)}`,
          );
        }
      }
      const protectedConcurrent = value.protectedConcurrent;
      const classMaxConcurrent = value.maxConcurrent;
      const protectedInFlightTokens = value.protectedInFlightTokens;
      const classMaxInFlightTokens = value.maxInFlightTokens;
      for (const [property, candidate] of [
        ["protectedConcurrent", protectedConcurrent],
        ["maxConcurrent", classMaxConcurrent],
        ["protectedInFlightTokens", protectedInFlightTokens],
        ["maxInFlightTokens", classMaxInFlightTokens],
      ] as const) {
        if (candidate !== undefined) {
          assertInteger(candidate, `${classField}.${property}`, { min: 0 });
        }
      }
      if (
        protectedConcurrent !== undefined &&
        classMaxConcurrent !== undefined &&
        protectedConcurrent > classMaxConcurrent
      ) {
        throw new Error(
          `${classField}.protectedConcurrent must not exceed ${classField}.maxConcurrent`,
        );
      }
      if (
        protectedInFlightTokens !== undefined &&
        classMaxInFlightTokens !== undefined &&
        protectedInFlightTokens > classMaxInFlightTokens
      ) {
        throw new Error(
          `${classField}.protectedInFlightTokens must not exceed ${classField}.maxInFlightTokens`,
        );
      }
      if (protectedInFlightTokens !== undefined && tokenBudget === undefined) {
        throw new Error(
          `${classField}.protectedInFlightTokens requires tokenBudget`,
        );
      }
      if (classMaxInFlightTokens !== undefined && tokenBudget === undefined) {
        throw new Error(`${classField}.maxInFlightTokens requires tokenBudget`);
      }
      protectedConcurrentTotal += protectedConcurrent ?? 0;
      protectedInFlightTokensTotal += protectedInFlightTokens ?? 0;
      normalized[key] = Object.freeze({
        ...(protectedConcurrent === undefined ? {} : { protectedConcurrent }),
        ...(classMaxConcurrent === undefined
          ? {}
          : { maxConcurrent: classMaxConcurrent }),
        ...(protectedInFlightTokens === undefined
          ? {}
          : { protectedInFlightTokens }),
        ...(classMaxInFlightTokens === undefined
          ? {}
          : { maxInFlightTokens: classMaxInFlightTokens }),
      });
    }
    if (protectedConcurrentTotal > maxConcurrent) {
      throw new Error(
        `${poolName}.limits.admissionClasses protectedConcurrent sum must not exceed maxConcurrent`,
      );
    }
    if (
      tokenBudget !== undefined &&
      protectedInFlightTokensTotal > tokenBudget.budget
    ) {
      throw new Error(
        `${poolName}.limits.admissionClasses protectedInFlightTokens sum must not exceed tokenBudget.budget`,
      );
    }
    admissionClasses = Object.freeze(normalized);
  } else if (suppliedAdmissionClasses !== undefined) {
    throw new Error(`${poolName}.limits.admissionClasses must be omitted`);
  }

  return Object.freeze({
    revision,
    maxConcurrent,
    maxQueue,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(admissionClasses === undefined ? {} : { admissionClasses }),
  });
}

export function createPools(
  configs: PoolConfig[],
  instrumentation: PoolsInstrumentation = {},
): Pools {
  validatePoolConfigs(configs);

  const pools: { prefixes: string[]; pool: Pool }[] = configs.map((config) => ({
    prefixes: [...config.modelPrefixes],
    pool: createPool(config, instrumentation),
  }));
  const poolsByName = new Map(pools.map(({ pool }) => [pool.name, pool]));

  function select(model: string): Pool | undefined {
    let best: Pool | undefined;
    let bestLen = -1;
    for (const { prefixes, pool } of pools) {
      for (const prefix of prefixes) {
        if (model.startsWith(prefix) && prefix.length > bestLen) {
          best = pool;
          bestLen = prefix.length;
        }
      }
    }
    return best;
  }

  function get(name: string): Pool | undefined {
    return poolsByName.get(name);
  }

  function stats(): Record<string, TyrPoolStats> {
    const out: Record<string, TyrPoolStats> = {};
    for (const { pool } of pools) out[pool.name] = pool.stats();
    return out;
  }

  function limits(): Record<string, LLMAdmissionLimits> {
    const out: Record<string, LLMAdmissionLimits> = {};
    for (const { pool } of pools) out[pool.name] = pool.controller.limits();
    return out;
  }

  function applyLimits(
    updates: readonly PoolLimitsUpdate[],
  ): PoolsApplyLimitsResult {
    const seen = new Set<string>();
    const resolved: Array<{
      pool: Pool;
      current: LLMAdmissionLimits;
      next: LLMAdmissionLimits;
      provenance?: AdmissionProvenance;
    }> = [];

    for (const update of updates) {
      if (seen.has(update.pool)) {
        return { applied: false, reason: "duplicate_pool", pool: update.pool };
      }
      seen.add(update.pool);

      const pool = poolsByName.get(update.pool);
      if (pool === undefined) {
        return { applied: false, reason: "unknown_pool", pool: update.pool };
      }
      const current = pool.controller.limits();
      const next = validateLimitSnapshot(update.pool, current, update.limits);
      const provenance = validateAdmissionProvenance(
        update.pool,
        next.revision,
        update.provenance,
      );
      if (next.revision <= current.revision) {
        return {
          applied: false,
          reason: "stale_revision",
          pool: update.pool,
          current,
        };
      }
      resolved.push({
        pool,
        current,
        next,
        ...(provenance !== undefined ? { provenance } : {}),
      });
    }

    const applied: Record<
      string,
      {
        previous: LLMAdmissionLimits;
        current: LLMAdmissionLimits;
        provenance?: AdmissionProvenance;
      }
    > = {};
    for (const item of resolved) {
      const result = item.pool.controller.applyLimits(
        item.next,
        item.provenance,
      );
      if (!result.applied) {
        // The preflight and application execute synchronously on the same event
        // loop turn, so this would indicate an internal invariant violation.
        throw new Error(
          `pool ${item.pool.name} became stale during atomic limit application`,
        );
      }
      applied[item.pool.name] = {
        previous: result.previous,
        current: result.current,
        ...(item.provenance !== undefined
          ? { provenance: item.provenance }
          : {}),
      };
    }
    return { applied: true, pools: applied };
  }

  function close(): void {
    for (const { pool } of pools) pool.close();
  }

  async function drain(timeoutMs?: number): Promise<PoolsDrainResult> {
    close();
    const results = await Promise.all(
      pools.map(async ({ pool }) => [pool.name, await pool.drain(timeoutMs)] as const),
    );
    const byPool = Object.fromEntries(results);
    return {
      drained: results.every(([, result]) => result.drained),
      inFlight: results.reduce((total, [, result]) => total + result.inFlight, 0),
      pending: results.reduce((total, [, result]) => total + result.pending, 0),
      pools: byPool,
    };
  }

  return { select, get, stats, limits, applyLimits, close, drain };
}

export function parsePriority(header: string | undefined): LLMPriority {
  return header === "high" ? "high" : "normal";
}
