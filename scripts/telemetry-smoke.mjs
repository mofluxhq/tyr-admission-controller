import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { URL } from "node:url";
import { createLatchfloManagedMode } from "../dist/latchflo.js";
import { createGateway } from "../dist/server.js";
import { TYR_VERSION } from "../dist/version.js";

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

async function request(url, content = "smoke") {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_completion_tokens: 1_000,
      messages: [{ role: "user", content }],
    }),
  });
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

const upstream = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { type: "not_found" } });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = JSON.parse(raw);
  const content = body.messages?.[0]?.content;

  if (content === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (content === "upstream-500") {
    sendJson(res, 500, { error: { type: "upstream_failure" } });
    return;
  }

  sendJson(res, 200, {
    id: "chatcmpl_smoke",
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 30 },
  });
});
const upstreamUrl = await listen(upstream);

const audits = [];
const admitted = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  operatorBearerToken: "operator-secret",
  telemetry: {
    metricsEnabled: true,
    auditEnabled: true,
    auditSink: (event) => audits.push(event),
  },
  pools: [
    {
      name: "smoke",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 2,
      budget: 5_000,
      outputCap: 1_000,
    },
  ],
});
const admittedUrl = await listen(admitted.server);

try {
  const unauthorized = await fetch(`${admittedUrl}/metrics`);
  assert.equal(unauthorized.status, 401);

  const response = await request(admittedUrl);
  assert.equal(response.status, 200);
  await response.text();

  const upstreamFailure = await request(admittedUrl, "upstream-500");
  assert.equal(upstreamFailure.status, 500);
  await upstreamFailure.text();

  const metricsResponse = await fetch(`${admittedUrl}/metrics`, {
    headers: { authorization: "Bearer operator-secret" },
  });
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.equal(TYR_VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.match(metrics, /tyr_build_info\{version="0\.25\.1"\} 1/);
  assert.match(
    metrics,
    /tyr_admission_decisions_total\{admission_class="none",outcome="admitted",pool="smoke",priority="normal"\} 2/,
  );
  assert.match(metrics, /tyr_pool_tokens_consumed_total\{pool="smoke"\} 50/);
  assert.match(metrics, /tyr_pool_progressive_reconciliation_enabled\{pool="smoke"\} 1/);
  assert.match(metrics, /tyr_pool_progressive_usage_reports_total\{pool="smoke"\} 0/);
  assert.match(
    metrics,
    /tyr_upstream_responses_total\{pool="smoke",provider="openai",status_class="5xx"\} 1/,
  );
  assert.match(
    metrics,
    /tyr_requests_total\{outcome="upstream_5xx",pool="smoke",provider="openai"\} 1/,
  );
  assert(!metrics.includes("admission_id="));
  assert(!metrics.includes("grant_id="));
  assert(!metrics.includes("model="));

  assert.equal(audits.length, 2);
  assert.equal(audits[0].outcome, "admitted");
  assert.equal(audits[0].settlement, "completed");
  assert.deepEqual(audits[0].usage, { input: 20, output: 30 });
  assert.equal(audits[1].settlement, "completed");
} finally {
  await close(admitted.server);
}

const rejectedAudits = [];
const rejected = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  telemetry: {
    auditEnabled: true,
    auditSink: (event) => rejectedAudits.push(event),
  },
  pools: [
    {
      name: "closed",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 0,
      budget: 0,
      outputCap: 1_000,
    },
  ],
});
const rejectedUrl = await listen(rejected.server);

try {
  const response = await request(rejectedUrl, "reject");
  assert.equal(response.status, 429);
  assert.equal(rejectedAudits.length, 1);
  assert.equal(rejectedAudits[0].outcome, "rejected");
  assert.equal(rejectedAudits[0].reason, "budget_limit");
} finally {
  await close(rejected.server);
}

const observeAudits = [];
const observed = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  telemetry: {
    auditEnabled: true,
    auditSink: (event) => observeAudits.push(event),
  },
  pools: [
    {
      name: "observe",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 0,
      budget: 0,
      outputCap: 1_000,
      admissionMode: "observe",
    },
  ],
});
const observedUrl = await listen(observed.server);

try {
  const response = await request(observedUrl, "observe");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-admission-outcome"), "bypassed");
  await response.text();

  const metrics = await (await fetch(`${observedUrl}/metrics`)).text();
  assert.match(
    metrics,
    /tyr_admission_decisions_total\{admission_class="none",outcome="bypassed",pool="observe",priority="normal"\} 1/,
  );
  assert.equal(observeAudits.length, 1);
  assert.equal(observeAudits[0].outcome, "bypassed");
  assert.equal(observeAudits[0].settlement, "completed");
} finally {
  await close(observed.server);
}

const timeoutAudits = [];
const timed = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  responseTimeoutMs: 20,
  telemetry: {
    auditEnabled: true,
    auditSink: (event) => timeoutAudits.push(event),
  },
  pools: [
    {
      name: "timeout",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 5_000,
      outputCap: 1_000,
    },
  ],
});
const timedUrl = await listen(timed.server);

try {
  const response = await request(timedUrl, "timeout");
  assert.equal(response.status, 504);
  await response.text();
  assert.equal(timeoutAudits.length, 1);
  assert.equal(timeoutAudits[0].settlement, "response_timeout");

  const metrics = await (await fetch(`${timedUrl}/metrics`)).text();
  assert.match(
    metrics,
    /tyr_requests_total\{outcome="response_timeout",pool="timeout",provider="openai"\} 1/,
  );
} finally {
  await close(timed.server);
}


const auditFailure = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  telemetry: {
    auditEnabled: true,
    auditSink: () => {
      throw new Error("sink unavailable");
    },
  },
  pools: [
    {
      name: "audit-failure",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 5_000,
      outputCap: 1_000,
    },
  ],
});
const auditFailureUrl = await listen(auditFailure.server);

try {
  const response = await request(auditFailureUrl, "audit failure");
  assert.equal(response.status, 200);
  await response.text();
  const metrics = await (await fetch(`${auditFailureUrl}/metrics`)).text();
  assert.match(metrics, /tyr_audit_write_failures_total 1/);
} finally {
  await close(auditFailure.server);
}

const latchfloGateway = createGateway({
  telemetry: { metricsEnabled: true },
  pools: [
    {
      name: "managed",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 0,
      budget: 0,
      outputCap: 1_000,
    },
  ],
});
const managedMode = createLatchfloManagedMode({
  config: {
    url: "http://latchflo.invalid",
    instanceId: "telemetry-smoke",
    pools: ["managed"],
    bootstrapTokenEnv: "LATCHFLO_BOOTSTRAP_TOKEN",
    retryIntervalMs: 1_000,
    retryMaxIntervalMs: 1_000,
    requestTimeoutMs: 100,
  },
  control: latchfloGateway.control,
  env: { LATCHFLO_BOOTSTRAP_TOKEN: "bootstrap" },
  fetch: async () => new globalThis.Response("temporary failure", { status: 503 }),
  random: () => 0,
  logger: silentLogger(),
  onFailure: (event) => {
    latchfloGateway.telemetry.recordLatchfloFailure(event);
    throw new Error("observer unavailable");
  },
});

managedMode.start();
await new Promise((resolve) => setTimeout(resolve, 25));
managedMode.stop();
const latchfloMetrics = latchfloGateway.telemetry.renderPrometheus(
  latchfloGateway.control.stats(),
  false,
);
assert.match(
  latchfloMetrics,
  /tyr_latchflo_failures_total\{operation="startup",reason="retryable"\} 1/,
);

await close(upstream);
console.log("telemetry smoke passed");
