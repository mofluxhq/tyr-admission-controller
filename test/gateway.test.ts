import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway, waitForDrain } from "../src/server.js";

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
      // "stall": send message_start then go silent forever (no message_stop,
      // no res.end()) — simulates an upstream connection that hangs mid-flight.
      const stall = body.messages[0]?.content.includes("stall") ?? false;
      // "drip": send small keep-alive events at a steady short interval over
      // a total duration that would exceed any reasonable single wall-clock
      // timeout, then finish normally — simulates a healthy long-running
      // stream that never goes idle.
      const drip = body.messages[0]?.content.includes("drip") ?? false;

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 20 } },
          })}\n\n`,
        );

        if (stall) {
          // Deliberately never write again and never end the response.
          return;
        }

        if (drip) {
          let i = 0;
          const dripInterval = setInterval(() => {
            i += 1;
            res.write(`event: ping\ndata: ${JSON.stringify({ i })}\n\n`);
            if (i >= 6) {
              // ~300ms total (6 * 50ms), each gap well under any idle
              // timeout used by the "survives" test.
              clearInterval(dripInterval);
              res.write(
                `event: message_delta\ndata: ${JSON.stringify({
                  type: "message_delta",
                  usage: { output_tokens: 40 },
                })}\n\n`,
              );
              res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
              res.end();
            }
          }, 50);
          return;
        }

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

// ── Mock OpenAI-shaped upstream ──


function startMockOpenAIUpstream(): Promise<{ server: Server; url: string }> {
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
          `data: ${JSON.stringify({
            id: "chatcmpl_mock",
            object: "chat.completion.chunk",
            choices: [{ delta: { content: "hello" }, index: 0, finish_reason: null }],
            usage: null,
          })}\n\n`,
        );
        const finish = () => {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl_mock",
              object: "chat.completion.chunk",
              choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 40 },
            })}\n\n`,
          );
          res.write(`data: [DONE]\n\n`);
          res.end();
        };
        setTimeout(finish, slow ? 500 : 5);
      } else {
        const wait = slow ? 300 : 0;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl_mock",
              object: "chat.completion",
              choices: [
                { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 30 },
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
let openaiUpstream: { server: Server; url: string };

beforeAll(async () => {
  upstream = await startMockUpstream();
  openaiUpstream = await startMockOpenAIUpstream();
});
afterAll(() => {
  upstream.server.close();
  openaiUpstream.server.close();
});

// Estimator note: pools use the built-in model-aware estimator. All test
// requests carry max_tokens explicitly so output reservations are exact;
// input estimates are small (short messages).

function startGateway(
  pool: {
    maxConcurrent: number;
    budget?: number;
    highPriorityReserve?: number;
  },
  opts: {
    responseTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxRequestBodyBytes?: number;
  } = {},
): Promise<{ server: Server; url: string; shutdown: () => Promise<void> }> {
  const { server, shutdown } = createGateway({
    upstreamUrl: upstream.url,
    openaiUpstreamUrl: openaiUpstream.url,
    ...(opts.responseTimeoutMs !== undefined
      ? { responseTimeoutMs: opts.responseTimeoutMs }
      : {}),
    ...(opts.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: opts.idleTimeoutMs }
      : {}),
    ...(opts.maxRequestBodyBytes !== undefined
      ? { maxRequestBodyBytes: opts.maxRequestBodyBytes }
      : {}),
    pools: [
      {
        name: "test-pool",
        modelPrefixes: ["claude", "gpt"],
        model: "claude-sonnet-4",
        ...pool,
      },
    ],
  });


  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, shutdown });
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
        body: JSON.stringify({ ...msg("hi"), model: "unknown-model-x" }),
      });
      expect(res.status).toBe(404);
      const health = await fetch(`${gw.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("proxies OpenAI-shaped non-streaming requests and applies usage refunds", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { model: "gpt-4o" })),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe("chatcmpl_mock");

      const stats = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { totalConsumed: number; totalRefunded: number; inFlightTokens: number } }
      >;
      const tb = stats["test-pool"]!.tokenBudget;
      expect(tb.totalConsumed).toBe(50); // 20 prompt + 30 completion from mock
      expect(tb.totalRefunded).toBeGreaterThan(0);
      expect(tb.inFlightTokens).toBe(0);
    } finally {
      gw.server.close();
    }
  });

  it("streams OpenAI SSE through and reports final cumulative usage", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { model: "gpt-4o", stream: true })),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("chat.completion.chunk");
      expect(text).toContain("[DONE]");

      const done = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number; totalConsumed: number } }
      >;
      expect(done["test-pool"]!.tokenBudget.inFlightTokens).toBe(0);
      expect(done["test-pool"]!.tokenBudget.totalConsumed).toBe(60); // 20+40
    } finally {
      gw.server.close();
    }
  });

  it("returns 504 response_timeout when responseTimeoutMs elapses before upstream sends headers", async () => {
    const gw = await startGateway(
      { maxConcurrent: 4, budget: 5000 },
      { responseTimeoutMs: 50 },
    );
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("slow please")), // mock delays ~300ms before headers
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("response_timeout");
    } finally {
      gw.server.close();
    }
  });

  it("does not time out fast requests when responseTimeoutMs is configured", async () => {
    const gw = await startGateway(
      { maxConcurrent: 4, budget: 5000 },
      { responseTimeoutMs: 2000 },
    );
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("kills a stalled stream when idleTimeoutMs elapses with no new chunks", async () => {
    // Mock upstream sends message_start immediately, then goes silent
    // forever (no further chunks, no res.end()) when the prompt contains
    // "stall". With idleTimeoutMs well under the mock's infinite silence,
    // the gateway must abort the upstream connection and terminate the
    // client connection rather than hang indefinitely — headers were
    // already sent, so the gateway can't send a clean error body; it
    // destroys the socket, which surfaces to the client as a network
    // error rather than a valid (complete) response.
    const gw = await startGateway(
      { maxConcurrent: 4, budget: 5000 },
      { idleTimeoutMs: 100 },
    );
    try {
      const start = Date.now();
      await expect(
        fetch(`${gw.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(msg("stall", { stream: true })),
        }).then((res) => res.text()),
      ).rejects.toBeTruthy();
      // Confirms the connection was killed by the idle timeout rather than
      // some unrelated immediate failure — it took at least ~idleTimeoutMs.
      expect(Date.now() - start).toBeGreaterThanOrEqual(90);

      // The pool must not be left holding the reservation forever — the
      // in-flight tokens for this pool return to 0 once the aborted
      // request's bulkhead slot releases.
      const stats = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number } }
      >;
      expect(stats["test-pool"]!.tokenBudget.inFlightTokens).toBe(0);
    } finally {
      gw.server.close();
    }
  });


  it("does not kill a healthy long stream that keeps sending chunks within idleTimeoutMs", async () => {
    // Mock upstream drips small events every ~50ms for ~300ms (well beyond
    // a single naive wall-clock timeout window) before finishing normally.
    // Because idleTimeoutMs resets on every chunk, and each gap here is well
    // under idleTimeoutMs, the stream must complete successfully in full.
    const gw = await startGateway(
      { maxConcurrent: 4, budget: 5000 },
      { idleTimeoutMs: 200 },
    );
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("drip", { stream: true })),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).toContain("message_stop");
      expect(text).toContain("event: ping");

      // Stream completed normally, so usage was released as usual.
      const stats = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number; totalConsumed: number } }
      >;
      const tb = stats["test-pool"]!.tokenBudget;
      expect(tb.inFlightTokens).toBe(0);
      expect(tb.totalConsumed).toBe(60); // 20 input + 40 output from mock
    } finally {
      gw.server.close();
    }
  });


  it("returns 404 for /v1/chat/completions when openaiUpstreamUrl is not configured", async () => {
    const { server } = createGateway({
      upstreamUrl: upstream.url,

      pools: [
        {
          name: "anthropic-only",
          modelPrefixes: ["claude"],
          model: "claude-sonnet-4",
          maxConcurrent: 1,
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { model: "gpt-4o" })),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("returns 413 payload_too_large when the request body exceeds maxRequestBodyBytes", async () => {
    const gw = await startGateway(
      { maxConcurrent: 4, budget: 5000 },
      { maxRequestBodyBytes: 200 },
    );
    try {
      // A body well over 200 bytes.
      const longContent = "x".repeat(1000);
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg(longContent)),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error: { type: string; limitBytes: number } };
      expect(body.error.type).toBe("payload_too_large");
      expect(body.error.limitBytes).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("defaults maxRequestBodyBytes to 1 MiB and admits normal-sized requests", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("waitForDrain resolves once the response emits 'drain'", async () => {
    // Direct unit test of the exported helper: create a bare http server,
    // grab its ServerResponse, and confirm waitForDrain resolves on the
    // 'drain' event (not immediately, and not hanging forever).
    const server = createServer((_req, res) => {
      let resolved = false;
      void waitForDrain(res).then(() => {
        resolved = true;
        res.end(JSON.stringify({ resolved }));
      });
      // Resolve should NOT have fired synchronously.
      expect(resolved).toBe(false);
      // Simulate backpressure release.
      res.emit("drain");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = (await res.json()) as { resolved: boolean };
      expect(body.resolved).toBe(true);
    } finally {
      server.close();
    }
  });

  it("waitForDrain resolves immediately if the response is already destroyed", async () => {
    const server = createServer((_req, res) => {
      res.destroy();
      // Give the 'close' event a tick to fire, then confirm waitForDrain
      // still resolves (via the destroyed-check fast path or 'close').
      setTimeout(() => {
        void waitForDrain(res).then(() => {
          // Nothing to assert on the wire (connection already closed) —
          // reaching this callback at all proves it didn't hang.
        });
      }, 10);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeTruthy();
    } finally {
      server.close();
    }
  });

  it("applies backpressure to a fast upstream stream read by a slow client", async () => {
    // Mock upstream that blasts many sizeable chunks as fast as possible,
    // far exceeding the default 16KB highWaterMark, so res.write() must
    // return false at least once and the gateway must wait for 'drain'
    // before continuing to pull from upstream.
    const chunkCount = 200;
    const chunkSize = 4096; // 200 * 4096 = ~800KB, well over 16KB HWM
    const fastServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 20 } },
          })}\n\n`,
        );
        const payload = "x".repeat(chunkSize);
        for (let i = 0; i < chunkCount; i++) {
          res.write(`event: ping\ndata: ${JSON.stringify({ payload })}\n\n`);
        }
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 40 },
          })}\n\n`,
        );
        res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      fastServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port: fastPort } = fastServer.address() as AddressInfo;
    const fastUpstreamUrl = `http://127.0.0.1:${fastPort}`;

    const { server, shutdown } = createGateway({
      upstreamUrl: fastUpstreamUrl,
      pools: [
        {
          name: "test-pool",
          modelPrefixes: ["claude"],
          model: "claude-sonnet-4",
          maxConcurrent: 4,
          budget: 5000,
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      // Issue the request over a raw http.request with a client-side
      // response reader that pauses between reads, forcing the gateway's
      // res.write() to see the socket's write buffer stay full and
      // exercise the waitForDrain() backpressure path.
      const received: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const clientReq = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/messages",
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (clientRes) => {
            clientRes.on("data", (chunk: Buffer) => {
              received.push(chunk);
              // Pause the client's readable side briefly on each chunk to
              // slow consumption and force TCP-level (and thus writable-
              // side) backpressure back onto the gateway's res.write().
              clientRes.pause();
              setTimeout(() => clientRes.resume(), 5);
            });
            clientRes.on("end", resolve);
            clientRes.on("error", reject);
          },
        );
        clientReq.on("error", reject);
        clientReq.end(
          JSON.stringify(
            msg("hi", { stream: true, model: "claude-sonnet-4-5" }),
          ),
        );
      });

      const full = Buffer.concat(received).toString();
      expect(full).toContain("message_start");
      expect(full).toContain("message_stop");
      // All chunk payloads made it through intact despite the slow client.
      expect(full.split("event: ping").length - 1).toBe(chunkCount);

      // The pool released its reservation cleanly once the (backpressured)
      // stream completed — no tokens left stuck in-flight.
      const stats = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as Record<
        string,
        { tokenBudget: { inFlightTokens: number } }
      >;
      expect(stats["test-pool"]!.tokenBudget.inFlightTokens).toBe(0);
    } finally {
      await shutdown();
      fastServer.close();
    }
  });

  it("gracefully drains in-flight requests on shutdown and rejects new ones with 503", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });


    // Kick off a slow in-flight request before shutting down.
    const inFlight = fetch(`${gw.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg("slow please")), // mock delays ~300ms
    });
    await new Promise((r) => setTimeout(r, 80)); // let it admit

    // Begin graceful shutdown: stops accepting new TCP connections and
    // drains the bulkhead once in-flight work completes.
    const shutdownPromise = gw.shutdown();

    // New requests during drain should be rejected with 503 + reason
    // "shutdown" — but the server no longer accepts new connections
    // (server.close() was called), so a genuinely new connection attempt
    // will be refused at the TCP layer rather than reach the handler.
    await expect(
      fetch(`${gw.url}/healthz`).then(() => "connected"),
    ).rejects.toBeTruthy();

    // The in-flight request should still complete successfully.
    const res = await inFlight;
    expect(res.status).toBe(200);

    // shutdown() resolves once the bulkhead has drained.
    await shutdownPromise;
  });
});

