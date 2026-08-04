import type { LLMPriority, LLMRejectReason, TokenUsage } from "async-bulkhead-llm";
import type { ApiShape } from "./adapters.js";
import type { TyrRequestIdentity } from "./identity.js";
import type { AdmissionProvenance, TyrPoolStats } from "./pools.js";

export type TyrAdmissionOutcome = "admitted" | "bypassed" | "rejected";

export type TyrRequestOutcome =
  | "success"
  | "upstream_4xx"
  | "upstream_5xx"
  | "admission_rejected"
  | "response_timeout"
  | "idle_timeout"
  | "client_disconnect"
  | "client_stall"
  | "upstream_error";

export type TyrAuditSettlement =
  | "completed"
  | "rejected"
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
  readonly grant?: AdmissionProvenance;
  readonly usage?: TokenUsage;
  readonly identity?: TyrRequestIdentity;
};

export type LatchfloFailureOperation =
  | "startup"
  | "heartbeat"
  | "poll"
  | "ack"
  | "expiration";

export type LatchfloFailureReason =
  | "retryable"
  | "permanent"
  | "http_error"
  | "transport_error"
  | "apply_error";

export type TyrTelemetryOptions = {
  /** Expose Prometheus text format at GET /metrics. Default: true. */
  readonly metricsEnabled?: boolean;
  /** Emit one structured JSON audit event per admission decision. Default: false. */
  readonly auditEnabled?: boolean;
  /** Override the default stdout JSON sink, primarily for embedding and tests. */
  readonly auditSink?: (event: TyrAdmissionAuditEvent) => void;
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
): void {
  for (const item of [...series.values()].sort((left, right) =>
    labelsKey(left.labels).localeCompare(labelsKey(right.labels)),
  )) {
    let cumulative = 0;
    for (let index = 0; index < DURATION_BUCKETS_SECONDS.length; index += 1) {
      cumulative += item.buckets[index] ?? 0;
      addSample(lines, `${name}_bucket`, cumulative, {
        ...item.labels,
        le: String(DURATION_BUCKETS_SECONDS[index]),
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
  readonly #admissionDecisions = new Map<string, CounterSeries>();
  readonly #rejections = new Map<string, CounterSeries>();
  readonly #requests = new Map<string, CounterSeries>();
  readonly #upstreamResponses = new Map<string, CounterSeries>();
  readonly #latchfloFailures = new Map<string, CounterSeries>();
  readonly #requestDurations = new Map<string, HistogramSeries>();
  readonly #upstreamDurations = new Map<string, HistogramSeries>();
  #auditWriteFailures = 0;

  constructor(options: TyrTelemetryOptions = {}) {
    this.metricsEnabled = options.metricsEnabled ?? true;
    this.auditEnabled = options.auditEnabled ?? false;
    this.#auditSink =
      options.auditSink ?? ((event) => console.log(JSON.stringify(event)));
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
    this.#observe(this.#requestDurations, labels, input.durationSeconds);
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
    );
  }

  recordLatchfloFailure(input: {
    readonly operation: LatchfloFailureOperation;
    readonly reason: LatchfloFailureReason;
  }): void {
    this.#increment(this.#latchfloFailures, input);
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
    addSample(lines, "tyr_build_info", 1, { version: "0.20.0" });

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

    addMetricHeader(lines, "tyr_requests_total", "counter", "Completed gateway requests by bounded outcome.");
    addCounterSeries(lines, "tyr_requests_total", this.#requests);

    addMetricHeader(lines, "tyr_upstream_responses_total", "counter", "Upstream responses grouped by status class.");
    addCounterSeries(lines, "tyr_upstream_responses_total", this.#upstreamResponses);

    addMetricHeader(lines, "tyr_request_duration_seconds", "histogram", "End-to-end Tyr request duration in seconds.");
    addHistogramSeries(lines, "tyr_request_duration_seconds", this.#requestDurations);

    addMetricHeader(lines, "tyr_upstream_duration_seconds", "histogram", "Total upstream call duration in seconds.");
    addHistogramSeries(lines, "tyr_upstream_duration_seconds", this.#upstreamDurations);

    addMetricHeader(lines, "tyr_latchflo_failures_total", "counter", "Latchflo integration failures by operation and bounded reason.");
    addCounterSeries(lines, "tyr_latchflo_failures_total", this.#latchfloFailures);

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
        name: "tyr_pool_admission_class_rejected_total",
        type: "counter",
        help: "Rejected admissions attributed to a bounded admission class.",
        value: (snapshot) => snapshot.rejected,
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
  ): void {
    const value = Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : 0;
    const key = labelsKey(labels);
    let current = target.get(key);
    if (current === undefined) {
      current = {
        labels: { ...labels },
        count: 0,
        sum: 0,
        buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
      };
      target.set(key, current);
    }
    current.count += 1;
    current.sum += value;
    const bucketIndex = DURATION_BUCKETS_SECONDS.findIndex(
      (bucket) => value <= bucket,
    );
    if (bucketIndex >= 0) {
      current.buckets[bucketIndex] =
        (current.buckets[bucketIndex] ?? 0) + 1;
    }
  }
}
