import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { LatchfloAgentMetadata, LatchfloRuntimeConfig } from "./latchflo.js";
import {
  createJwtIdentityAuthenticator,
  DEFAULT_TYR_IDENTITY_HEADER,
  type JwtRsaAlgorithm,
  type TyrIdentityOptions,
} from "./identity.js";
import type { PoolConfig } from "./pools.js";
import {
  MAX_ADMISSION_CLASSES,
  MAX_ADMISSION_CLASS_RULES,
  MAX_ADMISSION_IDENTIFIER_LENGTH,
  MAX_ADMISSION_RULE_VALUES,
  normalizeAdmissionClassId,
  type AdmissionClassesConfig,
} from "./admission-policy.js";
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
  controlPlane?: LatchfloRuntimeConfig;
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
  "MAX_QUEUE",
  "QUEUE_TIMEOUT_MS",
  "ADMISSION_LIMITS_REVISION",
  "TOKEN_BUDGET",
  "HIGH_PRIORITY_RESERVE",
  "OPAQUE_MEDIA_INPUT_TOKENS",
  "TRUST_X_PRIORITY_HEADER",
  "ADMISSION_MODE",
  "SHUTDOWN_DRAIN_TIMEOUT_MS",
  "ADAPTIVE_ESTIMATION",
  "ADAPTIVE_SMOOTHING",
  "ADAPTIVE_MIN_SAMPLES",
  "ADAPTIVE_MIN_CORRECTION",
  "ADAPTIVE_MAX_CORRECTION",
  "ADAPTIVE_MAX_MODELS",
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

function parseFiniteNumber(
  raw: string,
  name: string,
  opts: { exclusiveMin?: number; min?: number; max?: number },
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    throw new Error(`${name} must be > ${opts.exclusiveMin}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${name} must be <= ${opts.max}`);
  }
  return value;
}

function optionalNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  opts: { exclusiveMin?: number; min?: number; max?: number },
): number | undefined {
  const raw = envString(env, name);
  return raw === undefined ? undefined : parseFiniteNumber(raw, name, opts);
}

function admissionModeEnv(
  env: NodeJS.ProcessEnv,
): "enforce" | "observe" {
  const value = envString(env, "ADMISSION_MODE")?.toLowerCase() ?? "enforce";
  if (value !== "enforce" && value !== "observe") {
    throw new Error('ADMISSION_MODE must be "enforce" or "observe"');
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

function optionalBooleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = envString(env, name)?.toLowerCase();
  if (raw === undefined) return undefined;
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
  const shutdownDrainTimeoutMs = optionalIntegerEnv(
    env,
    "SHUTDOWN_DRAIN_TIMEOUT_MS",
    { min: 0 },
  );
  const maxConcurrent = integerEnv(env, "MAX_CONCURRENT", 50, { min: 1 });
  const maxQueue = integerEnv(env, "MAX_QUEUE", 0, { min: 0 });
  const queueTimeoutMs = optionalIntegerEnv(env, "QUEUE_TIMEOUT_MS", { min: 0 });
  const initialRevision = integerEnv(env, "ADMISSION_LIMITS_REVISION", 0, { min: 0 });
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
  const metricsEnabled = booleanEnv(env, "TYR_METRICS_ENABLED", true);
  const auditEnabled = booleanEnv(env, "TYR_AUDIT_ENABLED", false);
  const retryHint = {
    enabled: booleanEnv(env, "TYR_RETRY_HINT_ENABLED", true),
  };

  const operatorBearerToken = envString(env, "TYR_OPERATOR_BEARER_TOKEN");
  const admissionMode = admissionModeEnv(env);
  const adaptiveSmoothing = optionalNumberEnv(env, "ADAPTIVE_SMOOTHING", {
    exclusiveMin: 0,
    max: 1,
  });
  const adaptiveMinSamples = optionalIntegerEnv(
    env,
    "ADAPTIVE_MIN_SAMPLES",
    { min: 1 },
  );
  const adaptiveMinCorrection = optionalNumberEnv(
    env,
    "ADAPTIVE_MIN_CORRECTION",
    { exclusiveMin: 0 },
  );
  const adaptiveMaxCorrection = optionalNumberEnv(
    env,
    "ADAPTIVE_MAX_CORRECTION",
    { exclusiveMin: 0 },
  );
  const adaptiveMaxModels = optionalIntegerEnv(env, "ADAPTIVE_MAX_MODELS", {
    min: 1,
  });
  if (
    adaptiveMinCorrection !== undefined &&
    adaptiveMaxCorrection !== undefined &&
    adaptiveMaxCorrection < adaptiveMinCorrection
  ) {
    throw new Error(
      "ADAPTIVE_MAX_CORRECTION must be >= ADAPTIVE_MIN_CORRECTION",
    );
  }
  const adaptiveEstimation = {
    enabled: booleanEnv(env, "ADAPTIVE_ESTIMATION", true),
    ...(adaptiveSmoothing !== undefined
      ? { smoothing: adaptiveSmoothing }
      : {}),
    ...(adaptiveMinSamples !== undefined
      ? { minSamples: adaptiveMinSamples }
      : {}),
    ...(adaptiveMinCorrection !== undefined
      ? { minCorrection: adaptiveMinCorrection }
      : {}),
    ...(adaptiveMaxCorrection !== undefined
      ? { maxCorrection: adaptiveMaxCorrection }
      : {}),
    ...(adaptiveMaxModels !== undefined
      ? { maxModels: adaptiveMaxModels }
      : {}),
  };

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
      ...(shutdownDrainTimeoutMs !== undefined
        ? { shutdownDrainTimeoutMs }
        : {}),
      trustPriorityHeader,
      telemetry: { metricsEnabled, auditEnabled },
      retryHint,
      ...(operatorBearerToken === undefined ? {} : { operatorBearerToken }),
      pools: [
        {
          name: "default",
          modelPrefixes: ["claude", "gpt", "o1", "o3", "o4"],
          model: "claude-sonnet-4",
          maxConcurrent,
          maxQueue,
          initialRevision,
          ...(queueTimeoutMs !== undefined ? { queueTimeoutMs } : {}),
          budget,
          highPriorityReserve,
          admissionMode,
          adaptiveEstimation,
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

/**
 * Spread-friendly form of `optionalInteger`: yields `{}` when the key is
 * absent so an omitted field never becomes an explicit `undefined` under
 * `exactOptionalPropertyTypes`.
 */
function optionalIntegerEntry<K extends string>(
  parent: ObjectValue,
  key: K,
  field: string,
  opts: { min: number; max?: number },
): Partial<Record<K, number>> {
  const value = optionalInteger(parent, key, field, opts);
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, number>>;
}

function requiredNumber(
  value: unknown,
  field: string,
  opts: { exclusiveMin?: number; min?: number; max?: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    throw new Error(`${field} must be > ${opts.exclusiveMin}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new Error(`${field} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new Error(`${field} must be <= ${opts.max}`);
  }
  return value;
}

function optionalNumber(
  parent: ObjectValue,
  key: string,
  field: string,
  opts: { exclusiveMin?: number; min?: number; max?: number },
): number | undefined {
  const value = parent[key];
  return value === undefined ? undefined : requiredNumber(value, field, opts);
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

function normalizeCapacityRouting(
  value: unknown,
  env: NodeJS.ProcessEnv,
): GatewayOptions["capacityRouting"] | undefined {
  if (value === undefined) return undefined;
  const routing = objectValue(value, "routing");
  assertKnownKeys(routing, ["capacityAware"], "routing");
  const capacityAware = optionalObjectValue(
    routing,
    "capacityAware",
    "routing.capacityAware",
  );
  if (capacityAware === undefined) return undefined;
  assertKnownKeys(
    capacityAware,
    [
      "instanceId",
      "sharedSecretEnv",
      "peers",
      "pollIntervalMs",
      "staleAfterMs",
      "probeTimeoutMs",
      "forwardTimeoutMs",
    ],
    "routing.capacityAware",
  );

  const instanceId = requiredString(
    capacityAware["instanceId"],
    "routing.capacityAware.instanceId",
  );
  const secretEnvName = requiredString(
    capacityAware["sharedSecretEnv"],
    "routing.capacityAware.sharedSecretEnv",
  );
  const sharedSecret = envString(env, secretEnvName);
  if (sharedSecret === undefined) {
    throw new Error(
      `routing.capacityAware.sharedSecretEnv references unset environment variable ${secretEnvName}`,
    );
  }
  if (sharedSecret.length < 16) {
    throw new Error(
      `routing capacity secret from ${secretEnvName} must be at least 16 characters`,
    );
  }

  const rawPeers = capacityAware["peers"];
  if (!Array.isArray(rawPeers)) {
    throw new Error("routing.capacityAware.peers must be an array");
  }
  const peers = rawPeers.map((rawPeer, index) => {
    const field = `routing.capacityAware.peers[${index}]`;
    const peer = objectValue(rawPeer, field);
    assertKnownKeys(peer, ["id", "baseUrl"], field);
    const id = requiredString(peer["id"], `${field}.id`);
    const baseUrl = absoluteHttpUrl(peer["baseUrl"], `${field}.baseUrl`);
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      throw new Error(`${field}.baseUrl must not contain credentials`);
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error(`${field}.baseUrl must not contain a path`);
    }
    return { id, baseUrl: parsed.origin };
  });
  const peerIds = new Set<string>();
  for (const peer of peers) {
    if (peer.id === instanceId) {
      throw new Error(
        "routing.capacityAware.peers must not include the local instanceId",
      );
    }
    if (peerIds.has(peer.id)) {
      throw new Error(`duplicate capacity routing peer id: ${peer.id}`);
    }
    peerIds.add(peer.id);
  }

  const pollIntervalMs = optionalInteger(
    capacityAware,
    "pollIntervalMs",
    "routing.capacityAware.pollIntervalMs",
    { min: 1 },
  );
  const staleAfterMs = optionalInteger(
    capacityAware,
    "staleAfterMs",
    "routing.capacityAware.staleAfterMs",
    { min: 1 },
  );
  const probeTimeoutMs = optionalInteger(
    capacityAware,
    "probeTimeoutMs",
    "routing.capacityAware.probeTimeoutMs",
    { min: 1 },
  );
  const forwardTimeoutMs = optionalInteger(
    capacityAware,
    "forwardTimeoutMs",
    "routing.capacityAware.forwardTimeoutMs",
    { min: 1 },
  );
  if ((staleAfterMs ?? 1_000) < (pollIntervalMs ?? 100)) {
    throw new Error(
      "routing.capacityAware.staleAfterMs must be >= pollIntervalMs",
    );
  }

  return {
    instanceId,
    sharedSecret,
    peers,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
    ...(forwardTimeoutMs === undefined ? {} : { forwardTimeoutMs }),
  };
}


function optionalString(
  parent: ObjectValue,
  key: string,
  field: string,
): string | undefined {
  const value = parent[key];
  return value === undefined ? undefined : requiredString(value, field);
}

function normalizeLabels(value: unknown, field: string): Record<string, string> {
  const labels = objectValue(value, field);
  const normalized: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(labels)) {
    const normalizedKey = requiredString(key, `${field} key`);
    normalized[normalizedKey] = requiredString(labelValue, `${field}.${key}`);
  }
  return normalized;
}

function stringArray(
  value: unknown,
  field: string,
  opts: { minItems?: number } = {},
): string[] {
  if (!Array.isArray(value) || value.length < (opts.minItems ?? 0)) {
    throw new Error(
      `${field} must be an array with at least ${opts.minItems ?? 0} item(s)`,
    );
  }
  const normalized = value.map((entry, index) =>
    requiredString(entry, `${field}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  return normalized;
}

function stringOrStringArray(value: unknown, field: string): string | string[] {
  if (typeof value === "string") return requiredString(value, field);
  return stringArray(value, field, { minItems: 1 });
}

function normalizeIdentity(value: unknown): TyrIdentityOptions | undefined {
  if (value === undefined) return undefined;
  const identity = objectValue(value, "identity");
  assertKnownKeys(identity, ["jwt", "roles"], "identity");

  const jwt = objectValue(identity["jwt"], "identity.jwt");
  assertKnownKeys(
    jwt,
    [
      "jwksUrl",
      "issuer",
      "audience",
      "header",
      "algorithms",
      "cacheTtlMs",
      "requestTimeoutMs",
      "clockSkewSeconds",
      "requireExpiration",
      "claims",
    ],
    "identity.jwt",
  );
  const jwksUrl = absoluteHttpUrl(jwt["jwksUrl"], "identity.jwt.jwksUrl");
  const issuer = requiredString(jwt["issuer"], "identity.jwt.issuer");
  const audience = stringOrStringArray(
    jwt["audience"],
    "identity.jwt.audience",
  );
  const header = optionalString(jwt, "header", "identity.jwt.header");
  const credentialHeader = (header ?? DEFAULT_TYR_IDENTITY_HEADER).toLowerCase();
  const providerHeaders = new Set([
    "authorization",
    "content-type",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "openai-organization",
    "openai-project",
  ]);
  if (providerHeaders.has(credentialHeader)) {
    throw new Error(
      `identity.jwt.header conflicts with provider header ${credentialHeader}`,
    );
  }
  const rawAlgorithms = jwt["algorithms"];
  let algorithms: JwtRsaAlgorithm[] | undefined;
  if (rawAlgorithms !== undefined) {
    const values = stringArray(rawAlgorithms, "identity.jwt.algorithms", {
      minItems: 1,
    });
    for (const value of values) {
      if (value !== "RS256" && value !== "RS384" && value !== "RS512") {
        throw new Error(
          `identity.jwt.algorithms contains unsupported algorithm ${value}`,
        );
      }
    }
    algorithms = values as JwtRsaAlgorithm[];
  }
  const cacheTtlMs = optionalInteger(
    jwt,
    "cacheTtlMs",
    "identity.jwt.cacheTtlMs",
    { min: 0 },
  );
  const requestTimeoutMs = optionalInteger(
    jwt,
    "requestTimeoutMs",
    "identity.jwt.requestTimeoutMs",
    { min: 1 },
  );
  const clockSkewSeconds = optionalInteger(
    jwt,
    "clockSkewSeconds",
    "identity.jwt.clockSkewSeconds",
    { min: 0 },
  );
  const requireExpiration = optionalBoolean(
    jwt,
    "requireExpiration",
    "identity.jwt.requireExpiration",
  );

  const claims = optionalObjectValue(jwt, "claims", "identity.jwt.claims") ?? {};
  assertKnownKeys(
    claims,
    ["subject", "tenantId", "applicationId", "roles"],
    "identity.jwt.claims",
  );
  const subject = optionalString(
    claims,
    "subject",
    "identity.jwt.claims.subject",
  );
  const tenantId = optionalString(
    claims,
    "tenantId",
    "identity.jwt.claims.tenantId",
  );
  const applicationId = optionalString(
    claims,
    "applicationId",
    "identity.jwt.claims.applicationId",
  );
  const rolesClaim = optionalString(
    claims,
    "roles",
    "identity.jwt.claims.roles",
  );

  const roleConfig = optionalObjectValue(identity, "roles", "identity.roles") ?? {};
  assertKnownKeys(
    roleConfig,
    ["invoke", "operator", "highPriority"],
    "identity.roles",
  );
  const invokeRoles =
    roleConfig["invoke"] === undefined
      ? undefined
      : stringArray(roleConfig["invoke"], "identity.roles.invoke");
  const operatorRoles =
    roleConfig["operator"] === undefined
      ? undefined
      : stringArray(roleConfig["operator"], "identity.roles.operator");
  const highPriorityRoles =
    roleConfig["highPriority"] === undefined
      ? undefined
      : stringArray(
          roleConfig["highPriority"],
          "identity.roles.highPriority",
        );

  return {
    credentialHeader,
    authenticate: createJwtIdentityAuthenticator({
      jwksUrl,
      issuer,
      audience,
      ...(header === undefined ? {} : { header }),
      ...(algorithms === undefined ? {} : { algorithms }),
      ...(cacheTtlMs === undefined ? {} : { cacheTtlMs }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(clockSkewSeconds === undefined ? {} : { clockSkewSeconds }),
      ...(requireExpiration === undefined ? {} : { requireExpiration }),
      claims: {
        ...(subject === undefined ? {} : { subject }),
        ...(tenantId === undefined ? {} : { tenantId }),
        ...(applicationId === undefined ? {} : { applicationId }),
        ...(rolesClaim === undefined ? {} : { roles: rolesClaim }),
      },
    }),
    ...(invokeRoles === undefined ? {} : { invokeRoles }),
    ...(operatorRoles === undefined ? {} : { operatorRoles }),
    ...(highPriorityRoles === undefined ? {} : { highPriorityRoles }),
  };
}

function normalizeControlPlaneMetadata(
  value: unknown,
): LatchfloAgentMetadata | undefined {
  if (value === undefined) return undefined;
  const metadata = objectValue(value, "controlPlane.metadata");
  assertKnownKeys(
    metadata,
    ["region", "zone", "version", "endpoint", "labels"],
    "controlPlane.metadata",
  );
  const region = optionalString(metadata, "region", "controlPlane.metadata.region");
  const zone = optionalString(metadata, "zone", "controlPlane.metadata.zone");
  const version = optionalString(
    metadata,
    "version",
    "controlPlane.metadata.version",
  );
  const endpoint = optionalString(
    metadata,
    "endpoint",
    "controlPlane.metadata.endpoint",
  );
  const labels =
    metadata["labels"] === undefined
      ? undefined
      : normalizeLabels(metadata["labels"], "controlPlane.metadata.labels");
  return {
    ...(region === undefined ? {} : { region }),
    ...(zone === undefined ? {} : { zone }),
    ...(version === undefined ? {} : { version }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(labels === undefined ? {} : { labels }),
  };
}

function normalizeControlPlane(
  value: unknown,
  pools: readonly PoolConfig[],
  sourcePath: string,
): LatchfloRuntimeConfig | undefined {
  if (value === undefined) return undefined;
  const controlPlane = objectValue(value, "controlPlane");
  assertKnownKeys(
    controlPlane,
    [
      "type",
      "url",
      "instanceId",
      "pools",
      "bootstrapTokenEnv",
      "agentTokenFile",
      "retryIntervalMs",
      "retryMaxIntervalMs",
      "requestTimeoutMs",
      "metadata",
    ],
    "controlPlane",
  );
  const type = requiredString(controlPlane["type"], "controlPlane.type");
  if (type !== "latchflo") {
    throw new Error('controlPlane.type must be "latchflo"');
  }
  const url = absoluteHttpUrl(controlPlane["url"], "controlPlane.url");
  const instanceId = requiredString(
    controlPlane["instanceId"],
    "controlPlane.instanceId",
  );
  const configuredPools = controlPlane["pools"];
  let managedPools: string[];
  if (configuredPools === undefined) {
    managedPools = pools.map((pool) => pool.name);
  } else {
    if (!Array.isArray(configuredPools) || configuredPools.length === 0) {
      throw new Error("controlPlane.pools must be a non-empty array");
    }
    managedPools = configuredPools.map((pool, index) =>
      requiredString(pool, `controlPlane.pools[${index}]`),
    );
  }
  if (new Set(managedPools).size !== managedPools.length) {
    throw new Error("controlPlane.pools must not contain duplicates");
  }
  const knownPools = new Set(pools.map((pool) => pool.name));
  for (const pool of managedPools) {
    if (!knownPools.has(pool)) {
      throw new Error(`controlPlane.pools references unknown Tyr pool ${pool}`);
    }
  }
  const poolsByName = new Map(pools.map((pool) => [pool.name, pool]));
  for (const poolName of managedPools) {
    const pool = poolsByName.get(poolName);
    if (pool === undefined) continue;
    if (pool.maxConcurrent !== 0) {
      throw new Error(
        `Latchflo-managed pool ${poolName} must start with maxConcurrent: 0`,
      );
    }
    if ((pool.maxQueue ?? 0) !== 0) {
      throw new Error(
        `Latchflo-managed pool ${poolName} must start with maxQueue: 0`,
      );
    }
    if ((pool.initialRevision ?? 0) !== 0) {
      throw new Error(
        `Latchflo-managed pool ${poolName} must start with limitsRevision: 0`,
      );
    }
    if ((pool.admissionMode ?? "enforce") !== "enforce") {
      throw new Error(
        `Latchflo-managed pool ${poolName} must use admissionMode: enforce`,
      );
    }
  }
  const bootstrapTokenEnv =
    optionalString(
      controlPlane,
      "bootstrapTokenEnv",
      "controlPlane.bootstrapTokenEnv",
    ) ?? "LATCHFLO_AGENT_BOOTSTRAP_TOKEN";
  const agentTokenFileValue = optionalString(
    controlPlane,
    "agentTokenFile",
    "controlPlane.agentTokenFile",
  );
  const agentTokenFile =
    agentTokenFileValue === undefined
      ? undefined
      : resolve(dirname(sourcePath), agentTokenFileValue);
  const retryIntervalMs =
    optionalInteger(
      controlPlane,
      "retryIntervalMs",
      "controlPlane.retryIntervalMs",
      { min: 100 },
    ) ?? 1_000;
  const retryMaxIntervalMs =
    optionalInteger(
      controlPlane,
      "retryMaxIntervalMs",
      "controlPlane.retryMaxIntervalMs",
      { min: retryIntervalMs },
    ) ?? 30_000;
  const requestTimeoutMs =
    optionalInteger(
      controlPlane,
      "requestTimeoutMs",
      "controlPlane.requestTimeoutMs",
      { min: 100 },
    ) ?? 5_000;
  const metadata = normalizeControlPlaneMetadata(controlPlane["metadata"]);
  return {
    url,
    instanceId,
    pools: managedPools,
    bootstrapTokenEnv,
    ...(agentTokenFile === undefined ? {} : { agentTokenFile }),
    retryIntervalMs,
    retryMaxIntervalMs,
    requestTimeoutMs,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeAdmissionClasses(
  value: unknown,
  field: string,
  maxConcurrent: number,
  tokenBudget: number | undefined,
): AdmissionClassesConfig | undefined {
  if (value === undefined) return undefined;
  const policy = objectValue(value, field);
  assertKnownKeys(policy, ["defaultClass", "classes", "rules"], field);
  const defaultClass = normalizeAdmissionClassId(
    policy["defaultClass"],
    `${field}.defaultClass`,
  );
  const rawClasses = objectValue(policy["classes"], `${field}.classes`);
  const classEntries = Object.entries(rawClasses);
  if (classEntries.length === 0) {
    throw new Error(`${field}.classes must contain at least one class`);
  }
  if (classEntries.length > MAX_ADMISSION_CLASSES) {
    throw new Error(
      `${field}.classes must contain at most ${MAX_ADMISSION_CLASSES} classes`,
    );
  }
  const classes: Record<
    string,
    {
      protectedConcurrent?: number;
      maxConcurrent?: number;
      protectedInFlightTokens?: number;
      maxInFlightTokens?: number;
    }
  > = {};
  let protectedConcurrentTotal = 0;
  let protectedInFlightTokensTotal = 0;
  for (const [rawClassId, rawLimits] of classEntries) {
    const classId = normalizeAdmissionClassId(rawClassId, `${field} class id`);
    if (Object.hasOwn(classes, classId)) {
      throw new Error(
        `${field}.classes contains duplicate normalized class ID ${JSON.stringify(classId)}`,
      );
    }
    const classField = `${field}.classes[${JSON.stringify(classId)}]`;
    const limits = objectValue(rawLimits, classField);
    assertKnownKeys(
      limits,
      [
        "protectedConcurrent",
        "maxConcurrent",
        "protectedInFlightTokens",
        "maxInFlightTokens",
      ],
      classField,
    );
    const protectedConcurrent = optionalInteger(
      limits,
      "protectedConcurrent",
      `${classField}.protectedConcurrent`,
      { min: 0 },
    );
    const classMaxConcurrent = optionalInteger(
      limits,
      "maxConcurrent",
      `${classField}.maxConcurrent`,
      { min: 0 },
    );
    const protectedInFlightTokens = optionalInteger(
      limits,
      "protectedInFlightTokens",
      `${classField}.protectedInFlightTokens`,
      { min: 0 },
    );
    const maxInFlightTokens = optionalInteger(
      limits,
      "maxInFlightTokens",
      `${classField}.maxInFlightTokens`,
      { min: 0 },
    );
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
      maxInFlightTokens !== undefined &&
      protectedInFlightTokens > maxInFlightTokens
    ) {
      throw new Error(
        `${classField}.protectedInFlightTokens must not exceed ${classField}.maxInFlightTokens`,
      );
    }
    if (tokenBudget === undefined && protectedInFlightTokens !== undefined) {
      throw new Error(
        `${classField}.protectedInFlightTokens requires inFlightTokenBudget`,
      );
    }
    if (tokenBudget === undefined && maxInFlightTokens !== undefined) {
      throw new Error(
        `${classField}.maxInFlightTokens requires inFlightTokenBudget`,
      );
    }
    protectedConcurrentTotal += protectedConcurrent ?? 0;
    protectedInFlightTokensTotal += protectedInFlightTokens ?? 0;
    classes[classId] = {
      ...(protectedConcurrent === undefined ? {} : { protectedConcurrent }),
      ...(classMaxConcurrent === undefined
        ? {}
        : { maxConcurrent: classMaxConcurrent }),
      ...(protectedInFlightTokens === undefined
        ? {}
        : { protectedInFlightTokens }),
      ...(maxInFlightTokens === undefined ? {} : { maxInFlightTokens }),
    };
  }
  if (protectedConcurrentTotal > maxConcurrent) {
    throw new Error(
      `${field}.classes protectedConcurrent sum must not exceed maxConcurrent`,
    );
  }
  if (
    tokenBudget !== undefined &&
    protectedInFlightTokensTotal > tokenBudget
  ) {
    throw new Error(
      `${field}.classes protectedInFlightTokens sum must not exceed inFlightTokenBudget`,
    );
  }
  if (!Object.hasOwn(classes, defaultClass)) {
    throw new Error(`${field}.defaultClass must reference a configured class`);
  }

  const rawRules = policy["rules"];
  let rules: AdmissionClassesConfig["rules"];
  if (rawRules !== undefined) {
    if (!Array.isArray(rawRules)) {
      throw new Error(`${field}.rules must be an array`);
    }
    if (rawRules.length > MAX_ADMISSION_CLASS_RULES) {
      throw new Error(
        `${field}.rules must contain at most ${MAX_ADMISSION_CLASS_RULES} rules`,
      );
    }
    rules = rawRules.map((rawRule, index) => {
      const ruleField = `${field}.rules[${index}]`;
      const rule = objectValue(rawRule, ruleField);
      assertKnownKeys(
        rule,
        ["admissionClass", "subjects", "tenantIds", "applicationIds", "roles"],
        ruleField,
      );
      const admissionClass = normalizeAdmissionClassId(
        rule["admissionClass"],
        `${ruleField}.admissionClass`,
      );
      if (!Object.hasOwn(classes, admissionClass)) {
        throw new Error(
          `${ruleField}.admissionClass references unknown class ${JSON.stringify(admissionClass)}`,
        );
      }
      const selectors: Record<string, string[]> = {};
      for (const key of ["subjects", "tenantIds", "applicationIds", "roles"] as const) {
        const raw = rule[key];
        if (raw !== undefined) {
          const values = stringArray(raw, `${ruleField}.${key}`, { minItems: 1 });
          for (const [valueIndex, selector] of values.entries()) {
            if (selector.length > MAX_ADMISSION_IDENTIFIER_LENGTH) {
              throw new Error(
                `${ruleField}.${key}[${valueIndex}] must be at most ${MAX_ADMISSION_IDENTIFIER_LENGTH} characters`,
              );
            }
          }
          if (values.length > MAX_ADMISSION_RULE_VALUES) {
            throw new Error(
              `${ruleField}.${key} must contain at most ${MAX_ADMISSION_RULE_VALUES} values`,
            );
          }
          selectors[key] = values;
        }
      }
      if (Object.keys(selectors).length === 0) {
        throw new Error(`${ruleField} must define at least one selector`);
      }
      return {
        admissionClass,
        ...(selectors["subjects"] === undefined
          ? {}
          : { subjects: selectors["subjects"] }),
        ...(selectors["tenantIds"] === undefined
          ? {}
          : { tenantIds: selectors["tenantIds"] }),
        ...(selectors["applicationIds"] === undefined
          ? {}
          : { applicationIds: selectors["applicationIds"] }),
        ...(selectors["roles"] === undefined ? {} : { roles: selectors["roles"] }),
      };
    });
  }

  return {
    defaultClass,
    classes,
    ...(rules === undefined || rules.length === 0 ? {} : { rules }),
  };
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
      "maxQueue",
      "queueTimeoutMs",
      "limitsRevision",
      "inFlightTokenBudget",
      "highPriorityTokenReserve",
      "defaultOutputReservation",
      "opaqueMediaInputTokenReservation",
      "admissionMode",
      "adaptiveEstimation",
      "progressiveReconciliation",
      "admissionClasses",
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
    { min: 0 },
  );
  const maxQueue = optionalInteger(
    pool,
    "maxQueue",
    `${field}.maxQueue`,
    { min: 0 },
  );
  const queueTimeoutMs = optionalInteger(
    pool,
    "queueTimeoutMs",
    `${field}.queueTimeoutMs`,
    { min: 0 },
  );
  const initialRevision = optionalInteger(
    pool,
    "limitsRevision",
    `${field}.limitsRevision`,
    { min: 0 },
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

  const admissionModeValue = pool["admissionMode"];
  let admissionMode: "enforce" | "observe" | undefined;
  if (admissionModeValue !== undefined) {
    if (admissionModeValue !== "enforce" && admissionModeValue !== "observe") {
      throw new Error(`${field}.admissionMode must be "enforce" or "observe"`);
    }
    admissionMode = admissionModeValue;
  }

  const adaptiveValue = optionalObjectValue(
    pool,
    "adaptiveEstimation",
    `${field}.adaptiveEstimation`,
  );
  let adaptiveEstimation: PoolConfig["adaptiveEstimation"];
  if (adaptiveValue !== undefined) {
    assertKnownKeys(
      adaptiveValue,
      [
        "enabled",
        "smoothing",
        "minSamples",
        "minCorrection",
        "maxCorrection",
        "maxModels",
      ],
      `${field}.adaptiveEstimation`,
    );
    const enabled = optionalBoolean(
      adaptiveValue,
      "enabled",
      `${field}.adaptiveEstimation.enabled`,
    );
    const smoothing = optionalNumber(
      adaptiveValue,
      "smoothing",
      `${field}.adaptiveEstimation.smoothing`,
      { exclusiveMin: 0, max: 1 },
    );
    const minSamples = optionalInteger(
      adaptiveValue,
      "minSamples",
      `${field}.adaptiveEstimation.minSamples`,
      { min: 1 },
    );
    const minCorrection = optionalNumber(
      adaptiveValue,
      "minCorrection",
      `${field}.adaptiveEstimation.minCorrection`,
      { exclusiveMin: 0 },
    );
    const maxCorrection = optionalNumber(
      adaptiveValue,
      "maxCorrection",
      `${field}.adaptiveEstimation.maxCorrection`,
      { exclusiveMin: 0 },
    );
    const maxModels = optionalInteger(
      adaptiveValue,
      "maxModels",
      `${field}.adaptiveEstimation.maxModels`,
      { min: 1 },
    );
    if (
      minCorrection !== undefined &&
      maxCorrection !== undefined &&
      maxCorrection < minCorrection
    ) {
      throw new Error(
        `${field}.adaptiveEstimation.maxCorrection must be >= ${field}.adaptiveEstimation.minCorrection`,
      );
    }
    adaptiveEstimation = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(smoothing !== undefined ? { smoothing } : {}),
      ...(minSamples !== undefined ? { minSamples } : {}),
      ...(minCorrection !== undefined ? { minCorrection } : {}),
      ...(maxCorrection !== undefined ? { maxCorrection } : {}),
      ...(maxModels !== undefined ? { maxModels } : {}),
    };
  }

  const progressiveValue = optionalObjectValue(
    pool,
    "progressiveReconciliation",
    `${field}.progressiveReconciliation`,
  );
  let progressiveReconciliation: PoolConfig["progressiveReconciliation"];
  if (progressiveValue !== undefined) {
    assertKnownKeys(
      progressiveValue,
      ["enabled", "updateStepTokens", "outputSafetyMarginTokens"],
      `${field}.progressiveReconciliation`,
    );
    const enabled = optionalBoolean(
      progressiveValue,
      "enabled",
      `${field}.progressiveReconciliation.enabled`,
    );
    const updateStepTokens = optionalInteger(
      progressiveValue,
      "updateStepTokens",
      `${field}.progressiveReconciliation.updateStepTokens`,
      { min: 1 },
    );
    const outputSafetyMarginTokens = optionalInteger(
      progressiveValue,
      "outputSafetyMarginTokens",
      `${field}.progressiveReconciliation.outputSafetyMarginTokens`,
      { min: 0 },
    );
    progressiveReconciliation = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(updateStepTokens !== undefined ? { updateStepTokens } : {}),
      ...(outputSafetyMarginTokens !== undefined
        ? { outputSafetyMarginTokens }
        : {}),
    };
  }

  const admissionClasses = normalizeAdmissionClasses(
    pool["admissionClasses"],
    `${field}.admissionClasses`,
    maxConcurrent,
    budget,
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
    ...(maxQueue !== undefined ? { maxQueue } : {}),
    ...(queueTimeoutMs !== undefined ? { queueTimeoutMs } : {}),
    ...(initialRevision !== undefined ? { initialRevision } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(reserve !== undefined ? { highPriorityReserve: reserve } : {}),
    ...(outputCap !== undefined ? { outputCap } : {}),
    ...(opaqueMediaInputTokens !== undefined
      ? { opaqueMediaInputTokens }
      : {}),
    ...(admissionMode !== undefined ? { admissionMode } : {}),
    ...(adaptiveEstimation !== undefined ? { adaptiveEstimation } : {}),
    ...(progressiveReconciliation !== undefined
      ? { progressiveReconciliation }
      : {}),
    ...(admissionClasses === undefined ? {} : { admissionClasses }),
  };
}

function normalizeFileConfiguration(
  raw: unknown,
  source: { path: string; fingerprint: string },
  env: NodeJS.ProcessEnv,
): RuntimeConfig {
  const root = objectValue(raw, "configuration");
  assertKnownKeys(
    root,
    [
      "version",
      "server",
      "upstreams",
      "timeouts",
      "shutdown",
      "priority",
      "identity",
      "routing",
      "telemetry",
      "retryHint",
      "pools",
      "controlPlane",
    ],
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

  const shutdown = optionalObjectValue(root, "shutdown", "shutdown") ?? {};
  assertKnownKeys(shutdown, ["drainTimeoutMs"], "shutdown");
  const shutdownDrainTimeoutMs = optionalInteger(
    shutdown,
    "drainTimeoutMs",
    "shutdown.drainTimeoutMs",
    { min: 0 },
  );

  const priority = optionalObjectValue(root, "priority", "priority") ?? {};
  assertKnownKeys(priority, ["trustHeader"], "priority");
  const trustPriorityHeader =
    optionalBoolean(priority, "trustHeader", "priority.trustHeader") ?? false;
  const identity = normalizeIdentity(root["identity"]);
  const capacityRouting = normalizeCapacityRouting(root["routing"], env);

  const telemetry = optionalObjectValue(root, "telemetry", "telemetry") ?? {};
  assertKnownKeys(telemetry, ["metrics", "audit"], "telemetry");
  const metrics =
    optionalObjectValue(telemetry, "metrics", "telemetry.metrics") ?? {};
  assertKnownKeys(metrics, ["enabled"], "telemetry.metrics");
  const audit = optionalObjectValue(telemetry, "audit", "telemetry.audit") ?? {};
  assertKnownKeys(audit, ["enabled"], "telemetry.audit");
  const metricsEnabled =
    optionalBooleanEnv(env, "TYR_METRICS_ENABLED") ??
    optionalBoolean(metrics, "enabled", "telemetry.metrics.enabled") ??
    true;
  const auditEnabled =
    optionalBooleanEnv(env, "TYR_AUDIT_ENABLED") ??
    optionalBoolean(audit, "enabled", "telemetry.audit.enabled") ??
    false;
  const retryHintValue = optionalObjectValue(root, "retryHint", "retryHint") ?? {};
  assertKnownKeys(
    retryHintValue,
    ["enabled", "minMs", "maxMs", "halfLifeMs", "minSamples"],
    "retryHint",
  );
  const retryHint = {
    enabled:
      optionalBooleanEnv(env, "TYR_RETRY_HINT_ENABLED") ??
      optionalBoolean(retryHintValue, "enabled", "retryHint.enabled") ??
      true,
    ...optionalIntegerEntry(retryHintValue, "minMs", "retryHint.minMs", { min: 0 }),
    ...optionalIntegerEntry(retryHintValue, "maxMs", "retryHint.maxMs", { min: 0 }),
    ...optionalIntegerEntry(retryHintValue, "halfLifeMs", "retryHint.halfLifeMs", {
      min: 1,
    }),
    ...optionalIntegerEntry(retryHintValue, "minSamples", "retryHint.minSamples", {
      min: 1,
    }),
  };

  const operatorBearerToken = envString(env, "TYR_OPERATOR_BEARER_TOKEN");

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

  const controlPlane = normalizeControlPlane(
    root["controlPlane"],
    pools,
    source.path,
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
      ...(shutdownDrainTimeoutMs !== undefined
        ? { shutdownDrainTimeoutMs }
        : {}),
      trustPriorityHeader,
      ...(identity === undefined ? {} : { identity }),
      ...(capacityRouting === undefined ? {} : { capacityRouting }),
      telemetry: { metricsEnabled, auditEnabled },
      retryHint,
      ...(operatorBearerToken === undefined ? {} : { operatorBearerToken }),
      pools,
    },
    ...(controlPlane === undefined ? {} : { controlPlane }),
    source: {
      kind: "file",
      path: source.path,
      version: 1,
      fingerprint: source.fingerprint,
    },
  };
}

export function loadRuntimeConfigFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const absolutePath = resolve(filePath);
  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read configuration file ${absolutePath}: ${detail}`, {
      cause: error,
    });
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
    throw new Error(`invalid YAML in ${absolutePath}: ${detail}`, {
      cause: error,
    });
  }

  const fingerprint = createHash("sha256").update(text).digest("hex");
  return normalizeFileConfiguration(
    raw,
    {
      path: absolutePath,
      fingerprint,
    },
    env,
  );
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
    return loadRuntimeConfigFile(configFile, env);
  }
  return loadLegacyEnvironmentConfig(env);
}
