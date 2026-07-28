import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 9000);
const delayMs = Number(process.env.DELAY_MS ?? 500);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { type: "not_found" } });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: { type: "invalid_json" } });
    return;
  }

  const content = JSON.stringify(body.messages ?? []);
  if (content.includes("upstream-429")) {
    sendJson(res, 429, { error: { type: "rate_limit_error" } });
    return;
  }
  if (content.includes("upstream-500")) {
    sendJson(res, 500, { error: { type: "mock_failure" } });
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
  sendJson(res, 200, {
    id: `chatcmpl_demo_${Date.now()}`,
    object: "chat.completion",
    model: body.model ?? "gpt-4o-demo",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Mock response" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
    },
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mock provider listening on :${port} delayMs=${delayMs}`);
});
