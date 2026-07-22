import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import {
  createGateway,
  waitForDrain,
  type GatewayOptions,
} from "../src/server.js";
import { loadRuntimeConfig } from "../src/config.js";
import type {
  AdaptiveEstimationConfig,
  AdmissionMode,
  PoolConfig,
  PoolsDrainResult,
} from "../src/pools.js";

// Parses one complete HTTP/1.1 response (status line + headers + body,
// using Content-Length to know where the body ends) off the front of
// `buf`. Returns null if `buf` doesn't yet contain a full response.
// Used to read two pipelined responses off a single raw socket in the
// shutdown-503 test below — every response the gateway sends carries an
// explicit content-length (see sendJson in src/server.ts), so this is
// reliable without needing a full HTTP parser.
// Buffer.subarray()'s TS type is Buffer<ArrayBufferLike>, distinct from
// the plain `Buffer` (= Buffer<ArrayBuffer>) alias used for the `buf`
// parameter/accumulator elsewhere in this file. `rest` is typed to match
// what subarray() actually returns rather than fighting the type system.
type Bytes = ReturnType<Buffer["subarray"]>;

function parseOneResponse(
  buf: Buffer,
): { statusCode: number; headers: Record<string, string>; body: string; rest: Bytes } | null {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerText = buf.subarray(0, headerEnd).toString("utf8");
  const lines = headerText.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusCode = Number(statusLine.split(" ")[1]);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const contentLength = Number(headers["content-length"] ?? "0");
  const bodyStart = headerEnd + 4;
  if (buf.length < bodyStart + contentLength) return null; // body not fully arrived yet
  const body = buf.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
  const rest = buf.subarray(bodyStart + contentLength);
  return { statusCode, headers, body, rest };
}





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
    opaqueMediaInputTokens?: number;
    admissionMode?: AdmissionMode;
    shadowReasons?: NonNullable<PoolConfig["shadowReasons"]>;
    adaptiveEstimation?: AdaptiveEstimationConfig;
  },
  opts: {
    responseTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxRequestBodyBytes?: number;
    shutdownDrainTimeoutMs?: number;
    trustPriorityHeader?: boolean;
    resolvePriority?: GatewayOptions["resolvePriority"];
  } = {},
): Promise<{
  server: Server;
  url: string;
  shutdown: () => Promise<PoolsDrainResult>;
}> {
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
    ...(opts.shutdownDrainTimeoutMs !== undefined
      ? { shutdownDrainTimeoutMs: opts.shutdownDrainTimeoutMs }
      : {}),
    ...(opts.trustPriorityHeader !== undefined
      ? { trustPriorityHeader: opts.trustPriorityHeader }
      : {}),
    ...(opts.resolvePriority !== undefined
      ? { resolvePriority: opts.resolvePriority }
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
      expect(res.headers.get("x-admission-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(res.headers.get("x-admission-outcome")).toBe("admitted");
      expect(res.headers.get("x-admission-bypass-reason")).toBeNull();
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

  it("observes a budget rejection without blocking upstream traffic", async () => {
    const gw = await startGateway({
      maxConcurrent: 10,
      budget: 0,
      admissionMode: "observe",
      adaptiveEstimation: { enabled: false },
    });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-admission-mode")).toBe("observe");
      expect(res.headers.get("x-admission-preview")).toBe("reject");
      expect(res.headers.get("x-admission-preview-reason")).toBe(
        "budget_limit",
      );
      expect(res.headers.get("x-admission-id")).toMatch(/^shadow-/);
      expect(res.headers.get("x-admission-outcome")).toBe("bypassed");
      expect(res.headers.get("x-admission-bypass-reason")).toBe(
        "budget_limit",
      );

      const stats = (await (await fetch(`${gw.url}/stats`)).json()) as Record<
        string,
        {
          llm: { admitted: number };
          tyr: {
            advisory: {
              wouldReject: number;
              rejectedByReason: { budget_limit?: number };
            };
            observe: { bypassed: number };
          };
        }
      >;
      expect(stats["test-pool"]).toMatchObject({
        llm: { admitted: 0 },
        tyr: {
          advisory: {
            wouldReject: 1,
            rejectedByReason: { budget_limit: 1 },
          },
          observe: { bypassed: 1 },
        },
      });
    } finally {
      gw.server.close();
    }
  });

  it("does not bypass reasons excluded by shadowReasons", async () => {
    const gw = await startGateway({
      maxConcurrent: 10,
      budget: 0,
      admissionMode: "observe",
      shadowReasons: ["concurrency_limit"],
    });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("x-admission-reason")).toBe("budget_limit");
      expect(res.headers.get("x-admission-outcome")).toBeNull();
    } finally {
      gw.server.close();
    }
  });

  it("budget: 0 constructs a pool that rejects every request with 429 budget_limit (never crashes)", async () => {
    // async-bulkhead-llm 3.2.0 threw at construction for budget: 0
    // (assertPositiveInteger); 3.3.1 made it a legal "admit nothing" pool.
    // This pins that: construction must succeed, and every budget-gated
    // request — even the very first, with nothing else in flight — must
    // be rejected with 429/budget_limit rather than admitted or crashing.
    const gw = await startGateway({ maxConcurrent: 10, budget: 0 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("x-admission-reason")).toBe("budget_limit");
      const body = (await res.json()) as {
        error: { reason: string; detail: { tokenBudget: { available: number } } };
      };
      expect(body.error.reason).toBe("budget_limit");
      expect(body.error.detail.tokenBudget.available).toBe(0);
    } finally {
      gw.server.close();
    }
  });

  it("ignores an untrusted client x-priority header by default", async () => {
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

      const spoofedHigh = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-priority": "high",
        },
        body: JSON.stringify(msg("hi")),
      });
      expect(spoofedHigh.status).toBe(429);
      expect(spoofedHigh.headers.get("x-admission-reason")).toBe("budget_limit");
      await p1;
    } finally {
      gw.server.close();
    }
  });

  it("admits x-priority: high only when the header is explicitly trusted", async () => {
    // budget 2400, reserve 1200 → normal ceiling 1200 (one fits, two don't).
    const gw = await startGateway(
      {
        maxConcurrent: 10,
        budget: 2400,
        highPriorityReserve: 1200,
      },
      { trustPriorityHeader: true },
    );
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

  it("supports authenticated priority resolution without trusting the raw header", async () => {
    const gw = await startGateway(
      {
        maxConcurrent: 10,
        budget: 2400,
        highPriorityReserve: 1200,
      },
      {
        resolvePriority: (req) =>
          req.headers.authorization === "Bearer premium" ? "high" : "normal",
      },
    );
    try {
      const p1 = fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("slow one")),
      });
      await new Promise((r) => setTimeout(r, 80));

      const premium = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer premium",
        },
        body: JSON.stringify(msg("hi")),
      });
      expect(premium.status).toBe(200);
      await p1;
    } finally {
      gw.server.close();
    }
  });

  it("charges Anthropic system prompts against admission budget", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 400 });
    try {
      const small = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { max_tokens: 100 })),
      });
      expect(small.status).toBe(200);

      const largeSystem = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          msg("hi", { max_tokens: 100, system: "policy ".repeat(500) }),
        ),
      });
      expect(largeSystem.status).toBe(429);
      expect(largeSystem.headers.get("x-admission-reason")).toBe("budget_limit");
    } finally {
      gw.server.close();
    }
  });

  it("charges OpenAI tool schemas and null-content tool calls against admission budget", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 500 });
    try {
      const withToolSchema = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "schema ".repeat(500),
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        }),
      });
      expect(withToolSchema.status).toBe(429);
      expect(withToolSchema.headers.get("x-admission-reason")).toBe("budget_limit");

      const withToolCall = await fetch(`${gw.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 100,
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "lookup",
                    arguments: JSON.stringify({ query: "x".repeat(2_000) }),
                  },
                },
              ],
            },
          ],
        }),
      });
      expect(withToolCall.status).toBe(429);
      expect(withToolCall.headers.get("x-admission-reason")).toBe("budget_limit");
    } finally {
      gw.server.close();
    }
  });

  it("applies a conservative token surcharge to opaque media blocks", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 1_500 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "aGVsbG8=",
                  },
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("x-admission-reason")).toBe("budget_limit");
    } finally {
      gw.server.close();
    }
  });

  it("supports a per-pool opaque media reservation override", async () => {
    const gw = await startGateway({
      maxConcurrent: 4,
      budget: 500,
      opaqueMediaInputTokens: 0,
    });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe this" },
                {
                  type: "image",
                  source: { type: "url", url: "https://example.test/image.png" },
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
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

  it("routes unknown models to 422 and serves /healthz", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...msg("hi"), model: "unknown-model-x" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { type: string; model: string } };
      expect(body.error.type).toBe("unsupported_model");
      expect(body.error.model).toBe("unknown-model-x");
      const health = await fetch(`${gw.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when the JSON body is not an object (e.g. null)", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; errors: string[] } };
      expect(body.error.type).toBe("invalid_request");
      expect(body.error.errors.length).toBeGreaterThan(0);
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when the JSON body is an array", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when max_tokens is negative", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { max_tokens: -1 })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; errors: string[] } };
      expect(body.error.type).toBe("invalid_request");
      expect(body.error.errors.some((e) => e.includes("max_tokens"))).toBe(true);
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when max_tokens exceeds the configured ceiling", async () => {
    const { server } = createGateway({
      upstreamUrl: upstream.url,
      maxOutputTokens: 100,
      pools: [
        {
          name: "test-pool",
          modelPrefixes: ["claude"],
          model: "claude-sonnet-4",
          maxConcurrent: 1,
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { max_tokens: 1000 })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    } finally {
      server.close();
    }
  });

  it("returns 400 invalid_request when a message is missing content", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1000,
          messages: [{ role: "user" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; errors: string[] } };
      expect(body.error.type).toBe("invalid_request");
      expect(body.error.errors.some((e) => e.includes("content"))).toBe(true);
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when messages is missing entirely", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1000 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when max_tokens is missing for the Anthropic route", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; errors: string[] } };
      expect(body.error.type).toBe("invalid_request");
      expect(body.error.errors.some((e) => e.includes("max_tokens"))).toBe(true);
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request for an invalid message role", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1000,
          messages: [{ role: "system-prompt-typo", content: "hi" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    } finally {
      gw.server.close();
    }
  });

  it("returns 400 invalid_request when stream is not a boolean", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi", { stream: "yes" })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("invalid_request");
    } finally {
      gw.server.close();
    }
  });

  it("accepts a valid multimodal content-block message", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("routes /v1/messages?x=1 correctly instead of 404ing on the query string", async () => {
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    try {
      const res = await fetch(`${gw.url}/v1/messages?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg("hi")),
      });
      expect(res.status).toBe(200);
    } finally {
      gw.server.close();
    }
  });

  it("still serves /stats?foo=bar and /healthz?foo=bar with query strings", async () => {
    const gw = await startGateway({ maxConcurrent: 1 });
    try {
      const stats = await fetch(`${gw.url}/stats?foo=bar`);
      expect(stats.status).toBe(200);
      const health = await fetch(`${gw.url}/healthz?foo=bar`);
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


  it("releases the bulkhead slot and token budget when a client stalls (stops reading) mid-stream", async () => {
    // Reproduces the resource-pinning bug: a client that connects, starts a
    // stream, and then simply stops reading (TCP connection stays open —
    // no FIN, no RST) must NOT be able to pin its admission hold forever.
    // Once the client's receive window fills, the gateway's res.write()
    // starts returning false and the handler parks in waitForDrain(res).
    // A stalled-but-connected client never emits 'drain' or 'close', so
    // without a bound, nothing would ever unpark it. clientStallTimeoutMs
    // (here defaulted from idleTimeoutMs) must destroy the response after
    // the bound elapses, cascading: close -> drain-wait resolves -> loop
    // unwinds -> bulkhead releases.
    //
    // Mock upstream blasts many sizeable chunks so the client's receive
    // buffer and the gateway's write buffer both fill quickly once reading
    // stops, reliably forcing res.write() to return false.
    const chunkCount = 500;
    const chunkSize = 4096; // ~2MB total, far beyond default HWM/socket bufs
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
        let i = 0;
        const pump = () => {
          // Keep writing until the mock's own socket backs up or we've
          // sent everything — either way this never blocks the test.
          while (i < chunkCount) {
            i += 1;
            const ok = res.write(
              `event: ping\ndata: ${JSON.stringify({ payload })}\n\n`,
            );
            if (!ok) {
              res.once("drain", pump);
              return;
            }
          }
          // Deliberately never send message_delta/message_stop/res.end() —
          // doesn't matter, the client stalls before it would matter.
        };
        pump();
      });
    });
    await new Promise<void>((resolve) =>
      fastServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port: fastPort } = fastServer.address() as AddressInfo;
    const fastUpstreamUrl = `http://127.0.0.1:${fastPort}`;

    const { server, shutdown } = createGateway({
      upstreamUrl: fastUpstreamUrl,
      idleTimeoutMs: 100, // clientStallTimeoutMs defaults to this
      pools: [
        {
          name: "test-pool",
          modelPrefixes: ["claude"],
          model: "claude-sonnet-4",
          maxConcurrent: 1,
          budget: 5000,
        },
      ],
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      // Issue the request over a raw http.request and, exactly like the
      // probe described in the bug report, pause the client's readable
      // side immediately and never resume it — i.e. connect, start the
      // stream, and stop reading.
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
            clientRes.pause(); // stop reading — never resume
            clientRes.on("error", () => {
              /* connection will be destroyed by the gateway; ignore */
            });
          },
        );
        clientReq.on("error", () => {
          /* gateway-side destroy may surface as a client error; ignore */
        });
        clientReq.end(
          JSON.stringify(msg("hi", { stream: true, model: "claude-sonnet-4-5" })),
        );

        // Poll /stats until the pool's admission hold is released, or
        // time out and fail — this is the core assertion: the slot and
        // token budget must NOT be held indefinitely.
        const deadline = Date.now() + 3000;
        const poll = async () => {
          if (Date.now() > deadline) {
            reject(new Error("bulkhead hold was never released"));
            return;
          }
          const stats = (await (
            await fetch(`http://127.0.0.1:${port}/stats`)
          ).json()) as Record<
            string,
            {
              tokenBudget: { inFlightTokens: number };
              inFlight?: number;
            }
          >;
          const tb = stats["test-pool"]!.tokenBudget;
          if (tb.inFlightTokens === 0) {
            resolve();
            return;
          }
          setTimeout(() => void poll(), 25);
        };
        void poll();
      });

      // The bulkhead's run() only resolves/rejects once — releasing the
      // concurrency slot and the token budget together — so confirming
      // inFlightTokens reached 0 above already proves both were released,
      // not just the budget.
    } finally {

      await shutdown();
      fastServer.close();
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

  it("gracefully drains in-flight requests on shutdown and rejects new admissions arriving on a still-open connection with 503", async () => {
    // Node's server.close() proactively destroys *idle* keep-alive
    // connections (verified empirically), so a warmed-up-then-idle
    // connection can't be used to probe the drain window — it gets torn
    // down before a second request could land. Instead, pipeline a
    // second request behind a still-in-flight one on the SAME raw TCP
    // connection: the connection can't be idle-closed while request #1
    // is in flight, and HTTP/1.1 guarantees responses are written back
    // in request order, so response #2 (the drain-time admission,
    // expected to be a 503) arrives right after response #1 (the
    // in-flight request, expected to complete with 200).
    const gw = await startGateway({ maxConcurrent: 4, budget: 5000 });
    const { port } = gw.server.address() as AddressInfo;

    const socket = netConnect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    function writeRequest(body: Record<string, unknown>): void {
      const payload = JSON.stringify(body);
      socket.write(
        `POST /v1/messages HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          `Connection: keep-alive\r\n` +
          `\r\n` +
          payload,
      );
    }

    let buf: Bytes = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
    });

    try {
      // Request #1: slow in-flight request (mock upstream delays ~300ms)
      // that must be allowed to complete despite the shutdown.
      writeRequest(msg("slow please"));
      await new Promise((r) => setTimeout(r, 80)); // let it admit

      // Begin graceful shutdown: server.close() and pools.drain() now run
      // concurrently, so the bulkheads are marked closed immediately —
      // well before request #1's response has even been written back.
      const shutdownPromise = gw.shutdown();

      // Request #2: pipelined on the SAME still-open connection, sent
      // while shutdown is in progress. It reaches the handler (the
      // connection is busy serving request #1, so it can't have been
      // idle-closed), and since the bulkhead is already draining, it
      // must be rejected with a genuine HTTP 503 — not a TCP refusal.
      writeRequest(msg("hi"));

      // Wait until both pipelined responses have fully arrived.
      const first = await new Promise<ReturnType<typeof parseOneResponse>>(
        (resolve, reject) => {
          const check = () => {
            const parsed = parseOneResponse(buf);
            if (parsed) {
              resolve(parsed);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error("timed out waiting for first response"));
              return;
            }
            setTimeout(check, 10);
          };
          const deadline = Date.now() + 3000;
          check();
        },
      );
      expect(first).not.toBeNull();
      expect(first!.statusCode).toBe(200);
      buf = first!.rest;

      const second = await new Promise<ReturnType<typeof parseOneResponse>>(
        (resolve, reject) => {
          const check = () => {
            const parsed = parseOneResponse(buf);
            if (parsed) {
              resolve(parsed);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error("timed out waiting for second response"));
              return;
            }
            setTimeout(check, 10);
          };
          const deadline = Date.now() + 3000;
          check();
        },
      );
      expect(second).not.toBeNull();
      expect(second!.statusCode).toBe(503);
      expect(second!.headers["x-admission-reason"]).toBe("shutdown");
      const secondBody = JSON.parse(second!.body) as { error: { reason: string } };
      expect(secondBody.error.reason).toBe("shutdown");

      // shutdown() resolves once the bulkhead has drained.
      await shutdownPromise;
    } finally {
      socket.destroy();
    }
  });

  it("bounds shutdown and reports outstanding work", async () => {
    const gw = await startGateway(
      { maxConcurrent: 1, budget: 5000 },
      { shutdownDrainTimeoutMs: 20 },
    );
    const inFlight = fetch(`${gw.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg("slow please")),
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await gw.shutdown();
    expect(result).toMatchObject({ drained: false, inFlight: 1, pending: 0 });
    expect(result.pools["test-pool"]).toMatchObject({
      drained: false,
      inFlight: 1,
      pending: 0,
    });
    await inFlight.catch(() => undefined);
  });

  it("rejects invalid gateway and pool configuration before listening", () => {
    const basePool = {
      name: "default",
      modelPrefixes: ["claude"],
      model: "claude-sonnet-4",
      maxConcurrent: 1,
    };

    expect(() =>
      createGateway({ upstreamUrl: "ftp://example.com", pools: [basePool] }),
    ).toThrow(/http: or https:/);
    expect(() =>
      createGateway({
        upstreamUrl: "https://example.com",
        maxRequestBodyBytes: 0,
        pools: [basePool],
      }),
    ).toThrow(/maxRequestBodyBytes/);
    expect(() =>
      createGateway({
        upstreamUrl: "https://example.com",
        pools: [
          basePool,
          {
            ...basePool,
            name: "other",
            modelPrefixes: ["claude"],
          },
        ],
      }),
    ).toThrow(/duplicate model prefix/);
  });

  it("validates environment configuration with actionable errors", () => {
    expect(() =>
      loadRuntimeConfig({
        UPSTREAM_URL: "https://example.com",
        MAX_CONCURRENT: "0",
      }),
    ).toThrow(/MAX_CONCURRENT/);
    expect(() =>
      loadRuntimeConfig({
        UPSTREAM_URL: "https://example.com",
        PORT: "70000",
      }),
    ).toThrow(/PORT/);
    expect(() =>
      loadRuntimeConfig({
        UPSTREAM_URL: "https://example.com",
        TRUST_X_PRIORITY_HEADER: "sometimes",
      }),
    ).toThrow(/TRUST_X_PRIORITY_HEADER/);
  });

});



