import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { URL } from "node:url";
import { openaiResponsesAdapter } from "../dist/adapters.js";
import { createGateway } from "../dist/server.js";

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  });
}

const seen = [];
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({
      path: new URL(req.url ?? "/", "http://mock").pathname,
      authorization: req.headers.authorization,
      organization: req.headers["openai-organization"],
      project: req.headers["openai-project"],
      body,
    });

    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "hello",
        })}\n\n`,
      );
      res.write(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_verify_stream",
            status: "completed",
            usage: { input_tokens: 20, output_tokens: 40, total_tokens: 60 },
          },
        })}\n\n`,
      );
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "resp_verify",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50 },
      }),
    );
  });
});

const upstreamUrl = await listen(upstream);
const created = createGateway({
  openaiUpstreamUrl: upstreamUrl,
  pools: [
    {
      name: "openai",
      modelPrefixes: ["gpt"],
      model: "gpt-4o",
      maxConcurrent: 4,
      budget: 5_000,
    },
  ],
});
const gatewayUrl = await listen(created.server);

try {
  const projected = openaiResponsesAdapter.toAdmissionRequest({
    model: "gpt-4o",
    instructions: "be concise",
    max_output_tokens: 128,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "input_image", image_url: "https://example.test/x.png" },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  assert.equal(projected.system, "be concise");
  assert.equal(projected.max_tokens, 128);
  assert.equal(projected.messages[0]?.role, "user");
  assert.deepEqual(projected.messages[0]?.content?.[0], {
    type: "text",
    text: "describe this",
  });
  assert((projected.extraInputTokens ?? 0) > 0);

  const response = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-provider-key",
      "openai-organization": "org_test",
      "openai-project": "proj_test",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "hello",
      max_output_tokens: 100,
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "resp_verify");
  assert.equal(seen[0]?.path, "/v1/responses");
  assert.equal(seen[0]?.authorization, "Bearer test-provider-key");
  assert.equal(seen[0]?.organization, "org_test");
  assert.equal(seen[0]?.project, "proj_test");
  assert.equal(seen[0]?.body.input, "hello");

  let stats = await (await fetch(`${gatewayUrl}/stats`)).json();
  assert.equal(stats.openai.tokenBudget.inFlightTokens, 0);
  assert.equal(stats.openai.tokenBudget.totalConsumed, 50);

  const stream = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      input: "stream this",
      max_output_tokens: 100,
      stream: true,
    }),
  });
  assert.equal(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /response\.output_text\.delta/);
  assert.match(streamText, /response\.completed/);
  stats = await (await fetch(`${gatewayUrl}/stats`)).json();
  assert.equal(stats.openai.tokenBudget.inFlightTokens, 0);
  assert.equal(stats.openai.tokenBudget.totalConsumed, 110);

  for (const extra of [
    { previous_response_id: "resp_hidden" },
    { conversation: "conv_hidden" },
    { prompt: { id: "pmpt_hidden" } },
    { background: true },
    { tools: [{ type: "web_search" }] },
    { input: [{ type: "item_reference", id: "item_hidden" }] },
  ]) {
    const rejected = await fetch(`${gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "hello",
        max_output_tokens: 100,
        ...extra,
      }),
    });
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.equal(body.error.type, "invalid_request");
  }

  console.log(
    "OpenAI Responses verification passed: projection, passthrough, headers, non-streaming usage, semantic SSE usage, and hidden-state safety boundaries.",
  );
} finally {
  await created.shutdown();
  created.server.close();
  upstream.close();
}
