import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "../dist/config.js";
import { normalizeAdmissionClassesConfig } from "../dist/admission-policy.js";
import { createPools } from "../dist/pools.js";
import { scoreCapacityCandidate, chooseCapacityCandidate } from "../dist/routing.js";
import { createGateway } from "../dist/server.js";
import { LatchfloTyrAgent } from "../dist/latchflo.js";

const request = (content = "hello") => ({
  model: "gpt-4o",
  messages: [{ role: "user", content }],
  max_tokens: 100,
});
const policy = {
  defaultClass: "standard",
  classes: {
    standard: { maxConcurrent: 1, maxInFlightTokens: 2_000 },
    premium: { maxConcurrent: 1, maxInFlightTokens: 2_000 },
  },
  rules: [
    { admissionClass: "premium", tenantIds: ["tenant-paid"] },
    { admissionClass: "premium", roles: ["tier.premium"] },
  ],
};

assert.throws(
  () =>
    normalizeAdmissionClassesConfig(
      {
        defaultClass: "standard",
        classes: {
          standard: { maxConcurrent: 1 },
          " standard ": { maxConcurrent: 1 },
        },
      },
      "policy",
      false,
    ),
  /duplicate normalized class ID/,
);

assert.throws(
  () =>
    normalizeAdmissionClassesConfig(
      {
        defaultClass: "toString",
        classes: { standard: { maxConcurrent: 1 } },
      },
      "policy",
      false,
    ),
  /defaultClass/,
);
assert.throws(
  () =>
    normalizeAdmissionClassesConfig(
      {
        defaultClass: "standard",
        classes: Object.fromEntries([
          ["standard", { maxConcurrent: 1 }],
          ["__proto__", { maxConcurrent: 1 }],
        ]),
      },
      "policy",
      false,
    ),
  /reserved class ID/,
);

const pools = createPools([
  {
    name: "openai",
    modelPrefixes: ["gpt"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 4_000,
    adaptiveEstimation: { enabled: false },
    admissionClasses: policy,
  },
]);
const pool = pools.get("openai");
assert(pool);
const defaultPreparation = pool.prepare(request("default class"), "normal");
assert.equal(defaultPreparation.admissionClass, "standard");
await assert.rejects(
  pool.run(
    request("default class"),
    defaultPreparation,
    async () => "must not run",
    { priority: "normal", admissionClass: "premium" },
  ),
  /changed between prepare/,
);
assert.equal(
  pool.resolveAdmissionClass({
    subject: "paid-user",
    tenantId: "tenant-paid",
    roles: [],
  }),
  "premium",
);
assert.equal(
  pool.resolveAdmissionClass({ subject: "free-user", roles: [] }),
  "standard",
);

let releasePremium;
const premiumGate = new Promise((resolve) => {
  releasePremium = resolve;
});
const premiumRequest = request("hold premium");
const premiumPreparation = pool.prepare(premiumRequest, "normal", "premium");
const held = pool.run(
  premiumRequest,
  premiumPreparation,
  async () => {
    await premiumGate;
    return "premium-complete";
  },
  { priority: "normal", admissionClass: "premium" },
);
await new Promise((resolve) => setTimeout(resolve, 10));

const blockedPremium = pool.prepare(request("second premium"), "normal", "premium");
assert.equal(blockedPremium.advisory.admit, false);
assert.equal(blockedPremium.advisory.reason, "concurrency_limit");
await assert.rejects(
  pool.run(
    request("second premium"),
    blockedPremium,
    async () => "must not run",
    { priority: "normal", admissionClass: "premium" },
  ),
  (error) => error?.reason === "concurrency_limit",
);
const standardPreparation = pool.prepare(request("standard"), "normal", "standard");
assert.equal(standardPreparation.advisory.admit, true);
assert.equal(
  await pool.run(
    request("standard"),
    standardPreparation,
    async () => "standard-complete",
    { priority: "normal", admissionClass: "standard" },
  ),
  "standard-complete",
);
releasePremium();
assert.equal(await held, "premium-complete");
const classStats = pool.stats().admissionClasses;
assert(classStats);
assert.equal(classStats.defaultClass, "standard");
assert.deepEqual(Object.keys(classStats.classes).sort(), ["premium", "standard"]);

const current = pool.controller.limits();
assert.throws(
  () =>
    pool.controller.applyLimits({
      revision: current.revision + 1,
      maxConcurrent: current.maxConcurrent,
      maxQueue: current.maxQueue,
      tokenBudget: current.tokenBudget,
    }),
  /admissionClasses is required/,
);
const nextClasses = {
  standard: { maxConcurrent: 1, maxInFlightTokens: 1_500 },
  premium: { maxConcurrent: 1, maxInFlightTokens: 2_500 },
};
assert.equal(
  pool.controller.applyLimits({
    revision: current.revision + 1,
    maxConcurrent: current.maxConcurrent,
    maxQueue: current.maxQueue,
    tokenBudget: current.tokenBudget,
    admissionClasses: nextClasses,
  }).applied,
  true,
);

const capacityBase = {
  revision: 1,
  admissionMode: "enforce",
  closed: false,
  maxConcurrent: 4,
  inFlight: 1,
  pending: 0,
  maxQueue: 0,
  availableConcurrency: 3,
  tokenBudget: {
    budget: 4_000,
    inFlightTokens: 500,
    normalAvailable: 3_500,
    highAvailable: 3_500,
  },
  admissionClasses: {
    defaultClass: "standard",
    classes: {
      standard: {
        inFlight: 0,
        maxConcurrent: 1,
        availableConcurrency: 1,
        inFlightTokens: 0,
        maxInFlightTokens: 2_000,
        availableTokens: 2_000,
      },
      premium: {
        inFlight: 1,
        maxConcurrent: 1,
        availableConcurrency: 0,
        inFlightTokens: 500,
        maxInFlightTokens: 2_000,
        availableTokens: 1_500,
      },
    },
  },
};
const reservation = { input: 100, maxOutput: 100, reserved: 200 };
const fullLocal = scoreCapacityCandidate({
  instanceId: "tyr-a",
  local: true,
  pool: capacityBase,
  priority: "normal",
  admissionClass: "premium",
  reservation,
});
const availablePeer = scoreCapacityCandidate({
  instanceId: "tyr-b",
  local: false,
  baseUrl: "http://tyr-b:8787",
  pool: {
    ...capacityBase,
    admissionClasses: {
      ...capacityBase.admissionClasses,
      classes: {
        ...capacityBase.admissionClasses.classes,
        premium: {
          ...capacityBase.admissionClasses.classes.premium,
          inFlight: 0,
          availableConcurrency: 1,
        },
      },
    },
  },
  priority: "normal",
  admissionClass: "premium",
  reservation,
});
assert.equal(fullLocal.admissible, false);
assert.equal(chooseCapacityCandidate([fullLocal, availablePeer])?.instanceId, "tyr-b");

const configDir = mkdtempSync(join(tmpdir(), "tyr-admission-class-check-"));
try {
  const path = join(configDir, "tyr.yaml");
  writeFileSync(
    path,
    `version: 1
upstreams:
  openai:
    baseUrl: http://127.0.0.1:9000
pools:
  - name: openai
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 2
    inFlightTokenBudget: 4000
    admissionClasses:
      defaultClass: standard
      classes:
        standard:
          maxConcurrent: 1
          maxInFlightTokens: 2000
        premium:
          maxConcurrent: 1
          maxInFlightTokens: 2000
      rules:
        - admissionClass: premium
          tenantIds: [tenant-paid]
`,
  );
  const loaded = loadRuntimeConfigFile(path);
  assert.deepEqual(loaded.gateway.pools[0].admissionClasses, {
    ...policy,
    rules: [policy.rules[0]],
  });
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

const managedLimits = {
  openai: {
    revision: 0,
    maxConcurrent: 0,
    maxQueue: 0,
    tokenBudget: { budget: 0, highPriorityReserve: 0 },
    admissionClasses: policy.classes,
  },
};
const appliedManaged = [];
const managedControl = {
  limits: () => ({ ...managedLimits }),
  stats: () => ({}),
  applyLimits(updates) {
    appliedManaged.push(...updates);
    for (const update of updates) managedLimits[update.pool] = update.limits;
    return { applied: true, pools: {} };
  },
};
const grantExpiresAt = new Date(Date.now() + 5_000).toISOString();
const latchflo = new LatchfloTyrAgent({
  controlPlaneUrl: "http://latchflo.invalid",
  instanceId: "tyr-a",
  pools: ["openai"],
  agentToken: "agent-token",
  control: managedControl,
  fetch: (input) => {
    if (String(input).endsWith("/desired-state")) {
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            controllerEpoch: 1,
            serverTime: new Date().toISOString(),
            heartbeatIntervalMs: 10_000,
            pollIntervalMs: 10_000,
            grants: [
              {
                grantId: "00000000-0000-4000-8000-000000000001",
                instanceId: "tyr-a",
                pool: "openai",
                controllerEpoch: 1,
                revision: 1,
                issuedAt: new Date().toISOString(),
                expiresAt: grantExpiresAt,
                limits: {
                  revision: 1,
                  maxConcurrent: 2,
                  maxQueue: 0,
                  tokenBudget: { budget: 4_000, highPriorityReserve: 0 },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new globalThis.Response("{}", { status: 200 }));
  },
  logger: { info() {}, warn() {}, error() {} },
});
await latchflo.start();
assert.equal(latchflo.ready(), true);
assert.deepEqual(appliedManaged[0].limits.admissionClasses, policy.classes);
latchflo.stop();

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
let releaseUpstream;
const upstreamGate = new Promise((resolve) => {
  releaseUpstream = resolve;
});
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (body.includes("hold paid")) await upstreamGate;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "ok",
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
});
const upstreamUrl = await listen(upstream);
const gateway = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  identity: {
    authenticate(req) {
      const tenant = req.headers["x-test-tenant"];
      return {
        subject: `subject:${String(tenant ?? "standard")}`,
        ...(typeof tenant === "string" ? { tenantId: tenant } : {}),
        roles: [],
      };
    },
  },
  telemetry: { metrics: { enabled: true }, audit: { enabled: false } },
  pools: [
    {
      name: "openai",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 2,
      budget: 4_000,
      adaptiveEstimation: { enabled: false },
      admissionClasses: policy,
    },
  ],
});
const gatewayUrl = await listen(gateway.server);
const post = (tenant, content) =>
  fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(tenant === undefined ? {} : { "x-test-tenant": tenant }),
    },
    body: JSON.stringify(request(content)),
  });
try {
  const paidHeld = post("tenant-paid", "hold paid");
  for (let i = 0; i < 100; i += 1) {
    if (gateway.control.stats().openai.bulkhead.inFlight === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const paidRejected = await post("tenant-paid", "second paid");
  assert.equal(paidRejected.status, 429);
  assert.equal(paidRejected.headers.get("x-admission-class"), "premium");
  const standard = await post(undefined, "standard while paid is full");
  assert.equal(standard.status, 200, await standard.text());
  assert.equal(standard.headers.get("x-admission-class"), "standard");
  releaseUpstream();
  const paid = await paidHeld;
  assert.equal(paid.status, 200);
  assert.equal(paid.headers.get("x-admission-class"), "premium");
  const metrics = await (await fetch(`${gatewayUrl}/metrics`)).text();
  assert.match(metrics, /admission_class="premium"/);
  assert.match(metrics, /admission_class="standard"/);
  assert.match(
    metrics,
    /tyr_pool_admission_class_max_concurrent\{admission_class="premium",pool="openai"\} 1/,
  );
  assert.match(
    metrics,
    /tyr_pool_admission_class_rejected_total\{admission_class="premium",pool="openai"\} 1/,
  );
} finally {
  releaseUpstream();
  await gateway.shutdown();
  upstream.close();
}

console.log("admission-class verification passed");
