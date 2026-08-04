import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type {
  LLMPriority,
  LLMReservationEstimate,
} from "async-bulkhead-llm";
import {
  MAX_ADMISSION_CLASSES,
  MAX_ADMISSION_IDENTIFIER_LENGTH,
  normalizeAdmissionClassId,
} from "./admission-policy.js";
import type { Pools, TyrPoolStats } from "./pools.js";

export const TYR_ROUTING_CAPACITY_PATH = "/_tyr/capacity";
export const TYR_ROUTING_TOKEN_HEADER = "x-tyr-routing-token";
export const TYR_ROUTING_HOP_HEADER = "x-tyr-routing-hop";
export const TYR_ROUTING_SOURCE_HEADER = "x-tyr-routing-source";
export const TYR_ROUTING_PRIORITY_HEADER = "x-tyr-routing-priority";
export const TYR_ROUTING_ADMISSION_CLASS_HEADER =
  "x-tyr-routing-admission-class";

export type CapacityRoutingPeer = Readonly<{
  id: string;
  baseUrl: string;
}>;

export type CapacityRoutingOptions = Readonly<{
  /** Stable local replica identifier used for deterministic tie-breaking. */
  instanceId: string;
  /** Shared secret used only on Tyr-to-Tyr routing and capacity requests. */
  sharedSecret: string;
  /** Static peers for this release. Latchflo may distribute this topology later. */
  peers: readonly CapacityRoutingPeer[];
  /** Peer snapshot refresh cadence. Default: 100ms. */
  pollIntervalMs?: number;
  /** Maximum peer snapshot age considered routable. Default: 1000ms. */
  staleAfterMs?: number;
  /** Deadline for one peer capacity poll. Default: 250ms. */
  probeTimeoutMs?: number;
  /** Deadline for a routed peer to return response headers. Default: 30000ms. */
  forwardTimeoutMs?: number;
}>;

export type RoutingAdmissionClassCapacity = Readonly<{
  inFlight: number;
  maxConcurrent: number | null;
  availableConcurrency: number | null;
  inFlightTokens: number;
  maxInFlightTokens: number | null;
  availableTokens: number | null;
}>;

export type RoutingPoolCapacity = Readonly<{
  revision: number;
  admissionMode: "enforce" | "observe";
  closed: boolean;
  maxConcurrent: number;
  inFlight: number;
  pending: number;
  maxQueue: number;
  availableConcurrency: number;
  tokenBudget?: Readonly<{
    budget: number;
    inFlightTokens: number;
    normalAvailable: number;
    highAvailable: number;
  }>;
  admissionClasses?: Readonly<{
    defaultClass: string;
    classes: Readonly<Record<string, RoutingAdmissionClassCapacity>>;
  }>;
}>;

export type RoutingCapacitySnapshot = Readonly<{
  schemaVersion: 1 | 2;
  instanceId: string;
  generatedAt: string;
  ready: boolean;
  pools: Readonly<Record<string, RoutingPoolCapacity>>;
}>;

export type CapacityCandidate = Readonly<{
  instanceId: string;
  local: boolean;
  baseUrl?: string;
  pool: RoutingPoolCapacity;
  admissible: boolean;
  concurrencyHeadroom: number;
  tokenHeadroom: number | null;
  admissionClass?: string;
  classConcurrencyHeadroom: number | null;
  classTokenHeadroom: number | null;
  score: number;
}>;

export type CapacityRoute = Readonly<{
  instanceId: string;
  local: boolean;
  baseUrl?: string;
  score: number;
}>;

export type InternalRouteClassification =
  | { kind: "external" }
  | { kind: "invalid" }
  | {
      kind: "internal";
      source: string;
      priority: LLMPriority;
      admissionClass?: string;
    };

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_STALE_AFTER_MS = 1_000;
const DEFAULT_PROBE_TIMEOUT_MS = 250;
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("capacity routing peer baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "capacity routing peer baseUrl must not contain credentials, query, or fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("capacity routing peer baseUrl must not contain a path");
  }
  return url.origin;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return resolved;
}

function poolCapacity(stats: TyrPoolStats): RoutingPoolCapacity {
  const maxConcurrent = stats.limits.maxConcurrent;
  const inFlight = stats.bulkhead.inFlight;
  const tokenBudget = stats.tokenBudget;
  let admissionClasses: RoutingPoolCapacity["admissionClasses"];
  if (stats.admissionClasses !== undefined) {
    const classes: Record<string, RoutingAdmissionClassCapacity> = {};
    for (const [id, state] of Object.entries(stats.admissionClasses.classes)) {
      const maxClassConcurrent = state.limits.maxConcurrent ?? null;
      const maxInFlightTokens = state.limits.maxInFlightTokens ?? null;
      classes[id] = Object.freeze({
        inFlight: state.inFlight,
        maxConcurrent: maxClassConcurrent,
        availableConcurrency:
          maxClassConcurrent === null
            ? null
            : Math.max(0, maxClassConcurrent - state.inFlight),
        inFlightTokens: state.inFlightTokens,
        maxInFlightTokens,
        availableTokens:
          maxInFlightTokens === null
            ? null
            : Math.max(0, maxInFlightTokens - state.inFlightTokens),
      });
    }
    admissionClasses = Object.freeze({
      defaultClass: stats.admissionClasses.defaultClass,
      classes: Object.freeze(classes),
    });
  }
  return Object.freeze({
    revision: stats.limits.revision,
    admissionMode: stats.tyr.admissionMode,
    closed: stats.bulkhead.closed,
    maxConcurrent,
    inFlight,
    pending: stats.bulkhead.pending,
    maxQueue: stats.limits.maxQueue,
    availableConcurrency: Math.max(0, maxConcurrent - inFlight),
    ...(tokenBudget === undefined
      ? {}
      : {
          tokenBudget: Object.freeze({
            budget: tokenBudget.budget,
            inFlightTokens: tokenBudget.inFlightTokens,
            normalAvailable: Math.max(0, tokenBudget.available),
            highAvailable: Math.max(
              0,
              tokenBudget.budget - tokenBudget.inFlightTokens,
            ),
          }),
        }),
    ...(admissionClasses === undefined ? {} : { admissionClasses }),
  });
}

export function buildCapacitySnapshot(input: {
  instanceId: string;
  ready: boolean;
  stats: Readonly<Record<string, TyrPoolStats>>;
  now?: Date;
}): RoutingCapacitySnapshot {
  const pools: Record<string, RoutingPoolCapacity> = {};
  for (const [name, stats] of Object.entries(input.stats)) {
    pools[name] = poolCapacity(stats);
  }
  return Object.freeze({
    schemaVersion: 2,
    instanceId: input.instanceId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    ready: input.ready,
    pools: Object.freeze(pools),
  });
}

function availableTokens(
  pool: RoutingPoolCapacity,
  priority: LLMPriority,
): number | null {
  if (pool.tokenBudget === undefined) return null;
  return priority === "high"
    ? pool.tokenBudget.highAvailable
    : pool.tokenBudget.normalAvailable;
}

function compatibleAdmissionClasses(
  local:
    | Readonly<{
        defaultClass: string;
        classes: Readonly<Record<string, unknown>>;
      }>
    | undefined,
  peer:
    | Readonly<{
        defaultClass: string;
        classes: Readonly<Record<string, unknown>>;
      }>
    | undefined,
): boolean {
  if (local === undefined || peer === undefined) return local === peer;
  if (local.defaultClass !== peer.defaultClass) return false;
  const localKeys = Object.keys(local.classes).sort();
  const peerKeys = Object.keys(peer.classes).sort();
  return (
    localKeys.length === peerKeys.length &&
    localKeys.every((key, index) => key === peerKeys[index])
  );
}

export function scoreCapacityCandidate(input: {
  instanceId: string;
  local: boolean;
  baseUrl?: string;
  pool: RoutingPoolCapacity;
  priority: LLMPriority;
  admissionClass?: string;
  reservation: LLMReservationEstimate | null;
}): CapacityCandidate {
  const concurrencyHeadroom = input.pool.availableConcurrency - 1;
  const available = availableTokens(input.pool, input.priority);
  const requested = input.reservation?.reserved ?? 0;
  const tokenHeadroom = available === null ? null : available - requested;

  const classState =
    input.admissionClass === undefined
      ? undefined
      : input.pool.admissionClasses?.classes[input.admissionClass];
  const classMissing =
    input.admissionClass !== undefined && classState === undefined;
  const classConcurrencyHeadroom =
    classState?.availableConcurrency === null || classState === undefined
      ? null
      : classState.availableConcurrency - 1;
  const classTokenHeadroom =
    classState?.availableTokens === null || classState === undefined
      ? null
      : classState.availableTokens - requested;

  const concurrencyAdmissible =
    input.pool.admissionMode === "enforce" &&
    !input.pool.closed &&
    input.pool.availableConcurrency > 0;
  const tokenAdmissible = tokenHeadroom === null || tokenHeadroom >= 0;
  const classConcurrencyAdmissible =
    classConcurrencyHeadroom === null || classConcurrencyHeadroom >= 0;
  const classTokenAdmissible =
    classTokenHeadroom === null || classTokenHeadroom >= 0;
  const admissible =
    !classMissing &&
    concurrencyAdmissible &&
    tokenAdmissible &&
    classConcurrencyAdmissible &&
    classTokenAdmissible;

  const concurrencyRatio =
    input.pool.maxConcurrent <= 0
      ? -1
      : concurrencyHeadroom / input.pool.maxConcurrent;
  const tokenRatio =
    input.pool.tokenBudget === undefined
      ? 1
      : tokenHeadroom! / Math.max(1, input.pool.tokenBudget.budget);
  const classConcurrencyRatio =
    classState?.maxConcurrent === null || classState === undefined
      ? 1
      : classConcurrencyHeadroom! / Math.max(1, classState.maxConcurrent);
  const classTokenRatio =
    classState?.maxInFlightTokens === null || classState === undefined
      ? 1
      : classTokenHeadroom! / Math.max(1, classState.maxInFlightTokens);

  return Object.freeze({
    instanceId: input.instanceId,
    local: input.local,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    pool: input.pool,
    admissible,
    concurrencyHeadroom,
    tokenHeadroom,
    ...(input.admissionClass === undefined
      ? {}
      : { admissionClass: input.admissionClass }),
    classConcurrencyHeadroom,
    classTokenHeadroom,
    score: admissible
      ? Math.min(
          concurrencyRatio,
          tokenRatio,
          classConcurrencyRatio,
          classTokenRatio,
        )
      : -1,
  });
}

function compareCandidates(left: CapacityCandidate, right: CapacityCandidate): number {
  if (left.admissible !== right.admissible) return left.admissible ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;

  const leftClassTokens = left.classTokenHeadroom ?? Number.POSITIVE_INFINITY;
  const rightClassTokens = right.classTokenHeadroom ?? Number.POSITIVE_INFINITY;
  if (leftClassTokens !== rightClassTokens) {
    return rightClassTokens - leftClassTokens;
  }
  const leftClassConcurrency =
    left.classConcurrencyHeadroom ?? Number.POSITIVE_INFINITY;
  const rightClassConcurrency =
    right.classConcurrencyHeadroom ?? Number.POSITIVE_INFINITY;
  if (leftClassConcurrency !== rightClassConcurrency) {
    return rightClassConcurrency - leftClassConcurrency;
  }
  const leftTokens = left.tokenHeadroom ?? Number.POSITIVE_INFINITY;
  const rightTokens = right.tokenHeadroom ?? Number.POSITIVE_INFINITY;
  if (leftTokens !== rightTokens) return rightTokens - leftTokens;
  if (left.concurrencyHeadroom !== right.concurrencyHeadroom) {
    return right.concurrencyHeadroom - left.concurrencyHeadroom;
  }
  // Avoid an extra network hop when capacity is otherwise indistinguishable.
  if (left.local !== right.local) return left.local ? -1 : 1;
  return left.instanceId.localeCompare(right.instanceId);
}

export function chooseCapacityCandidate(
  candidates: readonly CapacityCandidate[],
): CapacityCandidate | undefined {
  const admissible = candidates.filter((candidate) => candidate.admissible);
  if (admissible.length === 0) return undefined;
  return [...admissible].sort(compareCandidates)[0];
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function validatePoolCapacity(
  value: unknown,
  field: string,
): RoutingPoolCapacity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const pool = value as Partial<RoutingPoolCapacity>;
  const revision = nonNegativeSafeInteger(pool.revision, `${field}.revision`);
  if (pool.admissionMode !== "enforce" && pool.admissionMode !== "observe") {
    throw new Error(`${field}.admissionMode must be enforce or observe`);
  }
  if (typeof pool.closed !== "boolean") {
    throw new Error(`${field}.closed must be a boolean`);
  }
  const maxConcurrent = nonNegativeSafeInteger(
    pool.maxConcurrent,
    `${field}.maxConcurrent`,
  );
  const inFlight = nonNegativeSafeInteger(pool.inFlight, `${field}.inFlight`);
  const pending = nonNegativeSafeInteger(pool.pending, `${field}.pending`);
  const maxQueue = nonNegativeSafeInteger(pool.maxQueue, `${field}.maxQueue`);
  const availableConcurrency = nonNegativeSafeInteger(
    pool.availableConcurrency,
    `${field}.availableConcurrency`,
  );
  if (availableConcurrency > maxConcurrent) {
    throw new Error(`${field}.availableConcurrency exceeds maxConcurrent`);
  }

  let admissionClasses: RoutingPoolCapacity["admissionClasses"];
  if (pool.admissionClasses !== undefined) {
    if (
      typeof pool.admissionClasses !== "object" ||
      pool.admissionClasses === null ||
      Array.isArray(pool.admissionClasses)
    ) {
      throw new Error(`${field}.admissionClasses must be an object`);
    }
    const defaultClass = normalizeAdmissionClassId(
      pool.admissionClasses.defaultClass,
      `${field}.admissionClasses.defaultClass`,
    );
    const rawClasses = pool.admissionClasses.classes;
    if (
      typeof rawClasses !== "object" ||
      rawClasses === null ||
      Array.isArray(rawClasses)
    ) {
      throw new Error(`${field}.admissionClasses.classes must be an object`);
    }
    const entries = Object.entries(rawClasses);
    if (entries.length === 0 || entries.length > MAX_ADMISSION_CLASSES) {
      throw new Error(
        `${field}.admissionClasses.classes must contain between 1 and ${MAX_ADMISSION_CLASSES} classes`,
      );
    }
    const classes: Record<string, RoutingAdmissionClassCapacity> = {};
    for (const [rawId, rawState] of entries) {
      const id = normalizeAdmissionClassId(
        rawId,
        `${field}.admissionClasses class id`,
      );
      if (Object.hasOwn(classes, id)) {
        throw new Error(
          `${field}.admissionClasses contains duplicate normalized class ID ${JSON.stringify(id)}`,
        );
      }
      if (
        typeof rawState !== "object" ||
        rawState === null ||
        Array.isArray(rawState)
      ) {
        throw new Error(
          `${field}.admissionClasses.classes[${JSON.stringify(id)}] must be an object`,
        );
      }
      const classField = `${field}.admissionClasses.classes[${JSON.stringify(id)}]`;
      const state = rawState as Partial<RoutingAdmissionClassCapacity>;
      const classInFlight = nonNegativeSafeInteger(
        state.inFlight,
        `${classField}.inFlight`,
      );
      const classInFlightTokens = nonNegativeSafeInteger(
        state.inFlightTokens,
        `${classField}.inFlightTokens`,
      );
      const classMaxConcurrent =
        state.maxConcurrent === null
          ? null
          : nonNegativeSafeInteger(
              state.maxConcurrent,
              `${classField}.maxConcurrent`,
            );
      const classAvailableConcurrency =
        state.availableConcurrency === null
          ? null
          : nonNegativeSafeInteger(
              state.availableConcurrency,
              `${classField}.availableConcurrency`,
            );
      if (
        (classMaxConcurrent === null) !==
        (classAvailableConcurrency === null)
      ) {
        throw new Error(
          `${classField}.availableConcurrency must be null exactly when maxConcurrent is null`,
        );
      }
      if (
        classMaxConcurrent !== null &&
        classAvailableConcurrency !==
          Math.max(0, classMaxConcurrent - classInFlight)
      ) {
        throw new Error(`${classField}.availableConcurrency is inconsistent`);
      }
      const classMaxInFlightTokens =
        state.maxInFlightTokens === null
          ? null
          : nonNegativeSafeInteger(
              state.maxInFlightTokens,
              `${classField}.maxInFlightTokens`,
            );
      const classAvailableTokens =
        state.availableTokens === null
          ? null
          : nonNegativeSafeInteger(
              state.availableTokens,
              `${classField}.availableTokens`,
            );
      if (
        (classMaxInFlightTokens === null) !== (classAvailableTokens === null)
      ) {
        throw new Error(
          `${classField}.availableTokens must be null exactly when maxInFlightTokens is null`,
        );
      }
      if (
        classMaxInFlightTokens !== null &&
        classAvailableTokens !==
          Math.max(0, classMaxInFlightTokens - classInFlightTokens)
      ) {
        throw new Error(`${classField}.availableTokens is inconsistent`);
      }
      classes[id] = Object.freeze({
        inFlight: classInFlight,
        maxConcurrent: classMaxConcurrent,
        availableConcurrency: classAvailableConcurrency,
        inFlightTokens: classInFlightTokens,
        maxInFlightTokens: classMaxInFlightTokens,
        availableTokens: classAvailableTokens,
      });
    }
    if (!Object.hasOwn(classes, defaultClass)) {
      throw new Error(
        `${field}.admissionClasses.defaultClass must reference a configured class`,
      );
    }
    admissionClasses = Object.freeze({
      defaultClass,
      classes: Object.freeze(classes),
    });
  }

  let tokenBudget: RoutingPoolCapacity["tokenBudget"];
  if (pool.tokenBudget !== undefined) {
    if (
      typeof pool.tokenBudget !== "object" ||
      pool.tokenBudget === null ||
      Array.isArray(pool.tokenBudget)
    ) {
      throw new Error(`${field}.tokenBudget must be an object`);
    }
    const budget = nonNegativeSafeInteger(
      pool.tokenBudget.budget,
      `${field}.tokenBudget.budget`,
    );
    const inFlightTokens = nonNegativeSafeInteger(
      pool.tokenBudget.inFlightTokens,
      `${field}.tokenBudget.inFlightTokens`,
    );
    const normalAvailable = nonNegativeSafeInteger(
      pool.tokenBudget.normalAvailable,
      `${field}.tokenBudget.normalAvailable`,
    );
    const highAvailable = nonNegativeSafeInteger(
      pool.tokenBudget.highAvailable,
      `${field}.tokenBudget.highAvailable`,
    );
    if (normalAvailable > highAvailable || highAvailable > budget) {
      throw new Error(`${field}.tokenBudget availability is inconsistent`);
    }
    tokenBudget = Object.freeze({
      budget,
      inFlightTokens,
      normalAvailable,
      highAvailable,
    });
  }

  return Object.freeze({
    revision,
    admissionMode: pool.admissionMode,
    closed: pool.closed,
    maxConcurrent,
    inFlight,
    pending,
    maxQueue,
    availableConcurrency,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(admissionClasses === undefined ? {} : { admissionClasses }),
  });
}

function validateSnapshot(
  value: unknown,
  expectedInstanceId: string,
): RoutingCapacitySnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capacity snapshot must be an object");
  }
  const snapshot = value as Partial<RoutingCapacitySnapshot>;
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2) {
    throw new Error("unsupported capacity snapshot schemaVersion");
  }
  if (snapshot.instanceId !== expectedInstanceId) {
    throw new Error(
      `capacity snapshot instance mismatch: expected ${expectedInstanceId}`,
    );
  }
  if (typeof snapshot.ready !== "boolean") {
    throw new Error("capacity snapshot ready must be a boolean");
  }
  if (
    typeof snapshot.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))
  ) {
    throw new Error("capacity snapshot generatedAt must be an ISO timestamp");
  }
  if (
    typeof snapshot.pools !== "object" ||
    snapshot.pools === null ||
    Array.isArray(snapshot.pools)
  ) {
    throw new Error("capacity snapshot pools must be an object");
  }
  const pools: Record<string, RoutingPoolCapacity> = {};
  for (const [name, pool] of Object.entries(snapshot.pools)) {
    if (name.trim().length === 0) {
      throw new Error("capacity snapshot pool names must be non-empty");
    }
    pools[name] = validatePoolCapacity(pool, `capacity snapshot pools.${name}`);
  }
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    instanceId: expectedInstanceId,
    generatedAt: snapshot.generatedAt,
    ready: snapshot.ready,
    pools: Object.freeze(pools),
  });
}

type CachedPeer = {
  peer: CapacityRoutingPeer;
  snapshot?: RoutingCapacitySnapshot;
  refreshedAtMs?: number;
};

export class CapacityAwareRouter {
  readonly instanceId: string;
  readonly sharedSecret: string;
  readonly pollIntervalMs: number;
  readonly staleAfterMs: number;
  readonly probeTimeoutMs: number;
  readonly forwardTimeoutMs: number;

  readonly #pools: Pools;
  readonly #ready: () => boolean;
  readonly #peers: Map<string, CachedPeer>;
  #interval: ReturnType<typeof setInterval> | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(input: {
    options: CapacityRoutingOptions;
    pools: Pools;
    ready: () => boolean;
  }) {
    const instanceId = input.options.instanceId.trim();
    const sharedSecret = input.options.sharedSecret;
    if (instanceId.length === 0) {
      throw new Error("capacity routing instanceId must be non-empty");
    }
    if (sharedSecret.length < 16) {
      throw new Error("capacity routing sharedSecret must be at least 16 characters");
    }

    this.instanceId = instanceId;
    this.sharedSecret = sharedSecret;
    this.pollIntervalMs = positiveInteger(
      input.options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "capacity routing pollIntervalMs",
    );
    this.staleAfterMs = positiveInteger(
      input.options.staleAfterMs,
      DEFAULT_STALE_AFTER_MS,
      "capacity routing staleAfterMs",
    );
    this.probeTimeoutMs = positiveInteger(
      input.options.probeTimeoutMs,
      DEFAULT_PROBE_TIMEOUT_MS,
      "capacity routing probeTimeoutMs",
    );
    this.forwardTimeoutMs = positiveInteger(
      input.options.forwardTimeoutMs,
      DEFAULT_FORWARD_TIMEOUT_MS,
      "capacity routing forwardTimeoutMs",
    );
    if (this.staleAfterMs < this.pollIntervalMs) {
      throw new Error(
        "capacity routing staleAfterMs must be >= pollIntervalMs",
      );
    }

    this.#pools = input.pools;
    this.#ready = input.ready;
    this.#peers = new Map();
    for (const configured of input.options.peers) {
      const id = configured.id.trim();
      if (id.length === 0) {
        throw new Error("capacity routing peer id must be non-empty");
      }
      if (id === instanceId) {
        throw new Error("capacity routing peers must not include the local instanceId");
      }
      if (this.#peers.has(id)) {
        throw new Error(`duplicate capacity routing peer id: ${id}`);
      }
      this.#peers.set(id, {
        peer: Object.freeze({ id, baseUrl: normalizeBaseUrl(configured.baseUrl) }),
      });
    }
  }

  start(): void {
    if (this.#interval !== undefined || this.#peers.size === 0) return;
    void this.refresh();
    this.#interval = setInterval(() => void this.refresh(), this.pollIntervalMs);
    this.#interval.unref();
  }

  stop(): void {
    if (this.#interval !== undefined) clearInterval(this.#interval);
    this.#interval = undefined;
  }

  snapshot(): RoutingCapacitySnapshot {
    return buildCapacitySnapshot({
      instanceId: this.instanceId,
      ready: this.#ready(),
      stats: this.#pools.stats(),
    });
  }

  classify(req: IncomingMessage): InternalRouteClassification {
    const hasAnyRoutingHeader = [
      TYR_ROUTING_TOKEN_HEADER,
      TYR_ROUTING_HOP_HEADER,
      TYR_ROUTING_SOURCE_HEADER,
      TYR_ROUTING_PRIORITY_HEADER,
      TYR_ROUTING_ADMISSION_CLASS_HEADER,
    ].some((name) => req.headers[name] !== undefined);
    if (!hasAnyRoutingHeader) return { kind: "external" };

    const token = req.headers[TYR_ROUTING_TOKEN_HEADER];
    const hop = req.headers[TYR_ROUTING_HOP_HEADER];
    const source = req.headers[TYR_ROUTING_SOURCE_HEADER];
    const priority = req.headers[TYR_ROUTING_PRIORITY_HEADER];
    const rawAdmissionClass =
      req.headers[TYR_ROUTING_ADMISSION_CLASS_HEADER];
    if (
      typeof token !== "string" ||
      !safeEqual(token, this.sharedSecret) ||
      hop !== "1" ||
      typeof source !== "string" ||
      source.trim().length === 0 ||
      (priority !== "normal" && priority !== "high") ||
      (rawAdmissionClass !== undefined &&
        (typeof rawAdmissionClass !== "string" ||
          rawAdmissionClass.trim().length === 0 ||
          rawAdmissionClass.trim().length > MAX_ADMISSION_IDENTIFIER_LENGTH))
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "internal",
      source: source.trim(),
      priority,
      ...(rawAdmissionClass === undefined
        ? {}
        : { admissionClass: rawAdmissionClass.trim() }),
    };
  }

  authorizedCapacityRequest(req: IncomingMessage): boolean {
    const token = req.headers[TYR_ROUTING_TOKEN_HEADER];
    return typeof token === "string" && safeEqual(token, this.sharedSecret);
  }

  refresh(): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;

    const refresh = Promise.all(
      [...this.#peers.values()].map(async (cached) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
        try {
          const response = await fetch(
            `${cached.peer.baseUrl}${TYR_ROUTING_CAPACITY_PATH}`,
            {
              headers: { [TYR_ROUTING_TOKEN_HEADER]: this.sharedSecret },
              redirect: "error",
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            throw new Error(`capacity endpoint returned HTTP ${response.status}`);
          }
          cached.snapshot = validateSnapshot(
            await response.json(),
            cached.peer.id,
          );
          cached.refreshedAtMs = Date.now();
        } catch {
          // Keep the previous snapshot until staleAfterMs expires. A transient
          // poll failure must not flap routing on every request.
        } finally {
          clearTimeout(timer);
        }
      }),
    )
      .then(() => undefined)
      .finally(() => {
        this.#refreshing = undefined;
      });
    this.#refreshing = refresh;
    return refresh;
  }

  select(input: {
    poolName: string;
    priority: LLMPriority;
    admissionClass?: string;
    reservation: LLMReservationEstimate | null;
    nowMs?: number;
  }): CapacityRoute {
    const nowMs = input.nowMs ?? Date.now();
    const localPool = this.#pools.get(input.poolName);
    const localStats = localPool?.stats();
    // Observe mode is intended to measure the policy on the request's current
    // replica without changing the forwarding topology. Route only pools whose
    // capacity decision is authoritative.
    if (localPool?.mode === "observe") {
      return Object.freeze({
        instanceId: this.instanceId,
        local: true,
        score: -1,
      });
    }
    const candidates: CapacityCandidate[] = [];
    if (localStats !== undefined && this.#ready()) {
      candidates.push(
        scoreCapacityCandidate({
          instanceId: this.instanceId,
          local: true,
          pool: poolCapacity(localStats),
          priority: input.priority,
          ...(input.admissionClass === undefined
            ? {}
            : { admissionClass: input.admissionClass }),
          reservation: input.reservation,
        }),
      );
    }

    for (const cached of this.#peers.values()) {
      if (
        cached.snapshot === undefined ||
        cached.refreshedAtMs === undefined ||
        nowMs - cached.refreshedAtMs > this.staleAfterMs ||
        !cached.snapshot.ready
      ) {
        continue;
      }
      const pool = cached.snapshot.pools[input.poolName];
      if (pool === undefined) continue;
      // A shared pool name must not silently cross from token-aware admission
      // into a token-unaware replica (or vice versa). Per-replica grant sizes
      // may differ, but the presence of token enforcement is part of the pool
      // contract.
      if (
        (pool.tokenBudget !== undefined) !==
        (localStats?.tokenBudget !== undefined)
      ) {
        continue;
      }
      if (
        !compatibleAdmissionClasses(
          localStats?.admissionClasses,
          pool.admissionClasses,
        )
      ) {
        continue;
      }
      candidates.push(
        scoreCapacityCandidate({
          instanceId: cached.peer.id,
          local: false,
          baseUrl: cached.peer.baseUrl,
          pool,
          priority: input.priority,
          ...(input.admissionClass === undefined
            ? {}
            : { admissionClass: input.admissionClass }),
          reservation: input.reservation,
        }),
      );
    }

    const best = chooseCapacityCandidate(candidates);
    if (best === undefined || best.local) {
      return Object.freeze({
        instanceId: this.instanceId,
        local: true,
        score: best?.score ?? -1,
      });
    }
    return Object.freeze({
      instanceId: best.instanceId,
      local: false,
      baseUrl: best.baseUrl!,
      score: best.score,
    });
  }

  forwardedHeaders(
    source: IncomingHttpHeaders,
    priority: LLMPriority,
    admissionClass?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(source)) {
      const name = rawName.toLowerCase();
      if (
        HOP_BY_HOP_HEADERS.has(name) ||
        name === TYR_ROUTING_TOKEN_HEADER ||
        name === TYR_ROUTING_HOP_HEADER ||
        name === TYR_ROUTING_SOURCE_HEADER ||
        name === TYR_ROUTING_PRIORITY_HEADER ||
        name === TYR_ROUTING_ADMISSION_CLASS_HEADER
      ) {
        continue;
      }
      if (typeof rawValue === "string") headers[name] = rawValue;
      else if (Array.isArray(rawValue)) headers[name] = rawValue.join(", ");
    }
    headers[TYR_ROUTING_TOKEN_HEADER] = this.sharedSecret;
    headers[TYR_ROUTING_HOP_HEADER] = "1";
    headers[TYR_ROUTING_SOURCE_HEADER] = this.instanceId;
    headers[TYR_ROUTING_PRIORITY_HEADER] = priority;
    if (admissionClass !== undefined) {
      headers[TYR_ROUTING_ADMISSION_CLASS_HEADER] = admissionClass;
    }
    return headers;
  }
}
