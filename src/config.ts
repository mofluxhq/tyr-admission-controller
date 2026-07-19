import type { GatewayOptions } from "./server.js";

export type RuntimeConfig = {
  port: number;
  gateway: GatewayOptions;
};

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseInteger(
  raw: string,
  name: string,
  opts: { min: number; max?: number },
): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < opts.min) {
    throw new Error(`${name} must be an integer >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${name} must be an integer <= ${opts.max}`);
  }
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  opts: { min: number; max?: number },
): number {
  const raw = envString(env, name);
  return raw === undefined ? fallback : parseInteger(raw, name, opts);
}

function optionalIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  opts: { min: number; max?: number },
): number | undefined {
  const raw = envString(env, name);
  return raw === undefined ? undefined : parseInteger(raw, name, opts);
}

function booleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = envString(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const upstreamUrl = envString(env, "UPSTREAM_URL");
  const openaiUpstreamUrl = envString(env, "OPENAI_UPSTREAM_URL");
  if (!upstreamUrl && !openaiUpstreamUrl) {
    throw new Error(
      "at least one of UPSTREAM_URL or OPENAI_UPSTREAM_URL must be set",
    );
  }

  const port = integerEnv(env, "PORT", 8787, { min: 1, max: 65_535 });
  const responseTimeoutMs = optionalIntegerEnv(env, "RESPONSE_TIMEOUT_MS", {
    min: 0,
  });
  const idleTimeoutMs = optionalIntegerEnv(env, "IDLE_TIMEOUT_MS", { min: 0 });
  const clientStallTimeoutMs = optionalIntegerEnv(
    env,
    "CLIENT_STALL_TIMEOUT_MS",
    { min: 0 },
  );
  const maxRequestBodyBytes = optionalIntegerEnv(
    env,
    "MAX_REQUEST_BODY_BYTES",
    { min: 1 },
  );
  const maxOutputTokens = optionalIntegerEnv(env, "MAX_OUTPUT_TOKENS", {
    min: 0,
  });
  const maxConcurrent = integerEnv(env, "MAX_CONCURRENT", 50, { min: 1 });
  const budget = integerEnv(env, "TOKEN_BUDGET", 500_000, { min: 0 });
  const highPriorityReserve = integerEnv(env, "HIGH_PRIORITY_RESERVE", 0, {
    min: 0,
  });
  if (highPriorityReserve > budget) {
    throw new Error("HIGH_PRIORITY_RESERVE must not exceed TOKEN_BUDGET");
  }
  const trustPriorityHeader = booleanEnv(
    env,
    "TRUST_X_PRIORITY_HEADER",
    false,
  );

  return {
    port,
    gateway: {
      ...(upstreamUrl !== undefined ? { upstreamUrl } : {}),
      ...(openaiUpstreamUrl !== undefined ? { openaiUpstreamUrl } : {}),
      ...(responseTimeoutMs !== undefined ? { responseTimeoutMs } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(clientStallTimeoutMs !== undefined ? { clientStallTimeoutMs } : {}),
      ...(maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      trustPriorityHeader,
      pools: [
        {
          name: "default",
          modelPrefixes: ["claude", "gpt", "o1", "o3", "o4"],
          model: "claude-sonnet-4",
          maxConcurrent,
          budget,
          highPriorityReserve,
        },
      ],
    },
  };
}
