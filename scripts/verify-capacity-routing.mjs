import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfigFile } from "../dist/config.js";
import { createGateway } from "../dist/server.js";
import {
  TYR_ROUTING_CAPACITY_PATH,
  TYR_ROUTING_TOKEN_HEADER,
  chooseCapacityCandidate,
  scoreCapacityCandidate,
} from "../dist/routing.js";

const SECRET = "test-routing-secret-32-characters";
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const reservation = { input: 500, maxOutput: 2_500, reserved: 3_000 };
const basePool = {
  revision: 1,
  admissionMode: "enforce",
  closed: false,
  maxConcurrent: 8,
  inFlight: 2,
  pending: 0,
  maxQueue: 0,
  availableConcurrency: 6,
  tokenBudget: {
    budget: 10_000,
    inFlightTokens: 2_000,
    normalAvailable: 8_000,
    highAvailable: 8_000,
  },
};
const localCandidate = scoreCapacityCandidate({
  instanceId: "tyr-a",
  local: true,
  pool: {
    ...basePool,
    tokenBudget: {
      budget: 10_000,
      inFlightTokens: 6_500,
      normalAvailable: 3_500,
      highAvailable: 3_500,
    },
  },
  priority: "normal",
  reservation,
});
const peerCandidate = scoreCapacityCandidate({
  instanceId: "tyr-b",
  local: false,
  baseUrl: "http://tyr-b:8787",
  pool: basePool,
  priority: "normal",
  reservation,
});
assert.equal(
  chooseCapacityCandidate([localCandidate, peerCandidate]).instanceId,
  "tyr-b",
);
assert.equal(
  chooseCapacityCandidate([
    peerCandidate,
    scoreCapacityCandidate({
      instanceId: "tyr-a",
      local: true,
      pool: basePool,
      priority: "normal",
      reservation,
    }),
  ]).instanceId,
  "tyr-a",
);
assert.equal(
  scoreCapacityCandidate({
    instanceId: "tyr-observe",
    local: false,
    baseUrl: "http://tyr-observe:8787",
    pool: { ...basePool, admissionMode: "observe" },
    priority: "normal",
    reservation,
  }).admissible,
  false,
);

const configDir = mkdtempSync(join(tmpdir(), "tyr-routing-check-"));
try {
  const configPath = join(configDir, "tyr.yaml");
  writeFileSync(
    configPath,
    `version: 1
identity:
  jwt:
    jwksUrl: https://identity.example.com/jwks.json
    issuer: https://identity.example.com/
    audience: tyr
    requestTimeoutMs: 2500
routing:
  capacityAware:
    instanceId: tyr-a
    sharedSecretEnv: TYR_ROUTING_SECRET
    peers:
      - id: tyr-b
        baseUrl: http://tyr-b:8787
upstreams:
  openai:
    baseUrl: http://127.0.0.1:9000
pools:
  - name: interactive
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 2
`,
  );
  const config = loadRuntimeConfigFile(configPath, {
    TYR_ROUTING_SECRET: SECRET,
  });
  assert.equal(config.gateway.capacityRouting.instanceId, "tyr-a");
  assert.equal(config.gateway.capacityRouting.peers[0].id, "tyr-b");
  assert.equal(typeof config.gateway.identity.authenticate, "function");

  const controlPlanePath = join(configDir, "managed.yaml");
  writeFileSync(
    controlPlanePath,
    `version: 1
upstreams:
  openai:
    baseUrl: http://127.0.0.1:9000
pools:
  - name: interactive
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 0
    maxQueue: 0
    limitsRevision: 0
    admissionMode: enforce
controlPlane:
  type: latchflo
  url: http://127.0.0.1:8080
  instanceId: tyr-a
  requestTimeoutMs: 1500
`,
  );
  assert.equal(
    loadRuntimeConfigFile(controlPlanePath, {}).controlPlane.requestTimeoutMs,
    1_500,
  );
} finally {
  rmSync(configDir, { recursive: true, force: true });
}

let upstreamIdentityHeader;
const upstreamServer = createServer((req, res) => {
  const identity = req.headers["x-tyr-identity-token"];
  upstreamIdentityHeader = typeof identity === "string" ? identity : undefined;
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "routed",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
    );
  });
});
const upstream = await listen(upstreamServer);

const peer = createGateway({
  openaiUpstreamUrl: upstream,
  resolveAdmissionClass: () => "standard",
  capacityRouting: {
    instanceId: "tyr-b",
    sharedSecret: SECRET,
    peers: [],
    pollIntervalMs: 20,
    staleAfterMs: 200,
    probeTimeoutMs: 100,
    forwardTimeoutMs: 2_000,
  },
  pools: [
    {
      name: "interactive",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 4,
      budget: 10_000,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          standard: { maxConcurrent: 4, maxInFlightTokens: 10_000 },
          premium: { maxConcurrent: 4, maxInFlightTokens: 10_000 },
        },
      },
    },
  ],
});
const peerUrl = await listen(peer.server);

const ingress = createGateway({
  openaiUpstreamUrl: upstream,
  resolveAdmissionClass: () => "premium",
  capacityRouting: {
    instanceId: "tyr-a",
    sharedSecret: SECRET,
    peers: [{ id: "tyr-b", baseUrl: peerUrl }],
    pollIntervalMs: 20,
    staleAfterMs: 200,
    probeTimeoutMs: 100,
    forwardTimeoutMs: 2_000,
  },
  pools: [
    {
      name: "interactive",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 1_500,
      admissionClasses: {
        defaultClass: "standard",
        classes: {
          standard: { maxConcurrent: 1, maxInFlightTokens: 1_500 },
          premium: { maxConcurrent: 1, maxInFlightTokens: 1_500 },
        },
      },
    },
  ],
});
const ingressUrl = await listen(ingress.server);

try {
  assert.equal(
    (await fetch(`${peerUrl}${TYR_ROUTING_CAPACITY_PATH}`)).status,
    401,
  );
  const snapshotResponse = await fetch(
    `${peerUrl}${TYR_ROUTING_CAPACITY_PATH}`,
    { headers: { [TYR_ROUTING_TOKEN_HEADER]: SECRET } },
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshot.instanceId, "tyr-b");
  assert.equal(snapshot.ready, true);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await fetch(`${ingressUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 1_000,
      messages: [{ role: "user", content: "route this request" }],
    }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.equal(response.headers.get("x-tyr-routed-by"), "tyr-a");
  assert.equal(response.headers.get("x-tyr-routed-to"), "tyr-b");
  assert.equal(response.headers.get("x-admission-class"), "premium");
  assert.equal(ingress.control.stats().interactive.llm.admitted, 0);
  assert.equal(peer.control.stats().interactive.llm.admitted, 1);

  const spoofed = await fetch(`${peerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tyr-routing-hop": "1",
      "x-tyr-routing-source": "attacker",
      "x-tyr-routing-priority": "high",
      "x-tyr-routing-token": "wrong",
    },
    body: "{}",
  });
  assert.equal(spoofed.status, 401);

  let releaseHeld;
  const controlledUpstream = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let completed = false;
      const complete = () => {
        if (completed) return;
        completed = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "dynamic-route",
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
          }),
        );
      };
      if (body.includes("hold local")) releaseHeld = complete;
      else complete();
    });
  });
  const controlledUpstreamUrl = await listen(controlledUpstream);
  const dynamicPeer = createGateway({
    openaiUpstreamUrl: controlledUpstreamUrl,
    capacityRouting: {
      instanceId: "tyr-dynamic-b",
      sharedSecret: SECRET,
      peers: [],
      pollIntervalMs: 20,
      staleAfterMs: 200,
    },
    pools: [
      {
        name: "interactive",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
      },
    ],
  });
  const dynamicPeerUrl = await listen(dynamicPeer.server);
  const dynamicIngress = createGateway({
    openaiUpstreamUrl: controlledUpstreamUrl,
    capacityRouting: {
      instanceId: "tyr-dynamic-a",
      sharedSecret: SECRET,
      peers: [{ id: "tyr-dynamic-b", baseUrl: dynamicPeerUrl }],
      pollIntervalMs: 20,
      staleAfterMs: 200,
    },
    pools: [
      {
        name: "interactive",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
      },
    ],
  });
  const dynamicIngressUrl = await listen(dynamicIngress.server);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const heldResponse = fetch(`${dynamicIngressUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 100,
        messages: [{ role: "user", content: "hold local" }],
      }),
    });
    await waitUntil(
      () => dynamicIngress.control.stats().interactive.bulkhead.inFlight === 1,
    );
    const routedResponse = await fetch(
      `${dynamicIngressUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 100,
          messages: [{ role: "user", content: "use peer capacity" }],
        }),
      },
    );
    assert.equal(routedResponse.status, 200, await routedResponse.text());
    assert.equal(
      routedResponse.headers.get("x-tyr-routed-to"),
      "tyr-dynamic-b",
    );
    releaseHeld?.();
    const localResponse = await heldResponse;
    assert.equal(localResponse.status, 200, await localResponse.text());
    assert.equal(localResponse.headers.get("x-tyr-routed-to"), null);
    assert.equal(dynamicIngress.control.stats().interactive.llm.admitted, 1);
    assert.equal(dynamicPeer.control.stats().interactive.llm.admitted, 1);
  } finally {
    releaseHeld?.();
    await dynamicIngress.shutdown();
    await dynamicPeer.shutdown();
    controlledUpstream.close();
  }

  const authenticate = Object.assign(
    (req) => {
      assert.equal(req.headers["x-tyr-identity-token"], "Bearer user-token");
      return {
        subject: "user-1",
        roles: ["tyr.invoke", "tyr.priority.high"],
      };
    },
    { credentialHeader: "x-tyr-identity-token" },
  );
  const priorityPeer = createGateway({
    openaiUpstreamUrl: upstream,
    identity: {
      authenticate,
      invokeRoles: ["tyr.invoke"],
      highPriorityRoles: ["tyr.priority.high"],
    },
    capacityRouting: {
      instanceId: "tyr-priority-b",
      sharedSecret: SECRET,
      peers: [],
      pollIntervalMs: 20,
      staleAfterMs: 200,
    },
    pools: [
      {
        name: "interactive",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 2,
        budget: 2_500,
        highPriorityReserve: 2_000,
      },
    ],
  });
  const priorityPeerUrl = await listen(priorityPeer.server);
  const priorityIngress = createGateway({
    openaiUpstreamUrl: upstream,
    identity: {
      authenticate,
      invokeRoles: ["tyr.invoke"],
      highPriorityRoles: ["tyr.priority.high"],
    },
    capacityRouting: {
      instanceId: "tyr-priority-a",
      sharedSecret: SECRET,
      peers: [{ id: "tyr-priority-b", baseUrl: priorityPeerUrl }],
      pollIntervalMs: 20,
      staleAfterMs: 200,
    },
    pools: [
      {
        name: "interactive",
        modelPrefixes: ["gpt"],
        model: "gpt-4o",
        maxConcurrent: 1,
        budget: 700,
      },
    ],
  });
  const priorityIngressUrl = await listen(priorityIngress.server);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    upstreamIdentityHeader = "not-called";
    const priorityResponse = await fetch(
      `${priorityIngressUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tyr-identity-token": "Bearer user-token",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 1_000,
          messages: [{ role: "user", content: "preserve high priority" }],
        }),
      },
    );
    assert.equal(priorityResponse.status, 200, await priorityResponse.text());
    assert.equal(
      priorityResponse.headers.get("x-tyr-routed-to"),
      "tyr-priority-b",
    );
    assert.equal(priorityPeer.control.stats().interactive.llm.admitted, 1);
    assert.equal(upstreamIdentityHeader, undefined);
  } finally {
    await priorityIngress.shutdown();
    await priorityPeer.shutdown();
  }

  console.log("PASS capacity-aware routing verification");
} finally {
  await ingress.shutdown();
  await peer.shutdown();
  upstreamServer.close();
}
