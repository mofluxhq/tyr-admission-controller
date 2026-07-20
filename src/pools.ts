import {
  createLLMBulkhead,
  type LLMPriority,
  type LLMStats,
} from "async-bulkhead-llm";
import { createAdmissionTokenEstimator } from "./admission.js";

export type PoolConfig = {
  /** Pool name for stats and logs. */
  name: string;
  /**
   * Model-string prefixes routed to this pool (longest match wins
   * across all pools). Example: ["claude-sonnet-4", "claude-haiku-4"].
   */
  modelPrefixes: string[];
  /** Default model for estimator ratio lookup. */
  model: string;
  maxConcurrent: number;
  /**
   * Admission-time in-flight token ceiling. Tri-state:
   *  - omitted: token-aware admission is disabled entirely (unlimited).
   *  - 0: a legal, intentional "admit nothing" pool — every budget-gated
   *    request is rejected (429, `x-admission-reason: budget_limit`)
   *    immediately, without ever calling upstream.
   *  - N > 0: the admission-time in-flight token ceiling. Usage overruns
   *    reported after admission may temporarily raise the live hold above
   *    this ceiling; new requests remain blocked until usage releases.
   */
  budget?: number;
  /** Budget headroom reserved for priority: "high" requests. */
  highPriorityReserve?: number;
  /** Fallback output reservation when max_tokens is absent. */
  outputCap?: number;
  /** Fixed surcharge for each opaque media/document block. Defaults to 2,048. */
  opaqueMediaInputTokens?: number;
};

export type Pool = {
  name: string;
  bulkhead: ReturnType<typeof createLLMBulkhead>;
};

export type Pools = {
  /** Longest-prefix match across all pools; undefined if no pool matches. */
  select(model: string): Pool | undefined;
  stats(): Record<string, LLMStats>;
  /**
   * Drains all pool bulkheads: stops admitting new requests (rejected
   * with reason "shutdown") and resolves once all in-flight work across
   * every pool has completed.
   */
  drain(): Promise<void>;
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

function validatePoolConfigs(configs: PoolConfig[]): void {
  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error("at least one pool is required");
  }

  const names = new Set<string>();
  const prefixes = new Map<string, string>();
  configs.forEach((config, index) => {
    const base = `pools[${index}]`;
    assertNonEmptyString(config.name, `${base}.name`);
    if (names.has(config.name)) {
      throw new Error(`duplicate pool name: ${config.name}`);
    }
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

    if (config.budget !== undefined) {
      assertInteger(config.budget, `${base}.budget`, { min: 0 });
    }
    if (config.highPriorityReserve !== undefined) {
      assertInteger(config.highPriorityReserve, `${base}.highPriorityReserve`, {
        min: 0,
      });
      if (config.budget === undefined) {
        throw new Error(`${base}.highPriorityReserve requires ${base}.budget`);
      }
      if (config.highPriorityReserve > config.budget) {
        throw new Error(`${base}.highPriorityReserve must not exceed ${base}.budget`);
      }
    }
    if (config.outputCap !== undefined) {
      assertInteger(config.outputCap, `${base}.outputCap`, { min: 0 });
    }
    if (config.opaqueMediaInputTokens !== undefined) {
      assertInteger(
        config.opaqueMediaInputTokens,
        `${base}.opaqueMediaInputTokens`,
        { min: 0 },
      );
    }
  });
}

export function createPools(configs: PoolConfig[]): Pools {
  validatePoolConfigs(configs);

  const pools: { prefixes: string[]; pool: Pool }[] = configs.map((c) => ({
    prefixes: [...c.modelPrefixes],
    pool: {
      name: c.name,
      bulkhead: createLLMBulkhead({
        model: c.model,
        maxConcurrent: c.maxConcurrent,
        ...(c.budget !== undefined
          ? {
              tokenBudget: {
                budget: c.budget,
                estimator: createAdmissionTokenEstimator(
                  c.model,
                  c.outputCap,
                  c.opaqueMediaInputTokens,
                ),
                ...(c.highPriorityReserve !== undefined
                  ? { highPriorityReserve: c.highPriorityReserve }
                  : {}),
                ...(c.outputCap !== undefined ? { outputCap: c.outputCap } : {}),
              },
            }
          : {}),
      }),
    },
  }));

  function select(model: string): Pool | undefined {
    let best: Pool | undefined;
    let bestLen = -1;
    for (const { prefixes: modelPrefixes, pool } of pools) {
      for (const prefix of modelPrefixes) {
        if (model.startsWith(prefix) && prefix.length > bestLen) {
          best = pool;
          bestLen = prefix.length;
        }
      }
    }
    return best;
  }

  function stats(): Record<string, LLMStats> {
    const out: Record<string, LLMStats> = {};
    for (const { pool } of pools) out[pool.name] = pool.bulkhead.stats();
    return out;
  }

  async function drain(): Promise<void> {
    for (const { pool } of pools) pool.bulkhead.close();
    await Promise.all(pools.map(({ pool }) => pool.bulkhead.drain()));
  }

  return { select, stats, drain };
}

export function parsePriority(header: string | undefined): LLMPriority {
  return header === "high" ? "high" : "normal";
}
