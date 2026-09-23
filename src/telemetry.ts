import type {
  LLMAdmissionResources,
  LLMPriority,
  LLMRejectReason,
  TokenUsage,
} from "async-bulkhead-llm";
import type { ApiShape } from "./adapters.js";
import type { TyrRequestIdentity } from "./identity.js";
import type { AdmissionProvenance, TyrPoolStats } from "./pools.js";
import type { UpstreamFailure } from "./upstream-failure.js";
import { TYR_VERSION } from "./version.js";

export type TyrAdmissionOutcome = "admitted" | "bypassed" | "rejected";

export type TyrRequestOutcome =
  | "success"
  | "upstream_4xx"
  | "upstream_5xx"
  | "admission_rejected"
  | "borrowed_admission_deadline"
  | "response_timeout"
  | "idle_timeout"
  | "client_disconnect"
  | "client_stall"
  | "upstream_error";

export type TyrAuditSettlement =
  | "completed"
  | "rejected"
  | "borrowed_admission_deadline"
  | "response_timeout"
  | "idle_timeout"
  | "client_disconnect"
  | "client_stall"
  | "upstream_error";

export type TyrAdmissionAuditEvent = {
  readonly schema: "tyr.admission-audit.v2";
  readonly timestamp: string;
  readonly event: "admission_decision";
  readonly outcome: TyrAdmissionOutcome;
  readonly settlement: TyrAuditSettlement;
  readonly pool: string;
  readonly provider: ApiShape;
  readonly priority: LLMPriority;
  readonly admissionClass?: string;
  readonly model: string;
  readonly limitRevision: number;
  readonly admissionId?: string;
  readonly reason?: LLMRejectReason;
  readonly reservedTokens?: number;
  readonly resources?: LLMAdmissionResources;
  readonly restoration?: {
    readonly admissionSlot: {
      readonly releaseMechanism: "deadline_abandonment";
      readonly enforceability: "enforced";
      readonly outcome: "released";
      readonly deadlineMs: number;
    };
    readonly upstreamCapacity: {
      readonly releaseMechanism: "abort_signal";
      readonly enforceability: "unverified";
      readonly outcome: "cancellation_requested";
    };
  };
  readonly grant?: AdmissionProvenance;
  readonly usage?: TokenUsage;
  readonly identity?: TyrRequestIdentity;
};

export type LatchfloFailureOperation =
  | "startup"
  | "heartbeat"
  | "poll"
  | "ack"
  | "expiration"
  | "persist";

export type LatchfloFailureReason =
  | "retryable"
  | "permanent"
  | "http_error"
  | "transport_error"
  | "apply_error"
  | "persist_error";

/**
 * Operator diagnostic for an upstream call that failed without a usable
 * response. Emitted regardless of `auditEnabled`: it is rare, and without it
 * the transport reason behind a 502 is unrecoverable.
 */
export type TyrUpstreamFailureEvent = {
  readonly schema: "tyr.diagnostic.v1";
  readonly timestamp: string;
  readonly event: "upstream_failure";
  readonly pool: string;
  readonly provider: ApiShape;
  /** True when response headers were already sent, so the stream was torn. */
  readonly afterHeaders: boolean;
} & UpstreamFailure;

export type TyrTelemetryOptions = {
  /** Expose Prometheus text format at GET /metrics. Default: true. */
  readonly metricsEnabled?: boolean;
  /** Emit one structured JSON audit event per admission decision. Default: false. */
  readonly auditEnabled?: boolean;
  /** Override the default stdout JSON sink, primarily for embedding and tests. */
  readonly auditSink?: (event: TyrAdmissionAuditEvent) => void;
  /** Override the default stderr JSON sink for upstream failure diagnostics. */
  readonly diagnosticSink?: (event: TyrUpstreamFailureEvent) => void;
};

type Labels = Readonly<Record<string, string>>;

type CounterSeries = {
  readonly labels: Labels;
  value: number;
};

type HistogramSeries = {
  readonly labels: Labels;
  count: number;
  sum: number;
  readonly buckets: number[];
};

const ADMISSION_DECISION_BUCKETS_SECONDS = [
  0.000005,
  0.00001,
  0.000025,
  0.00005,
  0.0001,
  0.00025,
  0.0005,
  0.001,
  0.0025,
  0.005,
  0.01,
  0.025,
  0.05,
] as const;

const DURATION_BUCKETS_SECONDS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
] as const;

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}\u001f${value}`)
    .join("\u001e");
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "";
  return `{${entries
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
}

function statusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function addMetricHeader(
  lines: string[],
  name: string,
  type: "counter" | "gauge" | "histogram",
  help: string,
): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

function addSample(
  lines: string[],
  name: string,
  value: number,
  labels: Labels = {},
): void {
  lines.push(`${name}${renderLabels(labels)} ${Number.isFinite(value) ? value : 0}`);
}

function addCounterSeries(
  lines: string[],
  name: string,
  series: ReadonlyMap<string, CounterSeries>,
): void {
  for (const item of [...series.values()].sort((left, right) =>
    labelsKey(left.labels).localeCompare(labelsKey(right.labels)),
  )) {
    addSample(lines, name, item.value, item.labels);
  }
}

function addHistogramSeries(
  lines: string[],
  name: string,
  series: ReadonlyMap<string, HistogramSeries>,
  bucketBounds: readonly number[],
): void {
  for (const item of [...series.values()].sort((left, right) =>
    labelsKey(left.labels).localeCompare(labelsKey(right.labels)),
  )) {
    let cumulative = 0;
    for (let index = 0; index < bucketBounds.length; index += 1) {
      cumulative += item.buckets[index] ?? 0;
      addSample(lines, `${name}_bucket`, cumulative, {
        ...item.labels,
        le: String(bucketBounds[index]),
      });
    }
    addSample(lines, `${name}_bucket`, item.count, {
      ...item.labels,
      le: "+Inf",
    });
    addSample(lines, `${name}_sum`, item.sum, item.labels);
    addSample(lines, `${name}_count`, item.count, item.labels);
  }
}

export class TyrTelemetry {
  readonly metricsEnabled: boolean;
  readonly auditEnabled: boolean;

  readonly #auditSink: (event: TyrAdmissionAuditEvent) => void;
  readonly #diagnosticSink: (event: TyrUpstreamFailureEvent) => void;
  readonly #upstreamFailures = new Map<string, CounterSeries>();
  readonly #admissionDecisions = new Map<string, CounterSeries>();
  readonly #rejections = new Map<string, CounterSeries>();
  readonly #requests = new Map<string, CounterSeries>();
  readonly #upstreamResponses = new Map<string, CounterSeries>();
  readonly #latchfloFailures = new Map<string, CounterSeries>();
  readonly #requestDurations = new Map<string, HistogramSeries>();
  readonly #upstreamDurations = new Map<string, HistogramSeries>();
  readonly #admissionDecisionDurations = new Map<string, HistogramSeries>();
  readonly #admissionQueueWaitDurations = new Map<string, HistogramSeries>();
  #auditWriteFailures = 0;

  constructor(options: TyrTelemetryOptions = {}) {
    this.metricsEnabled = options.metricsEnabled ?? true;
    this.auditEnabled = options.auditEnabled ?? false;
    this.#auditSink =
      options.auditSink ?? ((event) => console.log(JSON.stringify(event)));
    this.#diagnosticSink =
      options.diagnosticSink ?? ((event) => console.warn(JSON.stringify(event)));
  }

  recordAdmissionStart(input: {
    readonly pool: string;
    readonly priority: LLMPriority;
    readonly admissionClass?: string;
    readonly outcome: Exclude<TyrAdmissionOutcome, "rejected">;
  }): void {
    this.#increment(this.#admissionDecisions, {
      pool: input.pool,
      priority: input.priority,
      admission_class: input.admissionClass ?? "none",
      outcome: input.outcome,
    });
  }

  recordRejection(input: {
    readonly pool: string;
    readonly priority: LLMPriority;
    readonly admissionClass?: string;
    readonly reason: LLMRejectReason;
  }): void {
    this.#increment(this.#admissionDecisions, {
      pool: input.pool,
      priority: input.priority,
      admission_class: input.admissionClass ?? "none",
      outcome: "rejected",
    });
    this.#increment(this.#rejections, {
      pool: input.pool,
      priority: input.priority,
      admission_class: input.admissionClass ?? "none",
      reason: input.reason,
    });
  }

  recordAdmissionDecisionTiming(input: {
    readonly pool: string;
    readonly outcome: "admitted" | "rejected";
    readonly admissionClass?: string;
    readonly decisionDurationNs: number;
    readonly queueWaitNs: number;
  }): void {
    const labels = {
      pool: input.pool,
      outcome: input.outcome,
      admission_class: input.admissionClass ?? "none",
    };
    this.#observe(
      this.#admissionDecisionDurations,
      labels,
      input.decisionDurationNs / 1_000_000_000,
      ADMISSION_DECISION_BUCKETS_SECONDS,
    );
    this.#observe(
      this.#admissionQueueWaitDurations,
      labels,
      input.queueWaitNs / 1_000_000_000,
      DURATION_BUCKETS_SECONDS,
    );
  }

  recordRequest(input: {
    readonly pool: string;
    readonly provider: ApiShape;
    readonly outcome: TyrRequestOutcome;
    readonly durationSeconds: number;
  }): void {
    const labels = {
      pool: input.pool,
      provider: input.provider,
      outcome: input.outcome,
    };
    this.#increment(this.#requests, labels);
    this.#observe(
      this.#requestDurations,
      labels,
      input.durationSeconds,
      DURATION_BUCKETS_SECONDS,
    );
  }

  recordUpstreamResponse(input: {
    readonly pool: string;
    readonly provider: ApiShape;
    readonly status: number;
  }): void {
    this.#increment(this.#upstreamResponses, {
      pool: input.pool,
      provider: input.provider,
      status_class: statusClass(input.status),
    });
  }

  recordUpstreamDuration(input: {
    readonly pool: string;
    readonly provider: ApiShape;
    readonly outcome: string;
    readonly durationSeconds: number;
  }): void {
    this.#observe(
      this.#upstreamDurations,
      {
        pool: input.pool,
        provider: input.provider,
        outcome: input.outcome,
      },
      input.durationSeconds,
      DURATION_BUCKETS_SECONDS,
    );
  }

  recordLatchfloFailure(input: {
    readonly operation: LatchfloFailureOperation;
    readonly reason: LatchfloFailureReason;
  }): void {
    this.#increment(this.#latchfloFailures, input);
  }

  recordUpstreamFailure(input: {
    readonly pool: string;
    readonly provider: ApiShape;
    readonly afterHeaders: boolean;
    readonly failure: UpstreamFailure;
  }): void {
    this.#increment(this.#upstreamFailures, {
      pool: input.pool,
      provider: input.provider,
      code: input.failure.code,
    });
    try {
      this.#diagnosticSink({
        schema: "tyr.diagnostic.v1",
        timestamp: new Date().toISOString(),
        event: "upstream_failure",
        pool: input.pool,
        provider: input.provider,
        afterHeaders: input.afterHeaders,
        ...input.failure,
      });
    } catch {
      // A diagnostic write must never affect proxy behavior.
    }
  }

  emitAdmissionAudit(
    event: Omit<TyrAdmissionAuditEvent, "schema" | "timestamp" | "event">,
  ): void {
    if (!this.auditEnabled) return;
    try {
      this.#auditSink({
        schema: "tyr.admission-audit.v2",
        timestamp: new Date().toISOString(),
        event: "admission_decision",
        ...event,
      });
    } catch {
      // Audit export must never affect admission or proxy behavior. The
      // failure remains visible through a bounded Prometheus counter.
      this.#auditWriteFailures += 1;
    }
  }

  renderPrometheus(
    stats: Readonly<Record<string, TyrPoolStats>>,
    ready: boolean,
  ): string {
    const lines: string[] = [];

    addMetricHeader(lines, "tyr_build_info", "gauge", "Tyr build information.");
    addSample(lines, "tyr_build_info", 1, { version: TYR_VERSION });

    addMetricHeader(lines, "tyr_ready", "gauge", "Whether Tyr is ready to accept managed traffic.");
    addSample(lines, "tyr_ready", ready ? 1 : 0);

    addMetricHeader(
      lines,
      "tyr_admission_decisions_total",
      "counter",
      "Admission decisions by pool, bounded admission class, priority, and outcome.",
    );
    addCounterSeries(lines, "tyr_admission_decisions_total", this.#admissionDecisions);

    addMetricHeader(
      lines,
      "tyr_admission_rejections_total",
      "counter",
      "Admission rejections by pool, bounded admission class, priority, and reason.",
    );
    addCounterSeries(lines, "tyr_admission_rejections_total", this.#rejections);

    addMetricHeader(
      lines,
      "tyr_resource_release_events_total",
      "counter",
      "Resource-specific borrowed-slot deadline events; unverified upstream series are not reclamation claims.",
    );
    for (const pool of Object.keys(stats).sort()) {
      const llm = stats[pool]?.llm;
      // Every abandonment returns the local slot, but only deadline expiry
      // aborts the callback signal, so the upstream series counts that cause
      // alone rather than reusing the aggregate.
      const released = llm?.borrowedConcurrencyAbandoned ?? 0;
      const deadlineReleased =
        llm?.borrowedConcurrencyAbandonedByCause.deadline ?? 0;
      addSample(lines, "tyr_resource_release_events_total", released, {
        pool,
        resource: "admission_slot",
        release_mechanism: "deadline_abandonment",
        enforceability: "enforced",
        outcome: "released",
      });
      addSample(lines, "tyr_resource_release_events_total", deadlineReleased, {
        pool,
        resource: "upstream_capacity",
        release_mechanism: "abort_signal",
        enforceability: "unverified",
        outcome: "cancellation_requested",
      });
    }

    addMetricHeader(lines, "tyr_requests_total", "counter", "Completed gateway requests by bounded outcome.");
    addCounterSeries(lines, "tyr_requests_total", this.#requests);

    addMetricHeader(lines, "tyr_upstream_responses_total", "counter", "Upstream responses grouped by status class.");
    addCounterSeries(lines, "tyr_upstream_responses_total", this.#upstreamResponses);

    addMetricHeader(
      lines,
      "tyr_admission_decision_seconds",
      "histogram",
      "Synchronous local admission-decision duration in seconds, excluding queue wait.",
    );
    addHistogramSeries(
      lines,
      "tyr_admission_decision_seconds",
      this.#admissionDecisionDurations,
      ADMISSION_DECISION_BUCKETS_SECONDS,
    );

    addMetricHeader(
      lines,
      "tyr_admission_queue_wait_seconds",
      "histogram",
      "Time spent awaiting local admission concurrency capacity in seconds.",
    );
    addHistogramSeries(
      lines,
      "tyr_admission_queue_wait_seconds",
      this.#admissionQueueWaitDurations,
      DURATION_BUCKETS_SECONDS,
    );

    addMetricHeader(lines, "tyr_request_duration_seconds", "histogram", "End-to-end Tyr request duration in seconds.");
    addHistogramSeries(
      lines,
      "tyr_request_duration_seconds",
      this.#requestDurations,
      DURATION_BUCKETS_SECONDS,
    );

    addMetricHeader(lines, "tyr_upstream_duration_seconds", "histogram", "Total upstream call duration in seconds.");
    addHistogramSeries(
      lines,
      "tyr_upstream_duration_seconds",
      this.#upstreamDurations,
      DURATION_BUCKETS_SECONDS,
    );

    addMetricHeader(lines, "tyr_latchflo_failures_total", "counter", "Latchflo integration failures by operation and bounded reason.");
    addCounterSeries(lines, "tyr_latchflo_failures_total", this.#latchfloFailures);

    addMetricHeader(lines, "tyr_upstream_failures_total", "counter", "Upstream calls that failed without a usable response, by bounded transport error code.");
    addCounterSeries(lines, "tyr_upstream_failures_total", this.#upstreamFailures);

    addMetricHeader(lines, "tyr_audit_write_failures_total", "counter", "Structured admission audit events that could not be written.");
    addSample(lines, "tyr_audit_write_failures_total", this.#auditWriteFailures);

    const poolNames = Object.keys(stats).sort();
    const poolMetrics: Array<{
      name: string;
      type: "counter" | "gauge";
      help: string;
      value: (snapshot: TyrPoolStats) => number;
    }> = [
      {
        name: "tyr_pool_limit_revision",
        type: "gauge",
        help: "Current atomic admission-limit revision.",
        value: (snapshot) => snapshot.limits.revision,
      },
      {
        name: "tyr_pool_max_concurrent",
        type: "gauge",
        help: "Configured concurrency ceiling.",
        value: (snapshot) => snapshot.limits.maxConcurrent,
      },
      {
        name: "tyr_pool_max_queue",
        type: "gauge",
        help: "Configured queue ceiling.",
        value: (snapshot) => snapshot.limits.maxQueue,
      },
      {
        name: "tyr_pool_in_flight",
        type: "gauge",
        help: "Currently admitted requests holding concurrency capacity.",
        value: (snapshot) => snapshot.bulkhead.inFlight,
      },
      {
        name: "tyr_pool_work_in_flight",
        type: "gauge",
        help: "Admitted work awaiting final local settlement, including work whose borrowed slot was abandoned.",
        value: (snapshot) => snapshot.llm.inFlight,
      },
      {
        name: "tyr_pool_pending",
        type: "gauge",
        help: "Requests currently waiting in the bounded queue.",
        value: (snapshot) => snapshot.bulkhead.pending,
      },
      {
        name: "tyr_pool_closed",
        type: "gauge",
        help: "Whether the pool is closed to new admission.",
        value: (snapshot) => (snapshot.bulkhead.closed ? 1 : 0),
      },
      {
        name: "tyr_pool_admitted_total",
        type: "counter",
        help: "Successful capacity-holding admissions.",
        value: (snapshot) => snapshot.llm.admitted,
      },
      {
        name: "tyr_pool_released_total",
        type: "counter",
        help: "Released capacity-holding admissions.",
        value: (snapshot) => snapshot.llm.released,
      },
      {
        name: "tyr_pool_borrowed_admission_slot_deadlines_total",
        type: "counter",
        help: "Borrowed local admission slots returned by enforced wall-clock deadlines.",
        value: (snapshot) =>
          snapshot.llm.borrowedConcurrencyAbandonedByCause.deadline ?? 0,
      },
      {
        name: "tyr_pool_rejected_total",
        type: "counter",
        help: "Total LLM-layer rejections.",
        value: (snapshot) => snapshot.llm.rejected,
      },
      {
        name: "tyr_pool_observe_bypassed_total",
        type: "counter",
        help: "Observe-mode callbacks executed without holding capacity.",
        value: (snapshot) => snapshot.tyr.observe.bypassed,
      },
      {
        name: "tyr_pool_advisory_would_reject_total",
        type: "counter",
        help: "Advisory checks that predicted a capacity rejection.",
        value: (snapshot) => snapshot.tyr.advisory.wouldReject,
      },
      {
        name: "tyr_pool_adaptive_models",
        type: "gauge",
        help: "Number of bounded adaptive-estimation model corrections retained.",
        value: (snapshot) => snapshot.tyr.adaptiveEstimation.corrections.length,
      },
      {
        name: "tyr_pool_progressive_reconciliation_enabled",
        type: "gauge",
        help: "Whether progressive streaming reconciliation is enabled.",
        value: (snapshot) =>
          snapshot.tyr.progressiveReconciliation.enabled ? 1 : 0,
      },
      {
        name: "tyr_pool_progressive_usage_reports_total",
        type: "counter",
        help: "Cumulative streaming usage reports offered to progressive reconciliation.",
        value: (snapshot) => snapshot.tyr.progressiveReconciliation.reports,
      },
      {
        name: "tyr_pool_progressive_updates_total",
        type: "counter",
        help: "Cumulative progressive future-work hold updates applied.",
        value: (snapshot) => snapshot.tyr.progressiveReconciliation.updates,
      },
      {
        name: "tyr_pool_progressive_coalesced_total",
        type: "counter",
        help: "Cumulative progressive usage reports coalesced below the configured token step.",
        value: (snapshot) => snapshot.tyr.progressiveReconciliation.coalesced,
      },
      {
        name: "tyr_pool_progressive_tokens_released_total",
        type: "counter",
        help: "Cumulative tokens returned before request completion by progressive reconciliation.",
        value: (snapshot) =>
          snapshot.tyr.progressiveReconciliation.earlyReleasedTokens,
      },
      {
        name: "tyr_pool_progressive_update_step_tokens",
        type: "gauge",
        help: "Configured minimum token decrease between progressive hold updates.",
        value: (snapshot) =>
          snapshot.tyr.progressiveReconciliation.updateStepTokens,
      },
      {
        name: "tyr_pool_progressive_safety_margin_tokens",
        type: "gauge",
        help: "Configured future-output safety floor retained until final release.",
        value: (snapshot) =>
          snapshot.tyr.progressiveReconciliation.outputSafetyMarginTokens,
      },
    ];

    for (const metric of poolMetrics) {
      addMetricHeader(lines, metric.name, metric.type, metric.help);
      for (const pool of poolNames) {
        const snapshot = stats[pool];
        if (snapshot !== undefined) {
          addSample(lines, metric.name, metric.value(snapshot), { pool });
        }
      }
    }

    const sharedAdmissionClassMetrics: Array<{
      name: string;
      type: "counter" | "gauge";
      help: string;
      value: (
        snapshot: NonNullable<TyrPoolStats["admissionClasses"]>["shared"],
      ) => number | undefined;
    }> = [
      {
        name: "tyr_pool_admission_class_shared_max_concurrent",
        type: "gauge",
        help: "Concurrency remaining after all protected admission-class floors.",
        value: (snapshot) => snapshot.maxConcurrent,
      },
      {
        name: "tyr_pool_admission_class_shared_in_flight",
        type: "gauge",
        help: "Requests currently consuming shared admission-class concurrency.",
        value: (snapshot) => snapshot.inFlight,
      },
      {
        name: "tyr_pool_admission_class_shared_available_concurrent",
        type: "gauge",
        help: "Shared admission-class concurrency currently available.",
        value: (snapshot) => snapshot.availableConcurrent,
      },
      {
        name: "tyr_pool_admission_class_shared_token_budget",
        type: "gauge",
        help: "Token capacity remaining after all protected admission-class floors.",
        value: (snapshot) => snapshot.tokenBudget?.budget,
      },
      {
        name: "tyr_pool_admission_class_shared_tokens_in_flight",
        type: "gauge",
        help: "Tokens currently consuming shared admission-class capacity.",
        value: (snapshot) => snapshot.tokenBudget?.inFlightTokens,
      },
      {
        name: "tyr_pool_admission_class_shared_tokens_available",
        type: "gauge",
        help: "Shared admission-class token capacity currently available.",
        value: (snapshot) => snapshot.tokenBudget?.available,
      },
    ];

    for (const metric of sharedAdmissionClassMetrics) {
      addMetricHeader(lines, metric.name, metric.type, metric.help);
      for (const pool of poolNames) {
        const shared = stats[pool]?.admissionClasses?.shared;
        if (shared === undefined) continue;
        const value = metric.value(shared);
        if (value !== undefined) {
          addSample(lines, metric.name, value, { pool });
        }
      }
    }

    const admissionClassMetrics: Array<{
      name: string;
      type: "counter" | "gauge";
      help: string;
      value: (snapshot: NonNullable<TyrPoolStats["admissionClasses"]>["classes"][string]) =>
        number | undefined;
    }> = [
      {
        name: "tyr_pool_admission_class_in_flight",
        type: "gauge",
        help: "Requests currently holding capacity in a bounded admission class.",
        value: (snapshot) => snapshot.inFlight,
      },
      {
        name: "tyr_pool_admission_class_protected_concurrent",
        type: "gauge",
        help: "Concurrency reserved for a bounded admission class before shared capacity is borrowed.",
        value: (snapshot) => snapshot.limits.protectedConcurrent ?? 0,
      },
      {
        name: "tyr_pool_admission_class_protected_concurrent_in_use",
        type: "gauge",
        help: "Admission-class requests currently consuming protected concurrency.",
        value: (snapshot) => snapshot.protectedConcurrentInUse,
      },
      {
        name: "tyr_pool_admission_class_borrowed_concurrent",
        type: "gauge",
        help: "Admission-class requests currently consuming shared concurrency.",
        value: (snapshot) => snapshot.borrowedConcurrent,
      },
      {
        name: "tyr_pool_admission_class_max_concurrent",
        type: "gauge",
        help: "Configured class-specific concurrency ceiling; absent when the physical pool alone governs concurrency.",
        value: (snapshot) => snapshot.limits.maxConcurrent,
      },
      {
        name: "tyr_pool_admission_class_in_flight_tokens",
        type: "gauge",
        help: "Tokens currently held in flight by a bounded admission class.",
        value: (snapshot) => snapshot.inFlightTokens,
      },
      {
        name: "tyr_pool_admission_class_protected_in_flight_tokens",
        type: "gauge",
        help: "In-flight tokens reserved for a bounded admission class before shared capacity is borrowed.",
        value: (snapshot) => snapshot.limits.protectedInFlightTokens ?? 0,
      },
      {
        name: "tyr_pool_admission_class_protected_tokens_in_use",
        type: "gauge",
        help: "Admission-class tokens currently consuming protected token capacity.",
        value: (snapshot) => snapshot.protectedTokensInUse,
      },
      {
        name: "tyr_pool_admission_class_borrowed_in_flight_tokens",
        type: "gauge",
        help: "Admission-class tokens currently consuming shared token capacity.",
        value: (snapshot) => snapshot.borrowedInFlightTokens,
      },
      {
        name: "tyr_pool_admission_class_max_in_flight_tokens",
        type: "gauge",
        help: "Configured class-specific in-flight token ceiling; absent when the physical pool alone governs tokens.",
        value: (snapshot) => snapshot.limits.maxInFlightTokens,
      },
      {
        name: "tyr_pool_admission_class_admitted_total",
        type: "counter",
        help: "Successful admissions attributed to a bounded admission class.",
        value: (snapshot) => snapshot.admitted,
      },
      {
        name: "tyr_pool_admission_class_released_total",
        type: "counter",
        help: "Released admissions attributed to a bounded admission class.",
        value: (snapshot) => snapshot.released,
      },
      {
        name: "tyr_pool_admission_class_borrowed_slot_deadlines_total",
        type: "counter",
        // Per-class stats carry no cause split upstream, so this counts every
        // early slot return for the class. Tyr never abandons manually, so
        // that equals the deadline count unless an embedder abandons itself.
        help: "Borrowed local admission slots returned before settlement for this bounded class.",
        value: (snapshot) => snapshot.borrowedConcurrencyAbandoned,
      },
      {
        name: "tyr_pool_admission_class_rejected_total",
        type: "counter",
        help: "Rejected admissions attributed to a bounded admission class.",
        value: (snapshot) => snapshot.rejected,
      },
      {
        name: "tyr_pool_admission_class_borrowed_admissions_total",
        type: "counter",
        help: "Admissions whose concurrency slot came from shared class capacity.",
        value: (snapshot) => snapshot.totalBorrowedAdmissions,
      },
      {
        name: "tyr_pool_admission_class_borrowed_tokens_reserved_total",
        type: "counter",
        help: "Reservation tokens placed in shared class capacity at admission time.",
        value: (snapshot) => snapshot.totalBorrowedTokensReserved,
      },
    ];

    for (const metric of admissionClassMetrics) {
      addMetricHeader(lines, metric.name, metric.type, metric.help);
      for (const pool of poolNames) {
        const classes = stats[pool]?.admissionClasses?.classes;
        if (classes === undefined) continue;
        for (const admissionClass of Object.keys(classes).sort()) {
          const snapshot = classes[admissionClass];
          if (snapshot === undefined) continue;
          const value = metric.value(snapshot);
          if (value !== undefined) {
            addSample(lines, metric.name, value, {
              pool,
              admission_class: admissionClass,
            });
          }
        }
      }
    }

    const tokenMetrics: Array<{
      name: string;
      type: "counter" | "gauge";
      help: string;
      value: (snapshot: NonNullable<TyrPoolStats["tokenBudget"]>) => number;
    }> = [
      {
        name: "tyr_pool_token_budget",
        type: "gauge",
        help: "Configured in-flight token budget.",
        value: (snapshot) => snapshot.budget,
      },
      {
        name: "tyr_pool_tokens_in_flight",
        type: "gauge",
        help: "Tokens currently held by active admissions.",
        value: (snapshot) => snapshot.inFlightTokens,
      },
      {
        name: "tyr_pool_tokens_available",
        type: "gauge",
        help: "Tokens currently available for normal-priority admission.",
        value: (snapshot) => snapshot.available,
      },
      {
        name: "tyr_pool_high_priority_reserve",
        type: "gauge",
        help: "Token headroom reserved for high-priority requests.",
        value: (snapshot) => snapshot.highPriorityReserve,
      },
      {
        name: "tyr_pool_tokens_reserved_total",
        type: "counter",
        help: "Cumulative tokens reserved at admission.",
        value: (snapshot) => snapshot.totalReserved,
      },
      {
        name: "tyr_pool_tokens_consumed_total",
        type: "counter",
        help: "Cumulative provider-reported token consumption.",
        value: (snapshot) => snapshot.totalConsumed,
      },
      {
        name: "tyr_pool_tokens_refunded_total",
        type: "counter",
        help: "Cumulative tokens returned through usage reconciliation.",
        value: (snapshot) => snapshot.totalRefunded,
      },
      {
        name: "tyr_pool_tokens_overrun_total",
        type: "counter",
        help: "Cumulative tokens held beyond original reservations.",
        value: (snapshot) => snapshot.totalOverrun,
      },
    ];

    for (const metric of tokenMetrics) {
      addMetricHeader(lines, metric.name, metric.type, metric.help);
      for (const pool of poolNames) {
        const tokenBudget = stats[pool]?.tokenBudget;
        if (tokenBudget !== undefined) {
          addSample(lines, metric.name, metric.value(tokenBudget), { pool });
        }
      }
    }

    addMetricHeader(lines, "tyr_pool_grant_managed", "gauge", "Whether the current pool revision has Latchflo grant provenance.");
    addMetricHeader(lines, "tyr_pool_controller_epoch", "gauge", "Latchflo controller epoch attached to the current pool revision.");
    addMetricHeader(lines, "tyr_pool_grant_expires_at_seconds", "gauge", "Unix timestamp when the current Latchflo grant expires.");
    for (const pool of poolNames) {
      const current = stats[pool]?.tyr.provenance.current;
      addSample(lines, "tyr_pool_grant_managed", current === undefined ? 0 : 1, {
        pool,
      });
      if (current !== undefined) {
        addSample(lines, "tyr_pool_controller_epoch", current.controllerEpoch, {
          pool,
        });
        addSample(
          lines,
          "tyr_pool_grant_expires_at_seconds",
          Date.parse(current.expiresAt) / 1_000,
          { pool },
        );
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  #increment(target: Map<string, CounterSeries>, labels: Labels): void {
    const key = labelsKey(labels);
    const current = target.get(key);
    if (current === undefined) {
      target.set(key, { labels: { ...labels }, value: 1 });
    } else {
      current.value += 1;
    }
  }

  #observe(
    target: Map<string, HistogramSeries>,
    labels: Labels,
    rawValue: number,
    bucketBounds: readonly number[],
  ): void {
    const value = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : 0;
    const key = labelsKey(labels);
    let current = target.get(key);
    if (current === undefined) {
      current = {
        labels: { ...labels },
        count: 0,
        sum: 0,
        buckets: bucketBounds.map(() => 0),
      };
      target.set(key, current);
    }
    current.count += 1;
    current.sum += value;
    const bucketIndex = bucketBounds.findIndex((bucket) => value <= bucket);
    if (bucketIndex >= 0) {
      current.buckets[bucketIndex] =
        (current.buckets[bucketIndex] ?? 0) + 1;
    }
  }
}
