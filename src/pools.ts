import { randomUUID } from "node:crypto";
import {
  createAdaptiveTokenEstimator,
  createLLMBulkhead,
  LLMBulkheadRejectedError,
  type AdaptiveModelCorrection,
  type LLMDrainResult,
  type LLMPriority,
  type LLMRejectReason,
  type LLMRequest,
  type LLMReservationEstimate,
  type LLMStats,
  type LLMWouldAdmitResult,
  type TokenUsage,
} from "async-bulkhead-llm";
import {
  admissionEstimatorOptions,
  createAdmissionTokenEstimator,
} from "./admission.js";

export type AdmissionMode = "enforce" | "observe";

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

export type PoolConfig = {
  /** Pool name for stats and logs. */
  name: string;
  /** Model-string prefixes routed to this pool; longest match wins. */
  modelPrefixes: string[];
  /** Default model for estimator ratio lookup. */
  model: string;
  maxConcurrent: number;
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
};

export type AdmissionPreparation = {
  mode: AdmissionMode;
  reservation: LLMReservationEstimate | null;
  advisory: LLMWouldAdmitResult;
};

export type AdmissionRunContext = {
  readonly admissionId: string;
  readonly reservation: LLMReservationEstimate | null;
  reportUsage(usage: TokenUsage): void;
};

type AdvisoryStats = {
  checked: number;
  wouldAdmit: number;
  wouldReject: number;
  rejectedByReason: Partial<Record<LLMRejectReason, number>>;
};

type ObserveStats = {
  bypassed: number;
  raceBypassed: number;
  usageReported: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};

export type TyrPoolStats = LLMStats & {
  tyr: {
    admissionMode: AdmissionMode;
    advisory: AdvisoryStats;
    observe: ObserveStats;
    adaptiveEstimation: {
      enabled: boolean;
      corrections: AdaptiveModelCorrection[];
    };
  };
};

export type Pool = {
  name: string;
  mode: AdmissionMode;
  /** Exposed for coordinator integrations and compatibility. */
  bulkhead: ReturnType<typeof createLLMBulkhead>;
  prepare(request: LLMRequest, priority: LLMPriority): AdmissionPreparation;
  run<T>(
    request: LLMRequest,
    preparation: AdmissionPreparation,
    fn: (signal?: AbortSignal, ctx?: AdmissionRunContext) => Promise<T>,
    opts: {
      priority: LLMPriority;
      signal?: AbortSignal;
      getUsage?: (result: T) => TokenUsage | undefined;
    },
  ): Promise<T>;
  stats(): TyrPoolStats;
  close(): void;
  drain(timeoutMs?: number): Promise<LLMDrainResult>;
};

export type PoolsDrainResult = LLMDrainResult & {
  pools: Record<string, LLMDrainResult>;
};

export type Pools = {
  /** Longest-prefix match across all pools; undefined if no pool matches. */
  select(model: string): Pool | undefined;
  stats(): Record<string, TyrPoolStats>;
  close(): void;
  /** Stops admission and waits for in-flight work, optionally with a bound. */
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
    assertInteger(config.maxConcurrent, `${base}.maxConcurrent`, { min: 1 });

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

    const adaptive = config.adaptiveEstimation;
    if (
      config.budget === undefined &&
      adaptive !== undefined &&
      (adaptive.enabled ?? true)
    ) {
      throw new Error(
        `${base}.adaptiveEstimation requires ${base}.budget`,
      );
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
  });
}

function noteReason(
  target: Partial<Record<LLMRejectReason, number>>,
  reason: LLMRejectReason,
): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

function isShadowable(reason: LLMRejectReason | undefined): boolean {
  return (
    reason === "budget_limit" ||
    reason === "concurrency_limit" ||
    reason === "queue_limit" ||
    reason === "timeout"
  );
}

function createPool(config: PoolConfig): Pool {
  const mode = config.admissionMode ?? "enforce";
  const adaptiveEnabled =
    config.budget !== undefined && (config.adaptiveEstimation?.enabled ?? true);

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
  });

  if (adaptive !== undefined) {
    bulkhead.on("release", (event) => {
      if (event.usage !== undefined) adaptive.observe(event.request, event.usage);
    });
  }

  const advisory: AdvisoryStats = {
    checked: 0,
    wouldAdmit: 0,
    wouldReject: 0,
    rejectedByReason: {},
  };
  const observe: ObserveStats = {
    bypassed: 0,
    raceBypassed: 0,
    usageReported: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  function prepare(request: LLMRequest, priority: LLMPriority): AdmissionPreparation {
    const reservation = bulkhead.estimate(request);
    const decision = bulkhead.wouldAdmit(request, {
      priority,
      ...(reservation !== null ? { reservation } : {}),
      detail: true,
    });

    advisory.checked += 1;
    if (decision.admit) advisory.wouldAdmit += 1;
    else {
      advisory.wouldReject += 1;
      if (decision.reason !== undefined) noteReason(advisory.rejectedByReason, decision.reason);
    }

    return { mode, reservation, advisory: decision };
  }

  function observeBypassUsage(request: LLMRequest, usage: TokenUsage): void {
    observe.usageReported += 1;
    observe.totalInputTokens += usage.input;
    observe.totalOutputTokens += usage.output;
    adaptive?.observe(request, usage);
  }

  async function runBypass<T>(
    request: LLMRequest,
    preparation: AdmissionPreparation,
    fn: (signal?: AbortSignal, ctx?: AdmissionRunContext) => Promise<T>,
    opts: {
      signal?: AbortSignal;
      getUsage?: (result: T) => TokenUsage | undefined;
    },
  ): Promise<T> {
    observe.bypassed += 1;
    let latestUsage: TokenUsage | undefined;
    const context: AdmissionRunContext = {
      admissionId: `shadow-${randomUUID()}`,
      reservation: preparation.reservation,
      reportUsage(usage) {
        latestUsage = usage;
      },
    };

    try {
      const result = await fn(opts.signal, context);
      const usage = opts.getUsage?.(result) ?? latestUsage;
      if (usage !== undefined) observeBypassUsage(request, usage);
      return result;
    } catch (error) {
      if (latestUsage !== undefined) observeBypassUsage(request, latestUsage);
      throw error;
    }
  }

  async function run<T>(
    request: LLMRequest,
    preparation: AdmissionPreparation,
    fn: (signal?: AbortSignal, ctx?: AdmissionRunContext) => Promise<T>,
    opts: {
      priority: LLMPriority;
      signal?: AbortSignal;
      getUsage?: (result: T) => TokenUsage | undefined;
    },
  ): Promise<T> {
    const runOptions = {
      priority: opts.priority,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(preparation.reservation !== null
        ? { reservation: preparation.reservation }
        : {}),
      ...(opts.getUsage !== undefined ? { getUsage: opts.getUsage } : {}),
    };

    const runAdmitted = () =>
      bulkhead.run(
        request,
        (signal, context) =>
          fn(
            signal,
            context === undefined
              ? undefined
              : {
                  admissionId: context.admissionId,
                  reservation: context.reservation,
                  reportUsage(usage) {
                    context.reportUsage(usage);
                  },
                },
          ),
        runOptions,
      );

    if (mode === "enforce") return runAdmitted();

    if (!preparation.advisory.admit) {
      if (!isShadowable(preparation.advisory.reason)) {
        throw new LLMBulkheadRejectedError(
          preparation.advisory.reason ?? "shutdown",
          preparation.advisory.detail,
        );
      }
      return runBypass(request, preparation, fn, opts);
    }

    try {
      return await runAdmitted();
    } catch (error) {
      if (
        error instanceof LLMBulkheadRejectedError &&
        isShadowable(error.reason)
      ) {
        observe.raceBypassed += 1;
        return runBypass(request, preparation, fn, opts);
      }
      throw error;
    }
  }

  function stats(): TyrPoolStats {
    return {
      ...bulkhead.stats(),
      tyr: {
        admissionMode: mode,
        advisory: {
          ...advisory,
          rejectedByReason: { ...advisory.rejectedByReason },
        },
        observe: { ...observe },
        adaptiveEstimation: {
          enabled: adaptive !== undefined,
          corrections: adaptive?.corrections() ?? [],
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

  return {
    name: config.name,
    mode,
    bulkhead,
    prepare,
    run,
    stats,
    close,
    drain,
  };
}

export function createPools(configs: PoolConfig[]): Pools {
  validatePoolConfigs(configs);

  const pools: { prefixes: string[]; pool: Pool }[] = configs.map((config) => ({
    prefixes: [...config.modelPrefixes],
    pool: createPool(config),
  }));

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

  function stats(): Record<string, TyrPoolStats> {
    const out: Record<string, TyrPoolStats> = {};
    for (const { pool } of pools) out[pool.name] = pool.stats();
    return out;
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

  return { select, stats, close, drain };
}

export function parsePriority(header: string | undefined): LLMPriority {
  return header === "high" ? "high" : "normal";
}
