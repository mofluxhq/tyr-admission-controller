import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway } from "../src/server.js";
import { TYR_ROUTING_CAPACITY_PATH, TYR_ROUTING_TOKEN_HEADER } from "../src/routing.js";

const SECRET = "test-routing-secret-32-characters";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function startUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
  return listen(server).then((url) => ({ server, url }));
}

function requestBody(content = "route this request"): string {
  return JSON.stringify({
    model: "gpt-4o",
    max_tokens: 1_000,
    messages: [{ role: "user", content }],
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let upstream: { server: Server; url: string };

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(() => {
  upstream.server.close();
});

describe("capacity-aware Tyr-to-Tyr routing", () => {
  it("routes once to the replica with more request-specific capacity", async () => {
    const peer = createGateway({
      openaiUpstreamUrl: upstream.url,
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
        },
      ],
    });
    const peerUrl = await listen(peer.server);

    const ingress = createGateway({
      openaiUpstreamUrl: upstream.url,
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
        },
      ],
    });
    const ingressUrl = await listen(ingress.server);

    try {
      const unauthorized = await fetch(
        `${peerUrl}${TYR_ROUTING_CAPACITY_PATH}`,
      );
      expect(unauthorized.status).toBe(401);

      const snapshot = await fetch(
        `${peerUrl}${TYR_ROUTING_CAPACITY_PATH}`,
        { headers: { [TYR_ROUTING_TOKEN_HEADER]: SECRET } },
      );
      expect(snapshot.status).toBe(200);
      expect((await snapshot.json()) as object).toMatchObject({
        schemaVersion: 3,
        instanceId: "tyr-b",
        ready: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 80));
      const response = await fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-tyr-routed-by")).toBe("tyr-a");
      expect(response.headers.get("x-tyr-routed-to")).toBe("tyr-b");
      expect(response.headers.get("x-admission-outcome")).toBe("admitted");

      const ingressStats = ingress.control.stats()["interactive"]!;
      const peerStats = peer.control.stats()["interactive"]!;
      expect(ingressStats.llm.admitted).toBe(0);
      expect(peerStats.llm.admitted).toBe(1);
    } finally {
      await ingress.shutdown();
      await peer.shutdown();
    }
  });



  it("applies newer dynamic topology, removes stale peers immediately, and ignores older revisions", async () => {
    const peer = createGateway({
      openaiUpstreamUrl: upstream.url,
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
          maxConcurrent: 4,
          budget: 10_000,
        },
      ],
    });
    const peerUrl = await listen(peer.server);

    const ingress = createGateway({
      openaiUpstreamUrl: upstream.url,
      capacityRouting: {
        instanceId: "tyr-dynamic-a",
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
          budget: 500,
        },
      ],
    });
    const ingressUrl = await listen(ingress.server);

    try {
      expect(ingress.routing).toBeDefined();
      expect(
        ingress.routing?.applyTopology({
          revision: 10,
          peers: [
            { id: "tyr-dynamic-a", baseUrl: ingressUrl },
            { id: "tyr-dynamic-b", baseUrl: peerUrl },
          ],
        }),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 80));
      const routed = await fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(),
      });
      expect(routed.status).toBe(200);
      expect(routed.headers.get("x-tyr-routed-to")).toBe("tyr-dynamic-b");

      expect(
        ingress.routing?.applyTopology({
          revision: 11,
          peers: [{ id: "tyr-dynamic-a", baseUrl: ingressUrl }],
        }),
      ).toBe(true);

      const afterRemoval = await fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(),
      });
      expect(afterRemoval.status).toBe(429);
      expect(afterRemoval.headers.get("x-tyr-routed-to")).toBeNull();

      expect(
        ingress.routing?.applyTopology({
          revision: 10,
          peers: [{ id: "tyr-dynamic-b", baseUrl: peerUrl }],
        }),
      ).toBe(false);

      const afterStaleRevision = await fetch(
        `${ingressUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody(),
        },
      );
      expect(afterStaleRevision.status).toBe(429);
      expect(afterStaleRevision.headers.get("x-tyr-routed-to")).toBeNull();
    } finally {
      await ingress.shutdown();
      await peer.shutdown();
    }
  });

  it("moves a request to a peer when the local replica becomes full", async () => {
    let releaseHeld: (() => void) | undefined;
    const controlledUpstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
        if (body.includes("hold local")) {
          releaseHeld = complete;
        } else {
          complete();
        }
      });
    });
    const controlledUpstreamUrl = await listen(controlledUpstream);

    const peer = createGateway({
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
    const peerUrl = await listen(peer.server);
    const ingress = createGateway({
      openaiUpstreamUrl: controlledUpstreamUrl,
      capacityRouting: {
        instanceId: "tyr-dynamic-a",
        sharedSecret: SECRET,
        peers: [{ id: "tyr-dynamic-b", baseUrl: peerUrl }],
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
    const ingressUrl = await listen(ingress.server);

    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const heldResponse = fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody("hold local"),
      });
      await waitUntil(
        () => ingress.control.stats()["interactive"]?.bulkhead.inFlight === 1,
      );

      const routed = await fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody("use peer capacity"),
      });
      expect(routed.status).toBe(200);
      expect(routed.headers.get("x-tyr-routed-to")).toBe("tyr-dynamic-b");

      releaseHeld?.();
      const local = await heldResponse;
      expect(local.status).toBe(200);
      expect(local.headers.get("x-tyr-routed-to")).toBeNull();
      expect(ingress.control.stats()["interactive"]?.llm.admitted).toBe(1);
      expect(peer.control.stats()["interactive"]?.llm.admitted).toBe(1);
    } finally {
      releaseHeld?.();
      await ingress.shutdown();
      await peer.shutdown();
      controlledUpstream.close();
    }
  });

  it("preserves authenticated high priority across the private hop and strips identity before upstream", async () => {
    let upstreamIdentityHeader: string | undefined;
    const inspectingUpstream = createServer((req, res) => {
      const value = req.headers["x-tyr-identity-token"];
      upstreamIdentityHeader = typeof value === "string" ? value : undefined;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "priority-routed",
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
          }),
        );
      });
    });
    const inspectingUpstreamUrl = await listen(inspectingUpstream);
    const authenticate = Object.assign(
      (req: IncomingMessage) => {
        if (req.headers["x-tyr-identity-token"] !== "Bearer user-token") {
          throw new Error("missing test identity");
        }
        return {
          subject: "user-1",
          roles: ["tyr.invoke", "tyr.priority.high"],
        };
      },
      { credentialHeader: "x-tyr-identity-token" },
    );

    const peer = createGateway({
      openaiUpstreamUrl: inspectingUpstreamUrl,
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
    const peerUrl = await listen(peer.server);

    const ingress = createGateway({
      openaiUpstreamUrl: inspectingUpstreamUrl,
      identity: {
        authenticate,
        invokeRoles: ["tyr.invoke"],
        highPriorityRoles: ["tyr.priority.high"],
      },
      capacityRouting: {
        instanceId: "tyr-priority-a",
        sharedSecret: SECRET,
        peers: [{ id: "tyr-priority-b", baseUrl: peerUrl }],
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
    const ingressUrl = await listen(ingress.server);

    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const response = await fetch(`${ingressUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tyr-identity-token": "Bearer user-token",
        },
        body: requestBody(),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-tyr-routed-to")).toBe("tyr-priority-b");
      expect(peer.control.stats()["interactive"]?.llm.admitted).toBe(1);
      expect(upstreamIdentityHeader).toBeUndefined();
    } finally {
      await ingress.shutdown();
      await peer.shutdown();
      inspectingUpstream.close();
    }
  });

  it("rejects spoofed internal-routing headers before buffering the body", async () => {
    const gateway = createGateway({
      openaiUpstreamUrl: upstream.url,
      capacityRouting: {
        instanceId: "tyr-c",
        sharedSecret: SECRET,
        peers: [],
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
    const url = await listen(gateway.server);
    try {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tyr-routing-hop": "1",
          "x-tyr-routing-source": "attacker",
          "x-tyr-routing-priority": "high",
          "x-tyr-routing-token": "wrong",
        },
        body: requestBody(),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { type: "routing_unauthorized" },
      });
    } finally {
      await gateway.shutdown();
    }
  });
});
