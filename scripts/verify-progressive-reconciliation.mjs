import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createPools } from "../dist/pools.js";
import { createGateway } from "../dist/server.js";
import { TyrTelemetry } from "../dist/telemetry.js";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function verifyPoolRuntime() {
  const request = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "x".repeat(400) }],
    max_tokens: 1000,
  };
  const pools = createPools([
    {
      name: "progressive",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 1,
      budget: 10_000,
      adaptiveEstimation: { enabled: false },
      progressiveReconciliation: {
        updateStepTokens: 100,
        outputSafetyMarginTokens: 200,
      },
    },
  ]);
  const pool = pools.get("progressive");
  const prepared = pool.prepare(request, "normal");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const running = pool.run(
    request,
    prepared,
    async (_signal, context) => {
      context.reportUsage({ input: 80, output: 0 });
      assert.equal(pool.stats().tokenBudget.inFlightTokens, 1000);
      context.reportUsage({ input: 80, output: 50 });
      assert.equal(pool.stats().tokenBudget.inFlightTokens, 1000);
      context.reportUsage({ input: 80, output: 250 });
      assert.equal(pool.stats().tokenBudget.inFlightTokens, 750);
      context.reportUsage({ input: 80, output: 900 });
      assert.equal(pool.stats().tokenBudget.inFlightTokens, 200);
      await gate;
      return { usage: { input: 80, output: 900 } };
    },
    { priority: "normal", getUsage: (value) => value.usage },
  );
  await delay(0);

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(pool.stats().tyr.progressiveReconciliation).filter(
        ([key]) => ["enabled", "reports", "updates", "coalesced"].includes(key),
      ),
    ),
    { enabled: true, reports: 4, updates: 3, coalesced: 1 },
  );
  const midStats = pool.stats();
  assert.ok(midStats.tyr.progressiveReconciliation.earlyReleasedTokens > 0);
  const metrics = new TyrTelemetry().renderPrometheus(
    { progressive: midStats },
    true,
  );
  assert.match(
    metrics,
    /tyr_pool_progressive_usage_reports_total\{pool="progressive"\} 4/,
  );
  assert.match(
    metrics,
    /tyr_pool_progressive_updates_total\{pool="progressive"\} 3/,
  );
  assert.match(
    metrics,
    /tyr_pool_progressive_coalesced_total\{pool="progressive"\} 1/,
  );
  assert.match(
    metrics,
    new RegExp(
      `tyr_pool_progressive_tokens_released_total\\{pool="progressive"\\} ${midStats.tyr.progressiveReconciliation.earlyReleasedTokens}`,
    ),
  );

  release();
  await running;
  assert.equal(pool.stats().tokenBudget.inFlightTokens, 0);
}

async function verifyGatewayStreamingIntegration() {
  const upstream = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 20 } },
        })}\n\n`,
      );
      setTimeout(() => {
        response.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 40 },
          })}\n\n`,
        );
        response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        response.end();
      }, 350);
    });
  });

  let gateway;
  try {
    const upstreamUrl = await listen(upstream);
    gateway = createGateway({
      upstreamUrl,
      pools: [
        {
          name: "anthropic-progressive",
          modelPrefixes: ["claude"],
          model: "claude-sonnet-4",
          maxConcurrent: 1,
          budget: 5_000,
          adaptiveEstimation: { enabled: false },
          progressiveReconciliation: {
            updateStepTokens: 100,
            outputSafetyMarginTokens: 200,
          },
        },
      ],
    });
    const gatewayUrl = await listen(gateway.server);

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        stream: true,
        max_tokens: 1000,
        messages: [{ role: "user", content: `slow ${"x".repeat(400)}` }],
      }),
    });
    assert.equal(response.status, 200);

    await delay(100);
    const live = gateway.control.stats()["anthropic-progressive"];
    assert.ok(live);
    assert.equal(live.tokenBudget?.inFlightTokens, 1000);
    assert.equal(live.tyr.progressiveReconciliation.reports, 1);
    assert.equal(live.tyr.progressiveReconciliation.updates, 1);
    assert.ok(live.tyr.progressiveReconciliation.earlyReleasedTokens > 0);

    const body = await response.text();
    assert.match(body, /message_start/);
    assert.match(body, /message_delta/);
    assert.match(body, /message_stop/);

    const settled = gateway.control.stats()["anthropic-progressive"];
    assert.ok(settled);
    assert.equal(settled.tokenBudget?.inFlightTokens, 0);
    assert.equal(settled.tokenBudget?.totalConsumed, 60);
  } finally {
    if (gateway) {
      await gateway.shutdown();
    }
    await closeServer(upstream);
  }
}

await verifyPoolRuntime();
await verifyGatewayStreamingIntegration();
console.log("progressive reconciliation verification passed");
