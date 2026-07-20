import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type { PoolConfig } from "./pools.js";
import type { GatewayOptions } from "./server.js";

export type RuntimeConfigSource =
  | { kind: "environment" }
  | {
      kind: "file";
      path: string;
      version: 1;
      fingerprint: string;
    };

export type RuntimeConfig = {
  port: number;
  gateway: GatewayOptions;
  source: RuntimeConfigSource;
};

const LEGACY_CONFIG_ENV_NAMES = [
  "UPSTREAM_URL",
  "OPENAI_UPSTREAM_URL",
  "RESPONSE_TIMEOUT_MS",
  "IDLE_TIMEOUT_MS",
  "CLIENT_STALL_TIMEOUT_MS",
  "MAX_REQUEST_BODY_BYTES",
  "MAX_OUTPUT_TOKENS",
  "PORT",
  "MAX_CONCURRENT",
  "TOKEN_BUDGET",
  "HIGH_PRIORITY_RESERVE",
  "OPAQUE_MEDIA_INPUT_TOKENS",
  "TRUST_X_PRIORITY_HEADER",
] as const;

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

function loadLegacyEnvironmentConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
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
  const opaqueMediaInputTokens = optionalIntegerEnv(
    env,
    "OPAQUE_MEDIA_INPUT_TOKENS",
    { min: 0 },
  );
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
          ...(opaqueMediaInputTokens !== undefined
            ? { opaqueMediaInputTokens }
            : {}),
        },
      ],
    },
    source: { kind: "environment" },
  };
}

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, field: string): ObjectValue {
  if (!isObject(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function optionalObjectValue(
  parent: ObjectValue,
  key: string,
  field: string,
): ObjectValue | undefined {
  const value = parent[key];
  return value === undefined ? undefined : objectValue(value, field);
}

function assertKnownKeys(
  value: ObjectValue,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${field} contains unknown property ${JSON.stringify(key)}`);
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredInteger(
  value: unknown,
  field: string,
  opts: { min: number; max?: number },
): number {
  if (!Number.isSafeInteger(value) || (value as number) < opts.min) {
    throw new Error(`${field} must be a safe integer >= ${opts.min}`);
  }
  const numberValue = value as number;
  if (opts.max !== undefined && numberValue > opts.max) {
    throw new Error(`${field} must be a safe integer <= ${opts.max}`);
  }
  return numberValue;
}

function optionalInteger(
  parent: ObjectValue,
  key: string,
  field: string,
  opts: { min: number; max?: number },
): number | undefined {
  const value = parent[key];
  return value === undefined ? undefined : requiredInteger(value, field, opts);
}

function optionalBoolean(
  parent: ObjectValue,
  key: string,
  field: string,
): boolean | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function absoluteHttpUrl(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http: or https:`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${field} must not include a query string or fragment`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function providerBaseUrl(
  upstreams: ObjectValue,
  provider: "anthropic" | "openai",
): string | undefined {
  const providerConfig = optionalObjectValue(
    upstreams,
    provider,
    `upstreams.${provider}`,
  );
  if (providerConfig === undefined) return undefined;
  assertKnownKeys(providerConfig, ["baseUrl"], `upstreams.${provider}`);
  return absoluteHttpUrl(
    providerConfig["baseUrl"],
    `upstreams.${provider}.baseUrl`,
  );
}

function normalizePool(value: unknown, index: number): PoolConfig {
  const field = `pools[${index}]`;
  const pool = objectValue(value, field);
  assertKnownKeys(
    pool,
    [
      "name",
      "modelPrefixes",
      "estimatorModel",
      "maxConcurrent",
      "inFlightTokenBudget",
      "highPriorityTokenReserve",
      "defaultOutputReservation",
      "opaqueMediaInputTokenReservation",
    ],
    field,
  );

  const name = requiredString(pool["name"], `${field}.name`);
  const estimatorModel = requiredString(
    pool["estimatorModel"],
    `${field}.estimatorModel`,
  );
  const maxConcurrent = requiredInteger(
    pool["maxConcurrent"],
    `${field}.maxConcurrent`,
    { min: 1 },
  );

  const prefixesValue = pool["modelPrefixes"];
  if (!Array.isArray(prefixesValue) || prefixesValue.length === 0) {
    throw new Error(`${field}.modelPrefixes must be a non-empty array`);
  }
  const modelPrefixes = prefixesValue.map((prefix, prefixIndex) =>
    requiredString(prefix, `${field}.modelPrefixes[${prefixIndex}]`),
  );
  if (new Set(modelPrefixes).size !== modelPrefixes.length) {
    throw new Error(`${field}.modelPrefixes must not contain duplicates`);
  }

  const budget = optionalInteger(
    pool,
    "inFlightTokenBudget",
    `${field}.inFlightTokenBudget`,
    { min: 0 },
  );
  const reserve = optionalInteger(
    pool,
    "highPriorityTokenReserve",
    `${field}.highPriorityTokenReserve`,
    { min: 0 },
  );
  const outputCap = optionalInteger(
    pool,
    "defaultOutputReservation",
    `${field}.defaultOutputReservation`,
    { min: 0 },
  );
  const opaqueMediaInputTokens = optionalInteger(
    pool,
    "opaqueMediaInputTokenReservation",
    `${field}.opaqueMediaInputTokenReservation`,
    { min: 0 },
  );

  if (reserve !== undefined && budget === undefined) {
    throw new Error(
      `${field}.highPriorityTokenReserve requires ${field}.inFlightTokenBudget`,
    );
  }
  if (reserve !== undefined && budget !== undefined && reserve > budget) {
    throw new Error(
      `${field}.highPriorityTokenReserve must not exceed ${field}.inFlightTokenBudget`,
    );
  }

  return {
    name,
    modelPrefixes,
    model: estimatorModel,
    maxConcurrent,
    ...(budget !== undefined ? { budget } : {}),
    ...(reserve !== undefined ? { highPriorityReserve: reserve } : {}),
    ...(outputCap !== undefined ? { outputCap } : {}),
    ...(opaqueMediaInputTokens !== undefined
      ? { opaqueMediaInputTokens }
      : {}),
  };
}

function normalizeFileConfiguration(
  raw: unknown,
  source: { path: string; fingerprint: string },
): RuntimeConfig {
  const root = objectValue(raw, "configuration");
  assertKnownKeys(
    root,
    ["version", "server", "upstreams", "timeouts", "priority", "pools"],
    "configuration",
  );

  const version = requiredInteger(root["version"], "version", { min: 1 });
  if (version !== 1) {
    throw new Error(
      `unsupported configuration version ${version}; this Tyr release supports version 1`,
    );
  }

  const server = optionalObjectValue(root, "server", "server") ?? {};
  assertKnownKeys(
    server,
    ["port", "maxRequestBodyBytes", "maxOutputTokens"],
    "server",
  );
  const port = optionalInteger(server, "port", "server.port", {
    min: 1,
    max: 65_535,
  }) ?? 8787;
  const maxRequestBodyBytes = optionalInteger(
    server,
    "maxRequestBodyBytes",
    "server.maxRequestBodyBytes",
    { min: 1 },
  );
  const maxOutputTokens = optionalInteger(
    server,
    "maxOutputTokens",
    "server.maxOutputTokens",
    { min: 0 },
  );

  const upstreams = objectValue(root["upstreams"], "upstreams");
  assertKnownKeys(upstreams, ["anthropic", "openai"], "upstreams");
  const upstreamUrl = providerBaseUrl(upstreams, "anthropic");
  const openaiUpstreamUrl = providerBaseUrl(upstreams, "openai");
  if (upstreamUrl === undefined && openaiUpstreamUrl === undefined) {
    throw new Error(
      "at least one of upstreams.anthropic or upstreams.openai must be configured",
    );
  }

  const timeouts = optionalObjectValue(root, "timeouts", "timeouts") ?? {};
  assertKnownKeys(
    timeouts,
    ["responseHeadersMs", "streamIdleMs", "clientStallMs"],
    "timeouts",
  );
  const responseTimeoutMs = optionalInteger(
    timeouts,
    "responseHeadersMs",
    "timeouts.responseHeadersMs",
    { min: 0 },
  );
  const idleTimeoutMs = optionalInteger(
    timeouts,
    "streamIdleMs",
    "timeouts.streamIdleMs",
    { min: 0 },
  );
  const clientStallTimeoutMs = optionalInteger(
    timeouts,
    "clientStallMs",
    "timeouts.clientStallMs",
    { min: 0 },
  );

  const priority = optionalObjectValue(root, "priority", "priority") ?? {};
  assertKnownKeys(priority, ["trustHeader"], "priority");
  const trustPriorityHeader =
    optionalBoolean(priority, "trustHeader", "priority.trustHeader") ?? false;

  const poolsValue = root["pools"];
  if (!Array.isArray(poolsValue) || poolsValue.length === 0) {
    throw new Error("pools must be a non-empty array");
  }
  const pools = poolsValue.map(normalizePool);

  const names = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const pool of pools) {
    if (names.has(pool.name)) {
      throw new Error(`duplicate pool name: ${pool.name}`);
    }
    names.add(pool.name);
    for (const prefix of pool.modelPrefixes) {
      const existing = prefixes.get(prefix);
      if (existing !== undefined) {
        throw new Error(
          `duplicate model prefix ${JSON.stringify(prefix)} in pools ${existing} and ${pool.name}`,
        );
      }
      prefixes.set(prefix, pool.name);
    }
  }

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
      pools,
    },
    source: {
      kind: "file",
      path: source.path,
      version: 1,
      fingerprint: source.fingerprint,
    },
  };
}

export function loadRuntimeConfigFile(filePath: string): RuntimeConfig {
  const absolutePath = resolve(filePath);
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read configuration file ${absolutePath}: ${detail}`);
  }

  const document = parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid YAML in ${absolutePath}: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid YAML in ${absolutePath}: ${detail}`);
  }

  const fingerprint = createHash("sha256").update(text).digest("hex");
  return normalizeFileConfiguration(raw, {
    path: absolutePath,
    fingerprint,
  });
}

function assertNoLegacyEnvironmentConfiguration(env: NodeJS.ProcessEnv): void {
  const conflicts = LEGACY_CONFIG_ENV_NAMES.filter(
    (name) => envString(env, name) !== undefined,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `TYR_CONFIG_FILE cannot be combined with legacy configuration variable${conflicts.length === 1 ? "" : "s"}: ${conflicts.join(", ")}`,
    );
  }
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const configFile = envString(env, "TYR_CONFIG_FILE");
  if (configFile !== undefined) {
    assertNoLegacyEnvironmentConfiguration(env);
    return loadRuntimeConfigFile(configFile);
  }
  return loadLegacyEnvironmentConfig(env);
}
