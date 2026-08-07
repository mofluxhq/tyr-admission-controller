import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LLMAdmissionLimits } from "async-bulkhead-llm";
import {
  MAX_ADMISSION_CLASSES,
  normalizeAdmissionClassId,
} from "./admission-policy.js";
import type { PoolLimitsUpdate } from "./pools.js";
import { TyrDemandReporter, type PoolDemandSnapshot } from "./demand.js";
import type { TyrControlPlane } from "./server.js";
import type {
  LatchfloFailureOperation,
  LatchfloFailureReason,
} from "./telemetry.js";

export type LatchfloAgentMetadata = {
  readonly region?: string;
  readonly zone?: string;
  readonly version?: string;
  readonly endpoint?: string;
  readonly labels?: Readonly<Record<string, string>>;
};

export type LatchfloRuntimeConfig = {
  readonly url: string;
  readonly instanceId: string;
  readonly pools: readonly string[];
  readonly bootstrapTokenEnv: string;
  readonly agentTokenFile?: string;
  /** Base delay used for startup retries. Retries use exponential equal jitter. */
  readonly retryIntervalMs: number;
  /** Maximum client-generated startup retry delay. */
  readonly retryMaxIntervalMs: number;
  /** Per-request deadline for control-plane calls. */
  readonly requestTimeoutMs: number;
  readonly metadata?: LatchfloAgentMetadata;
};

type AdmissionTokenBudget = {
  readonly budget: number;
  readonly highPriorityReserve: number;
};

type TyrAdmissionClassLimits = {
  readonly protectedConcurrent?: number;
  readonly maxConcurrent?: number;
  readonly protectedInFlightTokens?: number;
  readonly maxInFlightTokens?: number;
};

type TyrAdmissionLimits = {
  readonly revision: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly tokenBudget?: AdmissionTokenBudget;
  /**
   * Latchflo 0.7+ partitions each pool's fleet-wide admission-class ceilings
   * across replicas and ships this replica's share on every grant. Absent when
   * the control plane predates class-aware allocation.
   */
  readonly admissionClasses?: Readonly<Record<string, TyrAdmissionClassLimits>>;
};

type CapacityGrant = {
  readonly grantId: string;
  readonly instanceId: string;
  readonly pool: string;
  readonly controllerEpoch: number;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly limits: TyrAdmissionLimits;
};

type AgentDesiredState = {
  readonly controllerEpoch: number;
  readonly serverTime: string;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly grants: readonly CapacityGrant[];
};

type RegistrationResponse = {
  readonly agentToken: string;
  readonly controllerEpoch: number;
};

type Logger = Pick<Console, "info" | "warn" | "error">;
type JsonObject = Record<string, unknown>;
type FailureReporter = (event: {
  operation: LatchfloFailureOperation;
  reason: LatchfloFailureReason;
}) => void;

function reportFailure(
  reporter: FailureReporter | undefined,
  event: Parameters<FailureReporter>[0],
): void {
  try {
    reporter?.(event);
  } catch {
    // Observability callbacks must never change control-plane behavior.
  }
}

class LatchfloRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LatchfloRequestError";
  }
}

function parseRetryAfterMs(response: Response, nowMs = Date.now()): number | undefined {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function responseError(
  operation: string,
  response: Response,
): Promise<LatchfloRequestError> {
  return new LatchfloRequestError(
    `${operation} failed: ${await readError(response)}`,
    isRetryableStatus(response.status),
    parseRetryAfterMs(response),
    response.status,
  );
}

function normalizeRequestError(error: unknown, operation: string): LatchfloRequestError {
  if (error instanceof LatchfloRequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Fetch transport failures and request deadlines are transient by default.
  return new LatchfloRequestError(`${operation} failed: ${message}`, true);
}

function protocolError(error: unknown, operation: string): LatchfloRequestError {
  const message = error instanceof Error ? error.message : String(error);
  return new LatchfloRequestError(`${operation} failed: ${message}`, false);
}

function jitteredInterval(
  intervalMs: number,
  random: () => number,
  spread = 0.2,
): number {
  const boundedSpread = Math.max(0, Math.min(1, spread));
  const minimum = intervalMs * (1 - boundedSpread);
  return Math.max(1, Math.floor(minimum + random() * intervalMs * boundedSpread * 2));
}

function backoffDelay(options: {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly attempt: number;
  readonly random: () => number;
  readonly retryAfterMs?: number;
}): number {
  const exponent = Math.min(options.attempt, 30);
  const cap = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  // Equal jitter preserves a minimum pause while breaking fleet lockstep.
  const jittered = Math.floor(cap / 2 + options.random() * (cap / 2));
  if (options.retryAfterMs === undefined) return Math.max(1, jittered);
  // Retry-After is a floor, with extra jitter so replicas do not wake together.
  const serverJitter = Math.floor(
    options.random() *
      Math.max(1, Math.min(options.baseMs, options.retryAfterMs / 10)),
  );
  return Math.max(1, jittered, options.retryAfterMs + serverJitter);
}

export type LatchfloTyrAgentOptions = {
  readonly controlPlaneUrl: string;
  readonly instanceId: string;
  readonly pools: readonly string[];
  readonly metadata?: LatchfloAgentMetadata;
  readonly bootstrapToken?: string;
  readonly agentToken?: string;
  readonly control: TyrControlPlane;
  readonly fetch?: typeof globalThis.fetch;
  readonly onAgentToken?: (token: string) => void | Promise<void>;
  readonly onReadyChange?: (ready: boolean) => void;
  /** Optional demand snapshots included in Latchflo 0.6+ heartbeats. */
  readonly demandProvider?: () =>
    | readonly PoolDemandSnapshot[]
    | Promise<readonly PoolDemandSnapshot[]>;
  /** Called only after Latchflo accepts the heartbeat carrying demand. */
  readonly onDemandAccepted?: () => void;
  readonly onFailure?: (event: {
    operation: LatchfloFailureOperation;
    reason: LatchfloFailureReason;
  }) => void;
  readonly requestTimeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly retryMaxIntervalMs?: number;
  readonly random?: () => number;
  readonly logger?: Logger;
};

export type LatchfloManagedMode = {
  readonly ready: () => boolean;
  readonly start: () => void;
  readonly stop: () => void;
};

function withoutTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function objectValue(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, field: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new Error(`${field} must be a safe integer >= ${min}`);
  }
  return value as number;
}

function timestampValue(value: unknown, field: string): string {
  const timestamp = stringValue(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return timestamp;
}

function parseTokenBudget(value: unknown, field: string): AdmissionTokenBudget {
  const budget = objectValue(value, field);
  const total = integerValue(budget["budget"], `${field}.budget`, 0);
  const reserve = integerValue(
    budget["highPriorityReserve"],
    `${field}.highPriorityReserve`,
    0,
  );
  if (reserve > total) {
    throw new Error(`${field}.highPriorityReserve must not exceed ${field}.budget`);
  }
  return { budget: total, highPriorityReserve: reserve };
}

function parseAdmissionClasses(
  value: unknown,
  field: string,
): Readonly<Record<string, TyrAdmissionClassLimits>> {
  const classes = objectValue(value, field);
  const entries = Object.entries(classes);
  if (entries.length === 0 || entries.length > MAX_ADMISSION_CLASSES) {
    throw new Error(
      `${field} must contain between 1 and ${MAX_ADMISSION_CLASSES} classes`,
    );
  }
  // Null-prototype so a control plane cannot reach Object.prototype through a
  // class ID. normalizeAdmissionClassId also rejects the reserved IDs.
  const parsed = Object.create(null) as Record<string, TyrAdmissionClassLimits>;
  for (const [rawId, rawLimits] of entries) {
    const id = normalizeAdmissionClassId(rawId, `${field} class id`);
    const classField = `${field}[${JSON.stringify(id)}]`;
    if (Object.hasOwn(parsed, id)) {
      throw new Error(`${field} contains duplicate class ID ${JSON.stringify(id)}`);
    }
    const limits = objectValue(rawLimits, classField);
    for (const key of Object.keys(limits)) {
      if (
        key !== "protectedConcurrent" &&
        key !== "maxConcurrent" &&
        key !== "protectedInFlightTokens" &&
        key !== "maxInFlightTokens"
      ) {
        throw new Error(
          `${classField} contains unknown property ${JSON.stringify(key)}`,
        );
      }
    }
    const protectedConcurrentRaw = limits["protectedConcurrent"];
    const maxConcurrentRaw = limits["maxConcurrent"];
    const protectedInFlightTokensRaw = limits["protectedInFlightTokens"];
    const maxInFlightTokensRaw = limits["maxInFlightTokens"];
    const protectedConcurrent =
      protectedConcurrentRaw === undefined
        ? undefined
        : integerValue(
            protectedConcurrentRaw,
            `${classField}.protectedConcurrent`,
            0,
          );
    const maxConcurrent =
      maxConcurrentRaw === undefined
        ? undefined
        : integerValue(maxConcurrentRaw, `${classField}.maxConcurrent`, 0);
    const protectedInFlightTokens =
      protectedInFlightTokensRaw === undefined
        ? undefined
        : integerValue(
            protectedInFlightTokensRaw,
            `${classField}.protectedInFlightTokens`,
            0,
          );
    const maxInFlightTokens =
      maxInFlightTokensRaw === undefined
        ? undefined
        : integerValue(
            maxInFlightTokensRaw,
            `${classField}.maxInFlightTokens`,
            0,
          );
    if (
      protectedConcurrent !== undefined &&
      maxConcurrent !== undefined &&
      protectedConcurrent > maxConcurrent
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
    parsed[id] = Object.freeze({
      ...(protectedConcurrent === undefined ? {} : { protectedConcurrent }),
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      ...(protectedInFlightTokens === undefined
        ? {}
        : { protectedInFlightTokens }),
      ...(maxInFlightTokens === undefined ? {} : { maxInFlightTokens }),
    });
  }
  return Object.freeze(parsed);
}

function parseLimits(value: unknown, field: string): TyrAdmissionLimits {
  const limits = objectValue(value, field);
  const revision = integerValue(limits["revision"], `${field}.revision`, 0);
  const maxConcurrent = integerValue(
    limits["maxConcurrent"],
    `${field}.maxConcurrent`,
    0,
  );
  const maxQueue = integerValue(limits["maxQueue"], `${field}.maxQueue`, 0);
  const tokenBudget =
    limits["tokenBudget"] === undefined
      ? undefined
      : parseTokenBudget(limits["tokenBudget"], `${field}.tokenBudget`);
  const admissionClasses =
    limits["admissionClasses"] === undefined
      ? undefined
      : parseAdmissionClasses(
          limits["admissionClasses"],
          `${field}.admissionClasses`,
        );
  if (admissionClasses !== undefined) {
    let protectedConcurrentTotal = 0;
    let protectedInFlightTokensTotal = 0;
    for (const [id, classLimits] of Object.entries(admissionClasses)) {
      protectedConcurrentTotal += classLimits.protectedConcurrent ?? 0;
      protectedInFlightTokensTotal +=
        classLimits.protectedInFlightTokens ?? 0;
      if (
        tokenBudget === undefined &&
        classLimits.protectedInFlightTokens !== undefined
      ) {
        throw new Error(
          `${field}.admissionClasses[${JSON.stringify(id)}].protectedInFlightTokens requires tokenBudget`,
        );
      }
      if (
        tokenBudget === undefined &&
        classLimits.maxInFlightTokens !== undefined
      ) {
        throw new Error(
          `${field}.admissionClasses[${JSON.stringify(id)}].maxInFlightTokens requires tokenBudget`,
        );
      }
    }
    if (protectedConcurrentTotal > maxConcurrent) {
      throw new Error(
        `${field}.admissionClasses protectedConcurrent sum must not exceed maxConcurrent`,
      );
    }
    if (
      tokenBudget !== undefined &&
      protectedInFlightTokensTotal > tokenBudget.budget
    ) {
      throw new Error(
        `${field}.admissionClasses protectedInFlightTokens sum must not exceed tokenBudget.budget`,
      );
    }
  }
  return {
    revision,
    maxConcurrent,
    maxQueue,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(admissionClasses === undefined ? {} : { admissionClasses }),
  };
}

function parseRegistration(value: unknown): RegistrationResponse {
  const registration = objectValue(value, "registration response");
  return {
    agentToken: stringValue(
      registration["agentToken"],
      "registration response.agentToken",
    ),
    controllerEpoch: integerValue(
      registration["controllerEpoch"],
      "registration response.controllerEpoch",
      1,
    ),
  };
}

function parseDesiredState(
  value: unknown,
  expectedInstanceId: string,
  managedPools: ReadonlySet<string>,
): AgentDesiredState {
  const state = objectValue(value, "desired-state response");
  const controllerEpoch = integerValue(
    state["controllerEpoch"],
    "desired-state response.controllerEpoch",
    1,
  );
  const serverTime = timestampValue(
    state["serverTime"],
    "desired-state response.serverTime",
  );
  const heartbeatIntervalMs = integerValue(
    state["heartbeatIntervalMs"],
    "desired-state response.heartbeatIntervalMs",
    1,
  );
  const pollIntervalMs = integerValue(
    state["pollIntervalMs"],
    "desired-state response.pollIntervalMs",
    1,
  );
  const rawGrants = state["grants"];
  if (!Array.isArray(rawGrants)) {
    throw new Error("desired-state response.grants must be an array");
  }

  const seenPools = new Set<string>();
  const grants = rawGrants.map((value, index): CapacityGrant => {
    const field = `desired-state response.grants[${index}]`;
    const raw = objectValue(value, field);
    const instanceId = stringValue(raw["instanceId"], `${field}.instanceId`);
    if (instanceId !== expectedInstanceId) {
      throw new Error(
        `${field}.instanceId must equal configured instance ${expectedInstanceId}`,
      );
    }
    const pool = stringValue(raw["pool"], `${field}.pool`);
    if (!managedPools.has(pool)) {
      throw new Error(`${field}.pool references unmanaged Tyr pool ${pool}`);
    }
    if (seenPools.has(pool)) {
      throw new Error(`desired-state response contains duplicate grant for pool ${pool}`);
    }
    seenPools.add(pool);

    const grantEpoch = integerValue(
      raw["controllerEpoch"],
      `${field}.controllerEpoch`,
      1,
    );
    if (grantEpoch !== controllerEpoch) {
      throw new Error(`${field}.controllerEpoch must match desired-state epoch`);
    }
    const revision = integerValue(raw["revision"], `${field}.revision`, 1);
    const limits = parseLimits(raw["limits"], `${field}.limits`);
    if (limits.revision !== revision) {
      throw new Error(`${field}.limits.revision must equal grant revision`);
    }
    const issuedAt = timestampValue(raw["issuedAt"], `${field}.issuedAt`);
    const expiresAt = timestampValue(raw["expiresAt"], `${field}.expiresAt`);
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new Error(`${field}.expiresAt must be after issuedAt`);
    }
    return {
      grantId: stringValue(raw["grantId"], `${field}.grantId`),
      instanceId,
      pool,
      controllerEpoch: grantEpoch,
      revision,
      issuedAt,
      expiresAt,
      limits,
    };
  });

  return {
    controllerEpoch,
    serverTime,
    heartbeatIntervalMs,
    pollIntervalMs,
    grants,
  };
}

function admissionClassesEqual(
  left: LLMAdmissionLimits["admissionClasses"],
  right: TyrAdmissionLimits["admissionClasses"],
): boolean {
  // A grant that omits classes carries no opinion about them, so it cannot
  // conflict with what is applied locally. Only a present-and-different table
  // is a content conflict.
  if (right === undefined) return true;
  if (left === undefined) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => {
    const leftLimits = left[key];
    const rightLimits = right[key];
    return (
      leftLimits?.protectedConcurrent === rightLimits?.protectedConcurrent &&
      leftLimits?.maxConcurrent === rightLimits?.maxConcurrent &&
      leftLimits?.protectedInFlightTokens ===
        rightLimits?.protectedInFlightTokens &&
      leftLimits?.maxInFlightTokens === rightLimits?.maxInFlightTokens
    );
  });
}

function limitsEqual(
  left: LLMAdmissionLimits,
  right: TyrAdmissionLimits,
): boolean {
  return (
    left.revision === right.revision &&
    left.maxConcurrent === right.maxConcurrent &&
    left.maxQueue === right.maxQueue &&
    left.tokenBudget?.budget === right.tokenBudget?.budget &&
    left.tokenBudget?.highPriorityReserve ===
      right.tokenBudget?.highPriorityReserve &&
    (right.admissionClasses === undefined ||
      admissionClassesEqual(left.admissionClasses, right.admissionClasses))
  );
}

/**
 * Decides which admission-class table to apply for one grant.
 *
 * `validateLimitSnapshot` throws rather than returning a rejection when the
 * class keys do not line up, and a throw out of `applyLimits` would leave the
 * grant unacked until the expiration kill switch zeroes the pool. So every
 * mismatch is caught here and surfaced as an ordinary ack rejection instead.
 */
function resolveGrantAdmissionClasses(
  applied: LLMAdmissionLimits,
  grant: CapacityGrant,
  fallbackAdmissionClasses?: LLMAdmissionLimits["admissionClasses"],
):
  | { readonly ok: true; readonly admissionClasses?: LLMAdmissionLimits["admissionClasses"] }
  | { readonly ok: false; readonly reason: string } {
  const granted = grant.limits.admissionClasses;
  const local = applied.admissionClasses;
  const fallback = fallbackAdmissionClasses ?? local;

  // No classes anywhere: nothing to reconcile.
  if (granted === undefined && fallback === undefined) return { ok: true };

  // Control plane predates class-aware allocation, or simply has no class
  // policy for this pool. Keep enforcing the last non-expiration class table.
  // The separate fallback matters after a lease kill switch has temporarily
  // zeroed protected floors to satisfy the zero physical envelope.
  if (granted === undefined) return { ok: true, admissionClasses: fallback };

  // The pool is not class-configured, so the bulkhead would reject the table
  // outright. Applying it is impossible; say so rather than crashing.
  if (fallback === undefined) {
    return { ok: false, reason: "admission_classes_not_configured" };
  }

  const localKeys = Object.keys(fallback).sort();
  const grantedKeys = Object.keys(granted).sort();
  if (
    localKeys.length !== grantedKeys.length ||
    localKeys.some((key, index) => key !== grantedKeys[index])
  ) {
    return { ok: false, reason: "admission_class_key_mismatch" };
  }
  return { ok: true, admissionClasses: granted };
}

function failClosedAdmissionClasses(
  admissionClasses: NonNullable<LLMAdmissionLimits["admissionClasses"]>,
): NonNullable<LLMAdmissionLimits["admissionClasses"]> {
  const closed: Record<string, TyrAdmissionClassLimits> = {};
  for (const [id, limits] of Object.entries(admissionClasses)) {
    closed[id] = Object.freeze({
      ...(limits.protectedConcurrent === undefined
        ? {}
        : { protectedConcurrent: 0 }),
      ...(limits.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: limits.maxConcurrent }),
      ...(limits.protectedInFlightTokens === undefined
        ? {}
        : { protectedInFlightTokens: 0 }),
      ...(limits.maxInFlightTokens === undefined
        ? {}
        : { maxInFlightTokens: limits.maxInFlightTokens }),
    });
  }
  return Object.freeze(closed);
}

function grantUpdate(
  grant: CapacityGrant,
  revision = grant.revision,
  admissionClasses?: LLMAdmissionLimits["admissionClasses"],
): PoolLimitsUpdate {
  return {
    pool: grant.pool,
    limits: {
      revision,
      maxConcurrent: grant.limits.maxConcurrent,
      maxQueue: grant.limits.maxQueue,
      ...(grant.limits.tokenBudget === undefined
        ? {}
        : { tokenBudget: grant.limits.tokenBudget }),
      ...(admissionClasses === undefined ? {} : { admissionClasses }),
    },
    provenance: Object.freeze({
      source: "latchflo",
      grantId: grant.grantId,
      controllerEpoch: grant.controllerEpoch,
      revision,
      expiresAt: grant.expiresAt,
    }),
  };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim() === "") return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Return the raw response when the control plane did not produce JSON.
  }
  return text;
}

export class LatchfloTyrAgent {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #logger: Logger;
  readonly #managedPools: ReadonlySet<string>;
  readonly #requestTimeoutMs: number;
  readonly #retryIntervalMs: number;
  readonly #retryMaxIntervalMs: number;
  readonly #random: () => number;
  readonly #grants = new Map<string, CapacityGrant>();
  readonly #admissionClassFallbacks = new Map<
    string,
    NonNullable<LLMAdmissionLimits["admissionClasses"]>
  >();
  #agentToken: string | undefined;
  #registration: Promise<void> | undefined;
  #controllerEpoch: number | undefined;
  #controlPlaneClock:
    | { readonly serverTimeMs: number; readonly observedAtMs: number }
    | undefined;
  #heartbeatIntervalMs = 5_000;
  #pollIntervalMs = 2_000;
  #heartbeatFailures = 0;
  #pollFailures = 0;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #expirationTimer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #ready = false;

  constructor(private readonly options: LatchfloTyrAgentOptions) {
    if (options.pools.length === 0) {
      throw new Error("at least one Tyr pool is required");
    }
    if (new Set(options.pools).size !== options.pools.length) {
      throw new Error("managed Tyr pools must not contain duplicates");
    }
    this.#baseUrl = withoutTrailingSlash(options.controlPlaneUrl);
    this.#agentToken = options.agentToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger = options.logger ?? console;
    this.#managedPools = new Set(options.pools);
    const initialLimits = options.control.limits();
    for (const pool of options.pools) {
      const classes = initialLimits[pool]?.admissionClasses;
      if (classes !== undefined) this.#admissionClassFallbacks.set(pool, classes);
    }
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#retryIntervalMs = options.retryIntervalMs ?? 1_000;
    this.#retryMaxIntervalMs = options.retryMaxIntervalMs ?? 30_000;
    this.#random = options.random ?? Math.random;
    if (this.#requestTimeoutMs < 1) {
      throw new Error("requestTimeoutMs must be positive");
    }
    if (this.#retryIntervalMs < 1) {
      throw new Error("retryIntervalMs must be positive");
    }
    if (this.#retryMaxIntervalMs < this.#retryIntervalMs) {
      throw new Error("retryMaxIntervalMs must be >= retryIntervalMs");
    }
  }

  ready(): boolean {
    return this.#ready;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.#ensureRegistered();
      await this.#poll();
      this.#heartbeatFailures = 0;
      this.#pollFailures = 0;
      // Publish the first demand snapshot immediately after the initial grant
      // poll. Subsequent heartbeats use the control-plane cadence and jitter.
      this.#scheduleHeartbeat(1);
      this.#schedulePoll(jitteredInterval(this.#pollIntervalMs, this.#random));
    } catch (error) {
      this.#running = false;
      throw error;
    }
  }

  stop(): void {
    this.#running = false;
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    if (this.#expirationTimer !== undefined) clearTimeout(this.#expirationTimer);
    this.#heartbeatTimer = undefined;
    this.#pollTimer = undefined;
    this.#expirationTimer = undefined;
    this.#setReady(false);
  }

  async pollNow(): Promise<void> {
    await this.#ensureRegistered();
    await this.#poll();
  }

  async heartbeatNow(): Promise<void> {
    await this.#ensureRegistered();
    await this.#heartbeat();
  }

  async #ensureRegistered(): Promise<void> {
    if (this.#agentToken !== undefined) return;
    if (this.#registration === undefined) {
      this.#registration = this.#register().finally(() => {
        this.#registration = undefined;
      });
    }
    await this.#registration;
  }

  async #register(): Promise<void> {
    if (this.options.bootstrapToken === undefined) {
      throw new LatchfloRequestError(
        "bootstrap token is required when no persisted agent token is available",
        false,
      );
    }
    let response: Response;
    try {
      response = await this.#request(`${this.#baseUrl}/v1/agents/register`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.bootstrapToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          instanceId: this.options.instanceId,
          pools: this.options.pools,
          metadata: this.options.metadata ?? {},
          // Latchflo 0.7+ refuses to enrol an agent into a pool carrying
          // admissionClassLimits unless it declares that it can apply the
          // per-replica class partition. Tyr consumes grant-borne class
          // limits (see resolveGrantAdmissionClasses), so this is truthful.
          // `admissionClassDemand` means heartbeats may also carry bounded
          // per-class demand snapshots. Latchflo 0.8.x ignores unknown
          // capability and heartbeat fields, preserving wire compatibility.
          capabilities: {
            admissionClasses: true,
            admissionClassDemand: true,
          },
        }),
      });
    } catch (error) {
      throw normalizeRequestError(error, "agent registration");
    }
    if (!response.ok) throw await responseError("agent registration", response);
    let registration: RegistrationResponse;
    try {
      registration = parseRegistration(await response.json());
    } catch (error) {
      throw protocolError(error, "agent registration response");
    }

    // The token Latchflo just issued is usable in memory regardless of
    // whether it can be durably persisted. A local disk failure below must
    // not be treated like a failed registration: that would discard a
    // valid credential and force a fresh registration call to Latchflo on
    // every retry purely because of a filesystem problem.
    this.#agentToken = registration.agentToken;
    this.#controllerEpoch = registration.controllerEpoch;
    this.#logger.info(
      `registered Tyr instance ${this.options.instanceId} with Latchflo controller epoch ${registration.controllerEpoch}`,
    );

    try {
      await this.options.onAgentToken?.(registration.agentToken);
    } catch (error) {
      reportFailure(this.options.onFailure, {
        operation: "persist",
        reason: "persist_error",
      });
      this.#logger.error(
        "failed to persist the rotated Latchflo agent token; it remains valid for this process, but a restart will require the bootstrap token again",
        error,
      );
    }
  }

  async #refreshAuthorization(staleToken: string): Promise<void> {
    if (this.#agentToken !== staleToken) return;
    this.#agentToken = undefined;
    await this.#ensureRegistered();
  }

  async #heartbeat(): Promise<void> {
    const demand = await this.options.demandProvider?.();
    const response = await this.#authorizedFetch(
      `/v1/agents/${encodeURIComponent(this.options.instanceId)}/heartbeat`,
      {
        method: "POST",
        ...(demand === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ demand }),
            }),
      },
    );
    if (!response.ok) throw await responseError("heartbeat", response);
    this.options.onDemandAccepted?.();
  }

  async #poll(): Promise<void> {
    const response = await this.#authorizedFetch(
      `/v1/agents/${encodeURIComponent(this.options.instanceId)}/desired-state`,
    );
    if (!response.ok) throw await responseError("desired-state poll", response);
    let state: AgentDesiredState;
    try {
      state = parseDesiredState(
        await response.json(),
        this.options.instanceId,
        this.#managedPools,
      );
    } catch (error) {
      throw protocolError(error, "desired-state response");
    }
    const observedAtMs = Date.now();
    this.#controlPlaneClock = {
      serverTimeMs: Date.parse(state.serverTime),
      observedAtMs,
    };
    this.#heartbeatIntervalMs = state.heartbeatIntervalMs;
    this.#pollIntervalMs = state.pollIntervalMs;
    if (
      this.#controllerEpoch !== undefined &&
      state.controllerEpoch < this.#controllerEpoch
    ) {
      throw new LatchfloRequestError(
        `stale controller epoch ${state.controllerEpoch}; already observed ${this.#controllerEpoch}`,
        true,
      );
    }
    this.#controllerEpoch = state.controllerEpoch;
    await this.#applyDesiredState(state);
  }

  async #applyDesiredState(state: AgentDesiredState): Promise<void> {
    const desiredByPool = new Map(
      state.grants.map((grant) => [grant.pool, grant]),
    );
    const missingPools = this.options.pools.filter(
      (pool) => !desiredByPool.has(pool),
    );
    if (missingPools.length > 0) {
      this.#setReady(this.#hasCompleteUnexpiredGrantSet());
      this.#scheduleExpiration();
      return;
    }

    const expired = state.grants.filter(
      (grant) => Date.parse(grant.expiresAt) <= this.#effectiveNow(),
    );
    if (expired.length > 0) {
      for (const grant of expired) {
        await this.#ack(grant, "rejected", "grant_expired");
      }
      this.#setReady(this.#hasCompleteUnexpiredGrantSet());
      this.#scheduleExpiration();
      return;
    }

    const current = this.options.control.limits();
    const updates: PoolLimitsUpdate[] = [];
    for (const grant of state.grants) {
      const applied = current[grant.pool];
      if (applied === undefined) {
        await this.#ack(grant, "rejected", "unknown_pool");
        this.#setReady(false);
        return;
      }
      if (applied.revision > grant.revision) {
        await this.#ack(grant, "rejected", "local_revision_ahead");
        this.#setReady(false);
        return;
      }
      if (applied.revision === grant.revision) {
        if (!limitsEqual(applied, grant.limits)) {
          await this.#ack(grant, "rejected", "revision_content_conflict");
          this.#setReady(false);
          return;
        }
        continue;
      }
      const classes = resolveGrantAdmissionClasses(
        applied,
        grant,
        this.#admissionClassFallbacks.get(grant.pool),
      );
      if (!classes.ok) {
        await this.#ack(grant, "rejected", classes.reason);
        this.#setReady(false);
        return;
      }
      updates.push(
        grantUpdate(grant, grant.revision, classes.admissionClasses),
      );
    }

    if (updates.length > 0) {
      const result = this.options.control.applyLimits(updates);
      if (!result.applied) {
        for (const grant of state.grants) {
          await this.#ack(grant, "rejected", `${result.reason}:${result.pool}`);
        }
        this.#setReady(false);
        return;
      }
      for (const [pool, appliedPool] of Object.entries(result.pools)) {
        const classes = appliedPool.current.admissionClasses;
        if (classes !== undefined) {
          this.#admissionClassFallbacks.set(pool, classes);
        }
      }
    }

    this.#grants.clear();
    for (const grant of state.grants) {
      this.#grants.set(grant.pool, grant);
      await this.#ack(grant, "applied");
    }
    this.#setReady(this.#hasCompleteUnexpiredGrantSet());
    this.#scheduleExpiration();
  }

  async #ack(
    grant: CapacityGrant,
    status: "applied" | "rejected",
    reason?: string,
  ): Promise<void> {
    try {
      const response = await this.#authorizedFetch(
        `/v1/agents/${encodeURIComponent(this.options.instanceId)}/ack`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grantId: grant.grantId,
            controllerEpoch: grant.controllerEpoch,
            revision: grant.revision,
            status,
            ...(reason === undefined ? {} : { reason }),
          }),
        },
      );
      if (!response.ok) {
        reportFailure(this.options.onFailure, { operation: "ack", reason: "http_error" });
        this.#logger.warn(
          `grant acknowledgement failed: ${await readError(response)}`,
        );
      }
    } catch (error) {
      // Acknowledgement delivery is best-effort. Local lease enforcement and
      // expiration scheduling must still complete after limits were applied.
      reportFailure(this.options.onFailure, {
        operation: "ack",
        reason: "transport_error",
      });
      this.#logger.warn("grant acknowledgement failed", error);
    }
  }

  #scheduleHeartbeat(delayMs: number): void {
    if (!this.#running) return;
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(() => {
      void this.#runHeartbeatLoop();
    }, delayMs);
    this.#heartbeatTimer.unref?.();
  }

  async #runHeartbeatLoop(): Promise<void> {
    try {
      await this.#heartbeat();
      this.#heartbeatFailures = 0;
      this.#scheduleHeartbeat(
        jitteredInterval(this.#heartbeatIntervalMs, this.#random),
      );
    } catch (error) {
      const requestError = normalizeRequestError(error, "Latchflo heartbeat");
      reportFailure(this.options.onFailure, {
        operation: "heartbeat",
        reason: requestError.retryable ? "retryable" : "permanent",
      });
      const delayMs = backoffDelay({
        baseMs: this.#retryIntervalMs,
        maxMs: this.#retryMaxIntervalMs,
        attempt: this.#heartbeatFailures,
        random: this.#random,
        ...(requestError.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: requestError.retryAfterMs }),
      });
      this.#heartbeatFailures += 1;
      // A non-retryable status is retried too: the control plane can become
      // reachable again without a Tyr restart, and giving up forever would
      // strand readiness on a stale in-process decision.
      if (requestError.retryable) {
        this.#logger.warn(
          `Latchflo heartbeat failed; retry=${this.#heartbeatFailures} delayMs=${delayMs}`,
          requestError,
        );
      } else {
        this.#logger.error(
          `Latchflo heartbeat failed with a non-retryable status; retrying anyway with backoff; retry=${this.#heartbeatFailures} delayMs=${delayMs}`,
          requestError,
        );
      }
      this.#scheduleHeartbeat(delayMs);
    }
  }

  #schedulePoll(delayMs: number): void {
    if (!this.#running) return;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = setTimeout(() => {
      void this.#runPollLoop();
    }, delayMs);
    this.#pollTimer.unref?.();
  }

  async #runPollLoop(): Promise<void> {
    try {
      await this.#poll();
      this.#pollFailures = 0;
      this.#schedulePoll(jitteredInterval(this.#pollIntervalMs, this.#random));
    } catch (error) {
      this.#setReady(this.#hasCompleteUnexpiredGrantSet());
      const requestError = normalizeRequestError(
        error,
        "Latchflo desired-state poll",
      );
      reportFailure(this.options.onFailure, {
        operation: "poll",
        reason: requestError.retryable ? "retryable" : "permanent",
      });
      const delayMs = backoffDelay({
        baseMs: this.#retryIntervalMs,
        maxMs: this.#retryMaxIntervalMs,
        attempt: this.#pollFailures,
        random: this.#random,
        ...(requestError.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: requestError.retryAfterMs }),
      });
      this.#pollFailures += 1;
      // A non-retryable status is retried too: existing grants remain
      // enforced until they expire, and the control plane can become
      // reachable again without a Tyr restart.
      if (requestError.retryable) {
        this.#logger.warn(
          `Latchflo desired-state poll failed; retry=${this.#pollFailures} delayMs=${delayMs}`,
          requestError,
        );
      } else {
        this.#logger.error(
          `Latchflo desired-state poll failed with a non-retryable status; retrying anyway with backoff; retry=${this.#pollFailures} delayMs=${delayMs}`,
          requestError,
        );
      }
      this.#schedulePoll(delayMs);
    }
  }

  #effectiveNow(): number {
    const localNow = Date.now();
    if (this.#controlPlaneClock === undefined) return localNow;
    const estimatedControlPlaneNow =
      this.#controlPlaneClock.serverTimeMs +
      (localNow - this.#controlPlaneClock.observedAtMs);
    return Math.max(localNow, estimatedControlPlaneNow);
  }

  #scheduleExpiration(): void {
    if (this.#expirationTimer !== undefined) clearTimeout(this.#expirationTimer);
    if (this.#grants.size === 0) return;
    const earliest = Math.min(
      ...[...this.#grants.values()].map((grant) => Date.parse(grant.expiresAt)),
    );
    const delay = Math.max(0, earliest - this.#effectiveNow());
    this.#expirationTimer = setTimeout(
      () => this.#failClosedExpiredGrants(),
      Math.min(delay, 2_147_483_647),
    );
    this.#expirationTimer.unref?.();
  }

  #failClosedExpiredGrants(): void {
    const now = this.#effectiveNow();
    const expired = [...this.#grants.values()].filter(
      (grant) => Date.parse(grant.expiresAt) <= now,
    );
    if (expired.length === 0) {
      this.#scheduleExpiration();
      return;
    }
    const current = this.options.control.limits();
    const updates: PoolLimitsUpdate[] = expired.map((grant) => {
      const update = grantUpdate(
        grant,
        grant.revision + 1,
        current[grant.pool]?.admissionClasses,
      );
      return {
        ...update,
        limits: {
          revision: grant.revision + 1,
          maxConcurrent: 0,
          maxQueue: 0,
          ...(grant.limits.tokenBudget === undefined
            ? {}
            : { tokenBudget: { budget: 0, highPriorityReserve: 0 } }),
          ...(update.limits.admissionClasses === undefined
            ? {}
            : {
                admissionClasses: failClosedAdmissionClasses(
                  update.limits.admissionClasses,
                ),
              }),
        },
      };
    });
    const result = this.options.control.applyLimits(updates);
    if (!result.applied) {
      reportFailure(this.options.onFailure, {
        operation: "expiration",
        reason: "apply_error",
      });
      this.#logger.error("failed to apply Latchflo expiration kill switch", result);
    } else {
      for (const grant of expired) this.#grants.delete(grant.pool);
      this.#logger.warn(
        `failed closed ${expired.length} Tyr pool(s) after Latchflo grants expired`,
      );
    }
    this.#setReady(false);
    this.#scheduleExpiration();
  }

  #hasCompleteUnexpiredGrantSet(): boolean {
    const now = this.#effectiveNow();
    return this.options.pools.every((pool) => {
      const grant = this.#grants.get(pool);
      return grant !== undefined && Date.parse(grant.expiresAt) > now;
    });
  }

  #setReady(ready: boolean): void {
    if (this.#ready === ready) return;
    this.#ready = ready;
    this.options.onReadyChange?.(ready);
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    timeout.unref?.();
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #authorizedFetch(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    await this.#ensureRegistered();
    const token = this.#agentToken;
    if (token === undefined) throw new Error("Latchflo agent is not registered");

    const request = (authorization: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${authorization}`);
      return this.#request(`${this.#baseUrl}${path}`, { ...init, headers });
    };

    let response = await request(token);
    if (response.status === 401) {
      if (this.options.bootstrapToken !== undefined) {
        await this.#refreshAuthorization(token);
        const refreshed = this.#agentToken;
        if (refreshed !== undefined && refreshed !== token) {
          response = await request(refreshed);
        }
      } else if (this.#agentToken === token) {
        // Latchflo rejected the persisted token and there is no bootstrap
        // token to re-register with. Discard the known-bad token so the
        // next attempt fails fast with the clear "bootstrap token is
        // required" message instead of repeating the same doomed request
        // against Latchflo forever.
        this.#agentToken = undefined;
      }
    }
    return response;
  }
}

function readPersistedAgentToken(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    const value = readFileSync(path, "utf8").trim();
    if (value.length === 0) {
      throw new Error(`persisted Latchflo agent token file is empty: ${path}`);
    }
    return value;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function persistAgentToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${token}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function createLatchfloManagedMode(options: {
  readonly config: LatchfloRuntimeConfig;
  readonly control: TyrControlPlane;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly random?: () => number;
  readonly logger?: Logger;
  readonly onFailure?: (event: {
    operation: LatchfloFailureOperation;
    reason: LatchfloFailureReason;
  }) => void;
}): LatchfloManagedMode {
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;
  const persistedToken = readPersistedAgentToken(options.config.agentTokenFile);
  const bootstrapToken = env[options.config.bootstrapTokenEnv]?.trim() || undefined;
  const demandReporter = new TyrDemandReporter(
    options.control,
    options.config.pools,
  );
  const agent = new LatchfloTyrAgent({
    controlPlaneUrl: options.config.url,
    instanceId: options.config.instanceId,
    pools: options.config.pools,
    ...(options.config.metadata === undefined
      ? {}
      : { metadata: options.config.metadata }),
    ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
    ...(persistedToken === undefined ? {} : { agentToken: persistedToken }),
    control: options.control,
    demandProvider: () => demandReporter.capture(),
    onDemandAccepted: () => demandReporter.commit(),
    requestTimeoutMs: options.config.requestTimeoutMs,
    retryIntervalMs: options.config.retryIntervalMs,
    retryMaxIntervalMs: options.config.retryMaxIntervalMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.config.agentTokenFile === undefined
      ? {}
      : {
          onAgentToken: (token: string) =>
            persistAgentToken(options.config.agentTokenFile as string, token),
        }),
    logger,
    ...(options.onFailure === undefined
      ? {}
      : { onFailure: options.onFailure }),
  });

  let stopped = false;
  let starting = false;
  let started = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function retryDelay(error: LatchfloRequestError): number {
    return backoffDelay({
      baseMs: options.config.retryIntervalMs,
      maxMs: options.config.retryMaxIntervalMs,
      attempt: retryAttempt,
      random: options.random ?? Math.random,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    });
  }

  function scheduleRetry(error: LatchfloRequestError): void {
    if (stopped || started) return;
    const delayMs = retryDelay(error);
    retryAttempt += 1;
    // A non-retryable status is retried too: Tyr remains healthy but
    // unready and managed pools remain closed while it keeps trying,
    // rather than requiring a manual restart once the control plane
    // recovers.
    if (error.retryable) {
      logger.warn(
        `Latchflo managed mode is not connected; retry=${retryAttempt} delayMs=${delayMs}`,
        error,
      );
    } else {
      logger.error(
        `Latchflo managed mode is not connected (non-retryable status; retrying anyway with backoff); retry=${retryAttempt} delayMs=${delayMs}`,
        error,
      );
    }
    retryTimer = setTimeout(() => attemptStart(), delayMs);
    retryTimer.unref?.();
  }

  function attemptStart(): void {
    if (stopped || starting || started) return;
    starting = true;
    void agent
      .start()
      .then(() => {
        started = true;
        retryAttempt = 0;
      })
      .catch((error: unknown) => {
        const requestError = normalizeRequestError(error, "Latchflo startup");
        reportFailure(options.onFailure, {
          operation: "startup",
          reason: requestError.retryable ? "retryable" : "permanent",
        });
        scheduleRetry(requestError);
      })
      .finally(() => {
        starting = false;
        if (stopped) agent.stop();
      });
  }

  return Object.freeze({
    ready: () => agent.ready(),
    start: () => {
      stopped = false;
      attemptStart();
    },
    stop: () => {
      stopped = true;
      started = false;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      agent.stop();
    },
  });
}
