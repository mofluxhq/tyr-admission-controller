import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "../src/server.js";
import type { TyrUpstreamFailureEvent } from "../src/telemetry.js";
import { describeUpstreamFailure } from "../src/upstream-failure.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  const url = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

async function startGateway(upstreamUrl: string, events: TyrUpstreamFailureEvent[]) {
  const gateway = createGateway({
    upstreamUrl,
    telemetry: { metricsEnabled: true, diagnosticSink: (event) => events.push(event) },
    pools: [
      { name: "test-pool", modelPrefixes: ["claude"], model: "claude-sonnet-4", maxConcurrent: 4 },
    ],
  });
  const url = await listen(gateway.server);
  return { ...gateway, url };
}

const message = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
});

describe("describeUpstreamFailure", () => {
  it("names the transport code that fetch hides behind 'fetch failed'", () => {
    const failure = describeUpstreamFailure(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:18000"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      }),
    );
    expect(failure).toEqual({
      name: "TypeError",
      code: "ECONNREFUSED",
      causeName: "Error",
      syscall: "connect",
      detail: "connect ECONNREFUSED 10.0.0.7:18000",
    });
  });

  it("prefers the deepest code on the cause chain", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const socket = Object.assign(new Error("other side closed", { cause: reset }), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    const failure = describeUpstreamFailure(new TypeError("fetch failed", { cause: socket }));
    expect(failure.code).toBe("ECONNRESET");
    expect(failure.detail).toBe("read ECONNRESET");
  });

  it("keeps unbounded values out of the code and name", () => {
    const failure = describeUpstreamFailure(
      Object.assign(new Error("boom"), { code: "econnreset; drop", name: "Bad Name!" }),
    );
    expect(failure.code).toBe("unknown");
    expect(failure.name).toBe("Error");
    expect(describeUpstreamFailure("x".repeat(1_000)).detail).toHaveLength(300);
  });
});

describe("upstream failure diagnostics", () => {
  it("returns the transport code for a refused upstream connection", async () => {
    const events: TyrUpstreamFailureEvent[] = [];
    const gw = await startGateway(await closedPortUrl(), events);
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: message,
      });
      expect(res.status).toBe(502);
      const text = await res.text();
      const body = JSON.parse(text) as {
        error: { type: string; message: string; cause?: { name: string; code: string } };
      };
      expect(body.error).toEqual({
        type: "upstream_error",
        message: "fetch failed",
        cause: { name: "Error", code: "ECONNREFUSED" },
      });
      expect(text).not.toContain("127.0.0.1");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        schema: "tyr.diagnostic.v1",
        event: "upstream_failure",
        pool: "test-pool",
        provider: "anthropic",
        afterHeaders: false,
        name: "TypeError",
        code: "ECONNREFUSED",
        syscall: "connect",
      });
      expect(events[0]?.detail).toContain("ECONNREFUSED");

      const metrics = await (await fetch(`${gw.url}/metrics`)).text();
      expect(metrics).toMatch(
        /tyr_upstream_failures_total\{code="ECONNREFUSED",pool="test-pool",provider="anthropic"\} 1/,
      );
    } finally {
      await gw.shutdown();
    }
  });

  it("returns the transport code when the upstream drops the connection", async () => {
    const upstream = createServer((req) => {
      req.resume();
      req.on("end", () => req.socket.destroy());
    });
    const upstreamUrl = await listen(upstream);
    const events: TyrUpstreamFailureEvent[] = [];
    const gw = await startGateway(upstreamUrl, events);
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: message,
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { cause?: { code: string } } };
      expect(["UND_ERR_SOCKET", "ECONNRESET"]).toContain(body.error.cause?.code);
      expect(events.map((event) => event.code)).toEqual([body.error.cause?.code]);
    } finally {
      await gw.shutdown();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
