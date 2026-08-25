import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGateway } from "../dist/server.js";

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function request(url, content = "timing") {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_completion_tokens: 100,
      messages: [{ role: "user", content }],
    }),
  });
}

function metricValue(metrics, name, labels) {
  const labelText = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const prefix = `${name}{${labelText}} `;
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert(line, `missing metric sample: ${prefix}`);
  const value = Number(line.slice(prefix.length));
  assert(Number.isFinite(value), `metric sample is not finite: ${line}`);
  return value;
}

const upstream = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { type: "not_found" } });
    return;
  }
  for await (const chunk of req) {
    // Drain the body before responding.
    void chunk;
  }
  sendJson(res, 200, {
    id: "chatcmpl_timing",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
});
const upstreamUrl = await listen(upstream);

const gateway = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  pools: [
    {
      name: "timing",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 10_000,
      outputCap: 100,
      adaptiveEstimation: { enabled: false },
      admissionClasses: {
        defaultClass: "interactive",
        classes: { interactive: { maxConcurrent: 1 } },
      },
    },
  ],
});
const gatewayUrl = await listen(gateway.server);

try {
  const admitted = await request(gatewayUrl, "admitted");
  assert.equal(admitted.status, 200);
  await admitted.text();

  const current = gateway.control.limits().timing;
  assert(current);
  const applied = gateway.control.applyLimits([
    {
      pool: "timing",
      limits: {
        ...current,
        revision: current.revision + 1,
        tokenBudget: {
          budget: 0,
          highPriorityReserve: 0,
        },
      },
    },
  ]);
  assert.equal(applied.applied, true);

  const rejected = await request(gatewayUrl, "rejected");
  assert.equal(rejected.status, 429);
  await rejected.text();

  const metrics = await (await fetch(`${gatewayUrl}/metrics`)).text();

  for (const outcome of ["admitted", "rejected"]) {
    const timingLabels = {
      admission_class: "interactive",
      outcome,
      pool: "timing",
    };
    const decisionCount = metricValue(
      metrics,
      "tyr_admission_decision_seconds_count",
      timingLabels,
    );
    const queueCount = metricValue(
      metrics,
      "tyr_admission_queue_wait_seconds_count",
      timingLabels,
    );
    const admissionCount = metricValue(metrics, "tyr_admission_decisions_total", {
      admission_class: "interactive",
      outcome,
      pool: "timing",
      priority: "normal",
    });
    assert.equal(decisionCount, admissionCount);
    assert.equal(queueCount, admissionCount);
    assert.equal(decisionCount, 1);
  }

  const admittedDecisionSum = metricValue(
    metrics,
    "tyr_admission_decision_seconds_sum",
    { admission_class: "interactive", outcome: "admitted", pool: "timing" },
  );
  const rejectedDecisionSum = metricValue(
    metrics,
    "tyr_admission_decision_seconds_sum",
    { admission_class: "interactive", outcome: "rejected", pool: "timing" },
  );
  const rejectedQueueSum = metricValue(
    metrics,
    "tyr_admission_queue_wait_seconds_sum",
    { admission_class: "interactive", outcome: "rejected", pool: "timing" },
  );
  assert(admittedDecisionSum > 0, "admitted decision duration must be measured");
  assert(rejectedDecisionSum > 0, "rejected decision duration must be measured");
  assert.equal(
    rejectedQueueSum,
    0,
    "precheck rejection must preserve queueWaitNs === 0 through Tyr telemetry",
  );
  assert.match(
    metrics,
    /tyr_admission_decision_seconds_bucket\{admission_class="interactive",le="0\.000005",outcome="admitted",pool="timing"\}/,
  );
  console.log(
    `PASS enforce timing admitted=${(admittedDecisionSum * 1e6).toFixed(3)}us rejected=${(rejectedDecisionSum * 1e6).toFixed(3)}us`,
  );
} finally {
  await close(gateway.server);
}

const observed = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  pools: [
    {
      name: "observe",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 0,
      outputCap: 100,
      admissionMode: "observe",
      adaptiveEstimation: { enabled: false },
    },
  ],
});
const observedUrl = await listen(observed.server);

try {
  const response = await request(observedUrl, "observe-bypass");
  assert.equal(response.status, 200);
  await response.text();
  const metrics = await (await fetch(`${observedUrl}/metrics`)).text();
  const timingSamples = metrics
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("tyr_admission_decision_seconds_") ||
          line.startsWith("tyr_admission_queue_wait_seconds_")) &&
        !line.startsWith("#"),
    );
  assert.equal(timingSamples.length, 0, "observe-mode bypasses must not emit admission timing");
  assert.equal(observed.control.stats().observe.tyr.admissionProvenance.retained, 0);
  console.log("PASS observe mode emits no admission timing or provenance");
} finally {
  await close(observed.server);
  await close(upstream);
}
