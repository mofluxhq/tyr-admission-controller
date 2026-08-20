import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGateway } from "../dist/server.js";
import {
  createPools,
  MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS,
} from "../dist/pools.js";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_verify",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
    );
  });
});
const upstreamUrl = await listen(upstream);

const { server, control } = createGateway({
  upstreamUrl,
  pools: [
    {
      name: "managed",
      modelPrefixes: ["claude"],
      model: "claude-sonnet-4",
      maxConcurrent: 1,
      initialRevision: 0,
      budget: 10_000,
      adaptiveEstimation: { enabled: false },
    },
  ],
});
const gatewayUrl = await listen(server);

try {
  const grant = {
    source: "latchflo",
    grantId: "verify-successor-grant",
    controllerEpoch: 9,
    revision: 12,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const applied = control.applyLimits([
    {
      pool: "managed",
      limits: {
        revision: 12,
        maxConcurrent: 4,
        maxQueue: 0,
        tokenBudget: { budget: 40_000, highPriorityReserve: 0 },
      },
      provenance: grant,
    },
  ]);
  assert.equal(applied.applied, true);

  const response = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "do-not-retain-this-prompt" }],
    }),
  });
  assert.equal(response.status, 200);
  const admissionId = response.headers.get("x-admission-id");
  assert.ok(admissionId);
  assert.equal(response.headers.get("x-admission-revision"), "12");
  assert.equal(response.headers.get("x-latchflo-grant-id"), grant.grantId);
  await response.text();

  const statsResponse = await fetch(`${gatewayUrl}/stats`);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  const evidence = stats.managed.tyr.admissionProvenance;
  assert.equal(evidence.captureFailures, 0);
  assert.equal(evidence.dropped, 0);
  assert.equal(evidence.retained, 1);
  assert.equal(evidence.nextSequence, 2);
  assert.equal(evidence.events.length, 1);
  const event = evidence.events[0];
  assert.equal(event.schema, "tyr.admission-provenance.v1");
  assert.equal(event.sequence, 1);
  assert.equal(event.admissionId, admissionId);
  assert.equal(event.pool, "managed");
  assert.equal(event.limitRevision, 12);
  assert.equal(event.limits.revision, 12);
  assert.equal(event.limits.maxConcurrent, 4);
  assert.equal(event.limits.tokenBudget?.budget, 40_000);
  assert.equal(event.grant?.grantId, grant.grantId);
  assert.equal(event.grant?.controllerEpoch, 9);
  assert.equal(Date.parse(event.admittedAt) > 0, true);
  assert.equal(JSON.stringify(evidence).includes("do-not-retain-this-prompt"), false);

  const metricsResponse = await fetch(`${gatewayUrl}/metrics`);
  const metrics = await metricsResponse.text();
  assert.equal(metrics.includes("admission_id="), false);
  assert.equal(metrics.includes("grant_id="), false);

  // Prove the pool-level event is visible before the upstream callback starts.
  const localPools = createPools([
    {
      name: "local",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
    },
  ]);
  try {
    const local = localPools.get("local");
    assert.ok(local);
    const localRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "local" }],
      max_tokens: 0,
    };
    await local.run(
      localRequest,
      local.prepare(localRequest, "normal"),
      async (_signal, context) => {
        const localEvidence = local.stats().tyr.admissionProvenance;
        assert.equal(localEvidence.events.length, 1);
        assert.equal(localEvidence.events[0]?.admissionId, context?.admissionId);
      },
      { priority: "normal" },
    );
  } finally {
    localPools.close();
  }

  // A request queued under an older revision must be attributed to the exact
  // expansion grant that wakes it, not to the revision under which it queued.
  const expansionPools = createPools([
    {
      name: "queued-expansion",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      maxQueue: 1,
      initialRevision: 0,
      budget: 10_000,
      adaptiveEstimation: { enabled: false },
    },
  ]);
  try {
    const expansion = expansionPools.get("queued-expansion");
    assert.ok(expansion);
    let releaseFirst;
    const firstBlocked = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted;
    const firstDidStart = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const firstRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "first" }],
      max_tokens: 0,
    };
    const first = expansion.run(
      firstRequest,
      expansion.prepare(firstRequest, "normal"),
      async () => {
        firstStarted();
        await firstBlocked;
      },
      { priority: "normal" },
    );
    await firstDidStart;
    assert.equal(expansion.stats().bulkhead.inFlight, 1);
    assert.equal(expansion.stats().tyr.admissionProvenance.events[0]?.limitRevision, 0);

    let queuedAdmissionId;
    const queuedRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "queued" }],
      max_tokens: 0,
    };
    const queued = expansion.run(
      queuedRequest,
      expansion.prepare(queuedRequest, "normal"),
      async (_signal, context) => {
        queuedAdmissionId = context?.admissionId;
      },
      { priority: "normal" },
    );
    for (let i = 0; i < 50 && expansion.stats().bulkhead.pending !== 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(expansion.stats().bulkhead.pending, 1);

    const expansionGrant = {
      source: "latchflo",
      grantId: "verify-queued-expansion-grant",
      controllerEpoch: 11,
      revision: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const expanded = expansionPools.applyLimits([
      {
        pool: "queued-expansion",
        limits: {
          revision: 1,
          maxConcurrent: 2,
          maxQueue: 1,
          tokenBudget: { budget: 10_000, highPriorityReserve: 0 },
        },
        provenance: expansionGrant,
      },
    ]);
    assert.equal(expanded.applied, true);
    await queued;

    const expansionEvidence = expansion.stats().tyr.admissionProvenance;
    assert.equal(expansionEvidence.events.length, 2);
    assert.equal(expansionEvidence.events[0]?.limitRevision, 0);
    assert.equal(expansionEvidence.events[1]?.admissionId, queuedAdmissionId);
    assert.equal(expansionEvidence.events[1]?.limitRevision, 1);
    assert.equal(expansionEvidence.events[1]?.limits.revision, 1);
    assert.equal(expansionEvidence.events[1]?.limits.maxConcurrent, 2);
    assert.equal(expansionEvidence.events[1]?.grant?.grantId, expansionGrant.grantId);
    assert.equal(expansionEvidence.events[1]?.grant?.revision, 1);

    releaseFirst();
    await first;
  } finally {
    expansionPools.close();
  }

  // Observe-mode bypasses never masquerade as successful admissions.
  const observePools = createPools([
    {
      name: "observe",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 0,
      admissionMode: "observe",
    },
  ]);
  try {
    const observe = observePools.get("observe");
    assert.ok(observe);
    const observeRequest = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "observe" }],
      max_tokens: 0,
    };
    await observe.run(
      observeRequest,
      observe.prepare(observeRequest, "normal"),
      async () => undefined,
      { priority: "normal" },
    );
    assert.equal(observe.stats().tyr.admissionProvenance.retained, 0);
  } finally {
    observePools.close();
  }

  // Retention is fixed-size and reports loss instead of growing unbounded.
  const boundedPools = createPools([
    {
      name: "bounded",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
    },
  ]);
  try {
    const bounded = boundedPools.get("bounded");
    assert.ok(bounded);
    for (let index = 0; index <= MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS; index += 1) {
      const boundedRequest = {
        model: "gpt-4o",
        messages: [{ role: "user", content: String(index) }],
        max_tokens: 0,
      };
      await bounded.run(
        boundedRequest,
        bounded.prepare(boundedRequest, "normal"),
        async () => undefined,
        { priority: "normal" },
      );
    }
    const boundedEvidence = bounded.stats().tyr.admissionProvenance;
    assert.equal(boundedEvidence.retained, MAX_RETAINED_ADMISSION_PROVENANCE_EVENTS);
    assert.equal(boundedEvidence.dropped, 1);
    assert.equal(boundedEvidence.events[0]?.sequence, 2);
  } finally {
    boundedPools.close();
  }

  console.log("exact admission provenance verification passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
}
