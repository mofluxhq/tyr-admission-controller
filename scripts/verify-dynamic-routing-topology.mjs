import assert from "node:assert/strict";
import { createServer } from "node:http";
import { URL } from "node:url";
import { createGateway } from "../dist/server.js";
import { LatchfloTyrAgent } from "../dist/latchflo.js";
import { TYR_ROUTING_CAPACITY_PATH, TYR_ROUTING_TOKEN_HEADER } from "../dist/routing.js";

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

// First prove the Latchflo 0.13 desired-state wire shape is accepted and
// normalized before it reaches Tyr's routing control surface.
let observedTopology;
const desiredState = {
  controllerEpoch: 7,
  serverTime: new Date().toISOString(),
  heartbeatIntervalMs: 5_000,
  pollIntervalMs: 2_000,
  routingTopology: {
    revision: 42,
    members: [
      { instanceId: "tyr-a", endpoint: "http://tyr-a:8787/" },
      { instanceId: "tyr-b", endpoint: "http://tyr-b:8787" },
    ],
  },
  grants: [],
};
const wireAgent = new LatchfloTyrAgent({
  controlPlaneUrl: "http://latchflo.invalid",
  instanceId: "tyr-a",
  pools: ["interactive"],
  agentToken: "persisted-agent-token",
  control: {
    limits: () => ({ interactive: { revision: 0, maxConcurrent: 0, maxQueue: 0 } }),
    stats: () => ({}),
    applyLimits: () => ({ applied: true, results: [] }),
  },
  fetch: async (url) => {
    assert.match(String(url), /\/v1\/agents\/tyr-a\/desired-state$/);
    return new globalThis.Response(JSON.stringify(desiredState), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
  onRoutingTopology: (topology) => {
    observedTopology = topology;
  },
  logger: { log() {}, warn() {}, error() {} },
});
await wireAgent.start();
wireAgent.stop();
assert.deepEqual(observedTopology, {
  revision: 42,
  members: [
    { instanceId: "tyr-a", endpoint: "http://tyr-a:8787" },
    { instanceId: "tyr-b", endpoint: "http://tyr-b:8787" },
  ],
});

const upstreamServer = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "dynamic-topology",
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
    );
  });
});
const upstream = await listen(upstreamServer);

const makePeer = (instanceId) =>
  createGateway({
    openaiUpstreamUrl: upstream,
    capacityRouting: {
      instanceId,
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
      },
    ],
  });

const peerB = makePeer("tyr-b");
const peerBUrl = await listen(peerB.server);
let peerBPolls = 0;
peerB.server.on("request", (req) => {
  if (
    req.method === "GET" &&
    new URL(req.url ?? "/", "http://internal").pathname === TYR_ROUTING_CAPACITY_PATH &&
    req.headers[TYR_ROUTING_TOKEN_HEADER] === SECRET
  ) {
    peerBPolls += 1;
  }
});

const ingress = createGateway({
  openaiUpstreamUrl: upstream,
  capacityRouting: {
    instanceId: "tyr-a",
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
      maxConcurrent: 1,
      budget: 500,
    },
  ],
});
const ingressUrl = await listen(ingress.server);
assert.ok(ingress.routing, "capacity routing control surface must be present");

const request = () =>
  fetch(`${ingressUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 1_000,
      messages: [{ role: "user", content: "dynamic fleet membership" }],
    }),
  });

let peerE;
try {
  assert.equal(
    ingress.routing.applyTopology({
      revision: 10,
      peers: [
        { id: "tyr-a", baseUrl: ingressUrl },
        { id: "tyr-b", baseUrl: peerBUrl },
      ],
    }),
    true,
  );
  await waitUntil(() => peerBPolls >= 1);
  const routedToB = await request();
  assert.equal(routedToB.status, 200, await routedToB.text());
  assert.equal(routedToB.headers.get("x-tyr-routed-to"), "tyr-b");

  // A complete newer topology removes B immediately. Its previously cached
  // capacity must not remain eligible after membership removal.
  assert.equal(
    ingress.routing.applyTopology({
      revision: 11,
      peers: [{ id: "tyr-a", baseUrl: ingressUrl }],
    }),
    true,
  );
  const afterRemoval = await request();
  assert.equal(afterRemoval.status, 429, await afterRemoval.text());
  assert.equal(afterRemoval.headers.get("x-tyr-routed-to"), null);

  // Delayed topology must not resurrect a removed peer.
  assert.equal(
    ingress.routing.applyTopology({
      revision: 10,
      peers: [
        { id: "tyr-a", baseUrl: ingressUrl },
        { id: "tyr-b", baseUrl: peerBUrl },
      ],
    }),
    false,
  );
  const afterStaleRevision = await request();
  assert.equal(afterStaleRevision.status, 429, await afterStaleRevision.text());

  // A replacement with a new identity joins through a newer topology and must
  // earn a fresh capacity snapshot before it can receive traffic.
  peerE = makePeer("tyr-e");
  const peerEUrl = await listen(peerE.server);
  let peerEPolls = 0;
  peerE.server.on("request", (req) => {
    if (
      req.method === "GET" &&
      new URL(req.url ?? "/", "http://internal").pathname === TYR_ROUTING_CAPACITY_PATH &&
      req.headers[TYR_ROUTING_TOKEN_HEADER] === SECRET
    ) {
      peerEPolls += 1;
    }
  });
  assert.equal(
    ingress.routing.applyTopology({
      revision: 12,
      peers: [
        { id: "tyr-a", baseUrl: ingressUrl },
        { id: "tyr-e", baseUrl: peerEUrl },
      ],
    }),
    true,
  );
  await waitUntil(() => peerEPolls >= 1);
  const routedToE = await request();
  assert.equal(routedToE.status, 200, await routedToE.text());
  assert.equal(routedToE.headers.get("x-tyr-routed-to"), "tyr-e");

  console.log("PASS dynamic Latchflo routing-topology verification");
} finally {
  await ingress.shutdown();
  await peerB.shutdown();
  if (peerE !== undefined) await peerE.shutdown();
  upstreamServer.close();
}
