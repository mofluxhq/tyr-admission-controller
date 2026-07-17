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
  /**
   * In-flight token ceiling. Tri-state:
   *  - omitted: token-aware admission is disabled entirely (unlimited).
   *  - 0: a legal, intentional "admit nothing" pool — every budget-gated
   *    request is rejected (429, `x-admission-reason: budget_limit`)
   *    immediately, without ever calling upstream. Useful for taking a pool
   *    out of rotation (e.g. during an incident) without deleting it from
   *    config. Requires async-bulkhead-llm >=3.3.1 — under 3.2.0 this threw
   *    at construction (`assertPositiveInteger`); 3.3.1 made 0 a valid
   *    budget that simply never admits.
   *  - N > 0: the actual in-flight token ceiling.
   */
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
  /**
   * Drains all pool bulkheads: stops admitting new requests (rejected
   * with reason "shutdown") and resolves once all in-flight work across
   * every pool has completed.
   */
  drain(): Promise<void>;
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

  async function drain(): Promise<void> {
    // async-bulkhead-llm's `drain()` alone only waits for in-flight work
    // to finish — it does NOT stop new admissions. The library's own docs
    // say to "compose as close() -> drain()" for graceful shutdown:
    // `close()` stops admitting new requests immediately (rejecting with
    // reason "shutdown"), and `drain()` then resolves once all in-flight
    // work has completed. Without the `close()` call here, a request that
    // reaches the handler during a "drain" would still be admitted
    // normally instead of getting the documented 503.
    for (const { pool } of pools) pool.bulkhead.close();
    await Promise.all(pools.map(({ pool }) => pool.bulkhead.drain()));
  }


  return { select, stats, drain };
}


export function parsePriority(header: string | undefined): LLMPriority {
  return header === "high" ? "high" : "normal";
}
