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

export type CapacityRoutingTopology = Readonly<{
  /** Monotonic Latchflo routing-membership revision. */
  revision: number;
  /** Complete routable peer snapshot. The local instance is filtered on apply. */
  peers: readonly CapacityRoutingPeer[];
}>;

export type CapacityRoutingOptions = Readonly<{
  /** Stable local replica identifier used for deterministic tie-breaking. */
  instanceId: string;
  /** Shared secret used only on Tyr-to-Tyr routing and capacity requests. */
  sharedSecret: string;
  /** Startup/fallback peers. Managed mode may replace them from Latchflo. */
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
  protectedConcurrent: number;
  protectedConcurrentInUse: number;
  borrowedConcurrent: number;
  availableProtectedConcurrency: number;
  maxConcurrent: number | null;
  availableConcurrency: number | null;
  inFlightTokens: number;
  protectedInFlightTokens: number;
  protectedTokensInUse: number;
  borrowedInFlightTokens: number;
  availableProtectedTokens: number;
  maxInFlightTokens: number | null;
  availableTokens: number | null;
}>;

export type RoutingAdmissionClassSharedCapacity = Readonly<{
  maxConcurrent: number;
  inFlight: number;
  availableConcurrency: number;
  tokenBudget?: Readonly<{
    budget: number;
    inFlightTokens: number;
    available: number;
  }>;
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
    shared: RoutingAdmissionClassSharedCapacity;
    classes: Readonly<Record<string, RoutingAdmissionClassCapacity>>;
  }>;
}>;

export type RoutingCapacitySnapshot = Readonly<{
  schemaVersion: 1 | 2 | 3;
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
  sharedConcurrencyHeadroom: number | null;
  sharedTokenHeadroom: number | null;
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
      const protectedConcurrent = state.limits.protectedConcurrent ?? 0;
      const maxClassConcurrent = state.limits.maxConcurrent ?? null;
      const protectedInFlightTokens =
        state.limits.protectedInFlightTokens ?? 0;
      const maxInFlightTokens = state.limits.maxInFlightTokens ?? null;
      classes[id] = Object.freeze({
        inFlight: state.inFlight,
        protectedConcurrent,
        protectedConcurrentInUse: state.protectedConcurrentInUse,
        borrowedConcurrent: state.borrowedConcurrent,
        availableProtectedConcurrency: Math.max(
          0,
          protectedConcurrent - state.inFlight,
        ),
        maxConcurrent: maxClassConcurrent,
        availableConcurrency:
          maxClassConcurrent === null
            ? null
            : Math.max(0, maxClassConcurrent - state.inFlight),
        inFlightTokens: state.inFlightTokens,
        protectedInFlightTokens,
        protectedTokensInUse: state.protectedTokensInUse,
        borrowedInFlightTokens: state.borrowedInFlightTokens,
        availableProtectedTokens: Math.max(
          0,
          protectedInFlightTokens - state.inFlightTokens,
        ),
        maxInFlightTokens,
        availableTokens:
          maxInFlightTokens === null
            ? null
            : Math.max(0, maxInFlightTokens - state.inFlightTokens),
      });
    }
    const shared = stats.admissionClasses.shared;
    admissionClasses = Object.freeze({
      defaultClass: stats.admissionClasses.defaultClass,
      shared: Object.freeze({
        maxConcurrent: shared.maxConcurrent,
        inFlight: shared.inFlight,
        availableConcurrency: shared.availableConcurrent,
        ...(shared.tokenBudget === undefined
          ? {}
          : {
              tokenBudget: Object.freeze({
                budget: shared.tokenBudget.budget,
                inFlightTokens: shared.tokenBudget.inFlightTokens,
                available: shared.tokenBudget.available,
              }),
            }),
      }),
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
    schemaVersion: 3,
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

function hasProtectedAdmissionClassFloors(
  classes: TyrPoolStats["admissionClasses"] | undefined,
): boolean {
  if (classes === undefined) return false;
  return Object.values(classes.classes).some(
    (state) =>
      (state.limits.protectedConcurrent ?? 0) > 0 ||
      (state.limits.protectedInFlightTokens ?? 0) > 0,
  );
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

  const selectedAdmissionClass =
    input.admissionClass ?? input.pool.admissionClasses?.defaultClass;
  const classState =
    selectedAdmissionClass === undefined
      ? undefined
      : input.pool.admissionClasses?.classes[selectedAdmissionClass];
  const classMissing =
    selectedAdmissionClass !== undefined && classState === undefined;
  const classConcurrencyHeadroom =
    classState?.availableConcurrency === null || classState === undefined
      ? null
      : classState.availableConcurrency - 1;
  const classTokenHeadroom =
    classState?.availableTokens === null || classState === undefined
      ? null
      : classState.availableTokens - requested;

  const requestedBorrowedConcurrent =
    classState === undefined || classState.availableProtectedConcurrency > 0
      ? 0
      : 1;
  const sharedConcurrencyAvailable =
    input.pool.admissionClasses?.shared.availableConcurrency ?? null;
  const sharedConcurrencyHeadroom =
    classState === undefined || sharedConcurrencyAvailable === null
      ? null
      : sharedConcurrencyAvailable - requestedBorrowedConcurrent;

  const requestedBorrowedTokens =
    classState === undefined
      ? 0
      : Math.max(0, requested - classState.availableProtectedTokens);
  const unusedProtectedTokens =
    input.pool.admissionClasses === undefined
      ? 0
      : Object.values(input.pool.admissionClasses.classes).reduce(
          (total, state) => total + state.availableProtectedTokens,
          0,
        );
  const sharedTokensAvailable =
    available === null
      ? null
      : Math.max(0, available - unusedProtectedTokens);
  const sharedTokenHeadroom =
    classState === undefined || sharedTokensAvailable === null
      ? null
      : sharedTokensAvailable - requestedBorrowedTokens;

  const concurrencyAdmissible =
    input.pool.admissionMode === "enforce" &&
    !input.pool.closed &&
    input.pool.availableConcurrency > 0;
  const tokenAdmissible = tokenHeadroom === null || tokenHeadroom >= 0;
  const classConcurrencyAdmissible =
    classConcurrencyHeadroom === null || classConcurrencyHeadroom >= 0;
  const classTokenAdmissible =
    classTokenHeadroom === null || classTokenHeadroom >= 0;
  const sharedConcurrencyAdmissible =
    sharedConcurrencyHeadroom === null || sharedConcurrencyHeadroom >= 0;
  const sharedTokenAdmissible =
    sharedTokenHeadroom === null || sharedTokenHeadroom >= 0;
  const admissible =
    !classMissing &&
    concurrencyAdmissible &&
    tokenAdmissible &&
    classConcurrencyAdmissible &&
    classTokenAdmissible &&
    sharedConcurrencyAdmissible &&
    sharedTokenAdmissible;

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
  const sharedConcurrencyRatio =
    classState === undefined || requestedBorrowedConcurrent === 0
      ? 1
      : sharedConcurrencyHeadroom! /
        Math.max(1, input.pool.admissionClasses!.shared.maxConcurrent);
  const sharedTokenRatio =
    classState === undefined || requestedBorrowedTokens === 0
      ? 1
      : sharedTokenHeadroom! /
        Math.max(1, input.pool.admissionClasses?.shared.tokenBudget?.budget ?? 1);

  return Object.freeze({
    instanceId: input.instanceId,
    local: input.local,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    pool: input.pool,
    admissible,
    concurrencyHeadroom,
    tokenHeadroom,
    ...(selectedAdmissionClass === undefined
      ? {}
      : { admissionClass: selectedAdmissionClass }),
    classConcurrencyHeadroom,
    classTokenHeadroom,
    sharedConcurrencyHeadroom,
    sharedTokenHeadroom,
    score: admissible
      ? Math.min(
          concurrencyRatio,
          tokenRatio,
          classConcurrencyRatio,
          classTokenRatio,
          sharedConcurrencyRatio,
          sharedTokenRatio,
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
  schemaVersion: RoutingCapacitySnapshot["schemaVersion"],
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
  if (availableConcurrency !== Math.max(0, maxConcurrent - inFlight)) {
    throw new Error(`${field}.availableConcurrency is inconsistent`);
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
    let protectedConcurrentTotal = 0;
    let protectedConcurrentInUseTotal = 0;
    let protectedInFlightTokensTotal = 0;
    let protectedTokensInUseTotal = 0;
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

      const protectedConcurrent =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.protectedConcurrent,
              `${classField}.protectedConcurrent`,
            )
          : 0;
      const protectedConcurrentInUse =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.protectedConcurrentInUse,
              `${classField}.protectedConcurrentInUse`,
            )
          : 0;
      const borrowedConcurrent =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.borrowedConcurrent,
              `${classField}.borrowedConcurrent`,
            )
          : classInFlight;
      const availableProtectedConcurrency =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.availableProtectedConcurrency,
              `${classField}.availableProtectedConcurrency`,
            )
          : 0;
      if (protectedConcurrentInUse !== Math.min(classInFlight, protectedConcurrent)) {
        throw new Error(`${classField}.protectedConcurrentInUse is inconsistent`);
      }
      if (
        borrowedConcurrent !==
        Math.max(0, classInFlight - protectedConcurrentInUse)
      ) {
        throw new Error(`${classField}.borrowedConcurrent is inconsistent`);
      }
      if (
        availableProtectedConcurrency !==
        Math.max(0, protectedConcurrent - classInFlight)
      ) {
        throw new Error(
          `${classField}.availableProtectedConcurrency is inconsistent`,
        );
      }
      if (
        classMaxConcurrent !== null &&
        protectedConcurrent > classMaxConcurrent
      ) {
        throw new Error(
          `${classField}.protectedConcurrent exceeds maxConcurrent`,
        );
      }

      const protectedInFlightTokens =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.protectedInFlightTokens,
              `${classField}.protectedInFlightTokens`,
            )
          : 0;
      const protectedTokensInUse =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.protectedTokensInUse,
              `${classField}.protectedTokensInUse`,
            )
          : 0;
      const borrowedInFlightTokens =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.borrowedInFlightTokens,
              `${classField}.borrowedInFlightTokens`,
            )
          : classInFlightTokens;
      const availableProtectedTokens =
        schemaVersion >= 3
          ? nonNegativeSafeInteger(
              state.availableProtectedTokens,
              `${classField}.availableProtectedTokens`,
            )
          : 0;
      if (
        protectedTokensInUse !==
        Math.min(classInFlightTokens, protectedInFlightTokens)
      ) {
        throw new Error(`${classField}.protectedTokensInUse is inconsistent`);
      }
      if (
        borrowedInFlightTokens !==
        Math.max(0, classInFlightTokens - protectedTokensInUse)
      ) {
        throw new Error(`${classField}.borrowedInFlightTokens is inconsistent`);
      }
      if (
        availableProtectedTokens !==
        Math.max(0, protectedInFlightTokens - classInFlightTokens)
      ) {
        throw new Error(`${classField}.availableProtectedTokens is inconsistent`);
      }
      if (
        classMaxInFlightTokens !== null &&
        protectedInFlightTokens > classMaxInFlightTokens
      ) {
        throw new Error(
          `${classField}.protectedInFlightTokens exceeds maxInFlightTokens`,
        );
      }
      if (tokenBudget === undefined && protectedInFlightTokens > 0) {
        throw new Error(
          `${classField}.protectedInFlightTokens requires tokenBudget`,
        );
      }

      protectedConcurrentTotal += protectedConcurrent;
      protectedConcurrentInUseTotal += protectedConcurrentInUse;
      protectedInFlightTokensTotal += protectedInFlightTokens;
      protectedTokensInUseTotal += protectedTokensInUse;
      classes[id] = Object.freeze({
        inFlight: classInFlight,
        protectedConcurrent,
        protectedConcurrentInUse,
        borrowedConcurrent,
        availableProtectedConcurrency,
        maxConcurrent: classMaxConcurrent,
        availableConcurrency: classAvailableConcurrency,
        inFlightTokens: classInFlightTokens,
        protectedInFlightTokens,
        protectedTokensInUse,
        borrowedInFlightTokens,
        availableProtectedTokens,
        maxInFlightTokens: classMaxInFlightTokens,
        availableTokens: classAvailableTokens,
      });
    }
    if (!Object.hasOwn(classes, defaultClass)) {
      throw new Error(
        `${field}.admissionClasses.defaultClass must reference a configured class`,
      );
    }
    if (protectedConcurrentTotal > maxConcurrent) {
      throw new Error(
        `${field}.admissionClasses protected concurrency exceeds maxConcurrent`,
      );
    }
    if (
      tokenBudget !== undefined &&
      protectedInFlightTokensTotal > tokenBudget.budget
    ) {
      throw new Error(
        `${field}.admissionClasses protected tokens exceed tokenBudget.budget`,
      );
    }

    let shared: RoutingAdmissionClassSharedCapacity;
    if (schemaVersion >= 3) {
      const rawShared = pool.admissionClasses.shared;
      if (
        typeof rawShared !== "object" ||
        rawShared === null ||
        Array.isArray(rawShared)
      ) {
        throw new Error(`${field}.admissionClasses.shared must be an object`);
      }
      const sharedMaxConcurrent = nonNegativeSafeInteger(
        rawShared.maxConcurrent,
        `${field}.admissionClasses.shared.maxConcurrent`,
      );
      const sharedInFlight = nonNegativeSafeInteger(
        rawShared.inFlight,
        `${field}.admissionClasses.shared.inFlight`,
      );
      const sharedAvailableConcurrency = nonNegativeSafeInteger(
        rawShared.availableConcurrency,
        `${field}.admissionClasses.shared.availableConcurrency`,
      );
      if (sharedMaxConcurrent !== Math.max(0, maxConcurrent - protectedConcurrentTotal)) {
        throw new Error(
          `${field}.admissionClasses.shared.maxConcurrent is inconsistent`,
        );
      }
      if (sharedInFlight !== Math.max(0, inFlight - protectedConcurrentInUseTotal)) {
        throw new Error(`${field}.admissionClasses.shared.inFlight is inconsistent`);
      }
      if (
        sharedAvailableConcurrency !==
        Math.max(0, sharedMaxConcurrent - sharedInFlight)
      ) {
        throw new Error(
          `${field}.admissionClasses.shared.availableConcurrency is inconsistent`,
        );
      }
      let sharedTokenBudget: RoutingAdmissionClassSharedCapacity["tokenBudget"];
      if (tokenBudget !== undefined) {
        const rawSharedTokenBudget = rawShared.tokenBudget;
        if (
          typeof rawSharedTokenBudget !== "object" ||
          rawSharedTokenBudget === null ||
          Array.isArray(rawSharedTokenBudget)
        ) {
          throw new Error(
            `${field}.admissionClasses.shared.tokenBudget must be an object`,
          );
        }
        const sharedBudget = nonNegativeSafeInteger(
          rawSharedTokenBudget.budget,
          `${field}.admissionClasses.shared.tokenBudget.budget`,
        );
        const sharedInFlightTokens = nonNegativeSafeInteger(
          rawSharedTokenBudget.inFlightTokens,
          `${field}.admissionClasses.shared.tokenBudget.inFlightTokens`,
        );
        const sharedAvailableTokens = nonNegativeSafeInteger(
          rawSharedTokenBudget.available,
          `${field}.admissionClasses.shared.tokenBudget.available`,
        );
        if (
          sharedBudget !==
          Math.max(0, tokenBudget.budget - protectedInFlightTokensTotal)
        ) {
          throw new Error(
            `${field}.admissionClasses.shared.tokenBudget.budget is inconsistent`,
          );
        }
        if (
          sharedInFlightTokens !==
          Math.max(0, tokenBudget.inFlightTokens - protectedTokensInUseTotal)
        ) {
          throw new Error(
            `${field}.admissionClasses.shared.tokenBudget.inFlightTokens is inconsistent`,
          );
        }
        if (
          sharedAvailableTokens !==
          Math.max(0, sharedBudget - sharedInFlightTokens)
        ) {
          throw new Error(
            `${field}.admissionClasses.shared.tokenBudget.available is inconsistent`,
          );
        }
        sharedTokenBudget = Object.freeze({
          budget: sharedBudget,
          inFlightTokens: sharedInFlightTokens,
          available: sharedAvailableTokens,
        });
      } else if (rawShared.tokenBudget !== undefined) {
        throw new Error(
          `${field}.admissionClasses.shared.tokenBudget must be omitted`,
        );
      }
      shared = Object.freeze({
        maxConcurrent: sharedMaxConcurrent,
        inFlight: sharedInFlight,
        availableConcurrency: sharedAvailableConcurrency,
        ...(sharedTokenBudget === undefined
          ? {}
          : { tokenBudget: sharedTokenBudget }),
      });
    } else {
      shared = Object.freeze({
        maxConcurrent,
        inFlight,
        availableConcurrency,
        ...(tokenBudget === undefined
          ? {}
          : {
              tokenBudget: Object.freeze({
                budget: tokenBudget.budget,
                inFlightTokens: tokenBudget.inFlightTokens,
                available: Math.max(
                  0,
                  tokenBudget.budget - tokenBudget.inFlightTokens,
                ),
              }),
            }),
      });
    }
    admissionClasses = Object.freeze({
      defaultClass,
      shared,
      classes: Object.freeze(classes),
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
  if (
    snapshot.schemaVersion !== 1 &&
    snapshot.schemaVersion !== 2 &&
    snapshot.schemaVersion !== 3
  ) {
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
    pools[name] = validatePoolCapacity(
      pool,
      `capacity snapshot pools.${name}`,
      snapshot.schemaVersion,
    );
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
  #topologyRevision: number | undefined;
  #started = false;
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
    if (this.#started) return;
    this.#started = true;
    this.#syncPolling();
  }

  stop(): void {
    this.#started = false;
    if (this.#interval !== undefined) clearInterval(this.#interval);
    this.#interval = undefined;
  }

  /**
   * Atomically replaces the routable peer set from a newer complete topology
   * snapshot. Static startup peers remain in force until the first topology is
   * applied, preserving compatibility with standalone Tyr and older Latchflo.
   */
  applyTopology(topology: CapacityRoutingTopology): boolean {
    if (!Number.isSafeInteger(topology.revision) || topology.revision < 0) {
      throw new Error("capacity routing topology revision must be a non-negative safe integer");
    }
    if (
      this.#topologyRevision !== undefined &&
      topology.revision <= this.#topologyRevision
    ) {
      return false;
    }

    const next = new Map<string, CachedPeer>();
    for (const configured of topology.peers) {
      const id = configured.id.trim();
      if (id.length === 0) {
        throw new Error("capacity routing topology peer id must be non-empty");
      }
      // Latchflo publishes a complete fleet snapshot, including this replica.
      // Never add self as a forwarding target.
      if (id === this.instanceId) continue;
      if (next.has(id)) {
        throw new Error(`duplicate capacity routing topology peer id: ${id}`);
      }
      const peer = Object.freeze({
        id,
        baseUrl: normalizeBaseUrl(configured.baseUrl),
      });
      const current = this.#peers.get(id);
      if (current?.peer.baseUrl === peer.baseUrl) {
        next.set(id, current);
      } else {
        // A new member or endpoint must earn a fresh capacity snapshot before
        // it can receive traffic. Replacing the cache also prevents a removed
        // endpoint from remaining routable under the same instance ID.
        next.set(id, { peer });
      }
    }

    this.#peers.clear();
    for (const [id, cached] of next) this.#peers.set(id, cached);
    this.#topologyRevision = topology.revision;
    this.#syncPolling();
    return true;
  }

  #syncPolling(): void {
    if (!this.#started || this.#peers.size === 0) {
      if (this.#interval !== undefined) clearInterval(this.#interval);
      this.#interval = undefined;
      return;
    }
    if (this.#interval !== undefined) return;
    void this.refresh();
    this.#interval = setInterval(() => void this.refresh(), this.pollIntervalMs);
    this.#interval.unref();
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
      // Schema 1/2 peers predate protected class floors. During a rolling
      // upgrade, do not route floor-dependent traffic to a replica that cannot
      // represent or enforce the same protection semantics.
      if (
        cached.snapshot.schemaVersion < 3 &&
        hasProtectedAdmissionClassFloors(localStats?.admissionClasses)
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
