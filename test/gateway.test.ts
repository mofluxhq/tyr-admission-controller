import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "../src/server.js";

// ── Mock upstream: Anthropic-messages-shaped, controllable timing ──

function startMockUpstream(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        stream?: boolean;
        messages: { content: string }[];
      };
      const slow = body.messages[0]?.content.includes("slow") ?? false;

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 20 } },
          })}\n\n`,
        );
        const finish = () => {
          res.write(
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              usage: { output_tokens: 40 },
            })}\n\n`,
          );
          res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          res.end();
        };
        setTimeout(finish, slow ? 500 : 5);
      } else {
        const wait = slow ? 300 : 0;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_mock",
              content: [{ type: "text", text: "hello" }],
              usage: { input_tokens: 20, output_tokens: 30 },
            }),
          );
        }, wait);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ── Fixtures ──

let upstream: { server: Server; url: string };

beforeAll(async () => {
  upstream = await startMockUpstream();
});
afterAll(() => {
  upstream.server.close();
});

// Estimator note: pools use the built-in model-aware estimator. All test
// requests carry max_tokens explicitly so output reservations are exact;
// input estimates are small (short messages).

function startGateway(pool: {
  maxConcurrent: number;
  budget?: number;
  highPriorityReserve?: number;
}): Promise<{ server: Server; url: string }> {
  const { server } = createGateway({
    upstreamUrl: upstream.url,
    pools: [
      {
        name: "test-pool",
        modelPrefixes: ["claude"],
        model: "claude-sonnet-4",
        ...pool,
      },
    ],
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const msg = (content: string, extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 1000,
  messages: [{ role: "user", content }],
  ...extra,
});

describe("admission-gateway", () => {
  it("proxies non-streaming requests and applies usage refunds", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("msg_mock");

      const stats = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { totalConsumed: number; totalRefunded: number; inFlightTokens: number } }
      >;
      const tb = stats["test-pool"]!.tokenBudget;
      expect(tb.totalConsumed).toBe(50); // 20 in + 30 out from mock
      expect(tb.totalRefunded).toBeGreaterThan(0); // reserved ~1000+ vs 50 actual
      expect(tb.inFlightTokens).toBe(0);
    } finally {
      gw.server.close();
    }
  });

  it("rejects with 429 + detail when the token budget is exhausted", async () => {
    // Budget fits one ~1000-token reservation, not two.
    const gw = await startGateway({ maxConcurrent: 10, budget: 1200 });
    try {
      const p1 = fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("slow please")), // holds budget ~300ms
      });
      await new Promise((r) => setTimeout(r, 80)); // let p1 admit

      const res2 = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res2.status).toBe(429);
      expect(res2.headers.get("x-admission-reason")).toBe("budget_limit");
      const body = (await res2.json()) as {
        error: { reason: string; detail: { tokenBudget: { available: number } } };
      };
      expect(body.error.reason).toBe("budget_limit");
      expect(body.error.detail.tokenBudget.available).toBeLessThan(1100);

      expect((await p1).status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("admits x-priority: high when normal traffic is budget-blocked", async () => {
    // budget 2400, reserve 1200 → normal ceiling 1200 (one fits, two don't).
    const gw = await startGateway({
      maxConcurrent: 10,
      budget: 2400,
      highPriorityReserve: 1200,
    });
    try {
      const p1 = fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("slow one")),
      });
      await new Promise((r) => setTimeout(r, 80));

      const normal = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(normal.status).toBe(429);

      const high = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-priority": "high",
        },
        body: JSON.stringify(msg("hi")),
      });
      expect(high.status).toBe(200);

      await p1;
    } finally {
      gw.server.close();
    }
  });

  it("rejects with 429 concurrency_limit when slots are exhausted (no budget)", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const p1 = fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("slow hold")),
      });
      await new Promise((r) => setTimeout(r, 80));

      const res2 = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res2.status).toBe(429);
      expect(res2.headers.get("x-admission-reason")).toBe("concurrency_limit");
      await p1;
    } finally {
      gw.server.close();
    }
  });

  it("streams SSE through and applies mid-stream early refund from message_start", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      // Long prompt so the input *estimate* (~100+ tokens) clearly exceeds
      // the mock's reported input_tokens: 20 — that gap is what refunds.
      // Contains "slow" so the mock delays message_delta ~500ms.
      const longContent = "slow " + "context ".repeat(60); // ~485 chars
      const resPromise = fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg(longContent, { stream: true })),
      });

      // Mid-stream (message_start arrived at ~5ms, message_delta pending
      // ~500ms): message_start reports input=20, so the hold shrinks to
      // 20 + max(1000, 0) = 1020, refunding (reserved − 1020) > 0 NOW.
      await new Promise((r) => setTimeout(r, 250));
      const mid = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number; totalRefunded: number } }
      >;
      const midTb = mid["test-pool"]!.tokenBudget;
      expect(midTb.inFlightTokens).toBe(1020);
      expect(midTb.totalRefunded).toBeGreaterThan(0);

      const res = await resPromise;
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).toContain("message_stop");

      // After completion: release used last reported usage (20+40=60).
      const done = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number; totalConsumed: number } }
      >;
      expect(done["test-pool"]!.tokenBudget.inFlightTokens).toBe(0);
      expect(done["test-pool"]!.tokenBudget.totalConsumed).toBe(60);
    } finally {
      gw.server.close();
    }
  });

  it("routes unknown models to 404 and serves /healthz", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...msg("hi"), model: "gpt-4o" }),
      });
      expect(res.status).toBe(404);
      const health = await fetch(`${gw.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });
});
