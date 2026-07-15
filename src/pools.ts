import {
  createLLMBulkhead,
  type LLMPriority,
  type LLMStats,
} from "async-bulkhead-llm";

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
  /** In-flight token ceiling. Omit to disable token-aware admission. */
  budget?: number;
  /** Budget headroom reserved for priority: "high" requests. */
  highPriorityReserve?: number;
  /** Fallback output reservation when max_tokens is absent. */
  outputCap?: number;
};

export type Pool = {
  name: string;
  bulkhead: ReturnType<typeof createLLMBulkhead>;
};

export type Pools = {
  /** Longest-prefix match across all pools; undefined if no pool matches. */
  select(model: string): Pool | undefined;
  stats(): Record<string, LLMStats>;
};

export function createPools(configs: PoolConfig[]): Pools {
  if (configs.length === 0) throw new Error("at least one pool is required");

  const pools: { prefixes: string[]; pool: Pool }[] = configs.map((c) => ({
    prefixes: c.modelPrefixes,
    pool: {
      name: c.name,
      bulkhead: createLLMBulkhead({
        model: c.model,
        maxConcurrent: c.maxConcurrent,
        ...(c.budget !== undefined
          ? {
              tokenBudget: {
                budget: c.budget,
                ...(c.highPriorityReserve !== undefined
                  ? { highPriorityReserve: c.highPriorityReserve }
                  : {}),
                ...(c.outputCap !== undefined
                  ? { outputCap: c.outputCap }
                  : {}),
              },
            }
          : {}),
      }),
    },
  }));

  function select(model: string): Pool | undefined {
    let best: Pool | undefined;
    let bestLen = -1;
    for (const { prefixes, pool } of pools) {
      for (const p of prefixes) {
        if (model.startsWith(p) && p.length > bestLen) {
          best = pool;
          bestLen = p.length;
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

  return { select, stats };
}

export function parsePriority(header: string | undefined): LLMPriority {
  return header === "high" ? "high" : "normal";
}
