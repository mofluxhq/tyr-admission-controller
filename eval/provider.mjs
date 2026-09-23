// Mock OpenAI provider for the Tyr evaluation. It has a fixed number of
// concurrent request slots and answers 429 once they are full, the way a
// provider account or an inference server rejects work over its capacity.
// Chat Completions and Responses are supported without streaming.
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    return match ? [match[1], match[2]] : [arg, "true"];
  }),
);
const port = Number(args.get("port") ?? 9101);
const capacity = Number(args.get("capacity") ?? 8);
const latencyMs = Number(args.get("latency-ms") ?? 500);
const maxOutputTokens = 64;

const stats = { capacity, inFlight: 0, peakInFlight: 0, served: 0, rejected: 0 };

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function error(res, status, type, message, code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

const estimateTokens = (value) => Math.max(1, Math.ceil(JSON.stringify(value ?? "").length / 4));

function chatCompletion(body, outputTokens, text) {
  const inputTokens = estimateTokens(body.messages);
  return {
    id: `chatcmpl-eval-${stats.served}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function response(body, outputTokens, text) {
  const inputTokens = estimateTokens(body.input);
  return {
    id: `resp_eval_${stats.served}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model,
    output: [
      {
        type: "message",
        id: `msg_eval_${stats.served}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://provider").pathname;
  if (req.method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
  if (req.method === "GET" && path === "/stats") return sendJson(res, 200, stats);
  if (req.method === "POST" && path === "/stats/reset") {
    Object.assign(stats, { peakInFlight: stats.inFlight, served: 0, rejected: 0 });
    return sendJson(res, 200, stats);
  }
  const kind =
    req.method === "POST" && path === "/v1/chat/completions"
      ? "chat"
      : req.method === "POST" && path === "/v1/responses"
        ? "responses"
        : null;
  if (!kind) return error(res, 404, "invalid_request_error", `Unknown route ${req.method} ${path}`);

  let body;
  try {
    body = await readJson(req);
  } catch {
    return error(res, 400, "invalid_request_error", "Request body is not valid JSON.");
  }
  if (body.stream === true) {
    return error(
      res,
      400,
      "invalid_request_error",
      "The evaluation provider does not stream. Remove stream: true, or run the evaluation against OpenAI.",
    );
  }
  if (stats.inFlight >= capacity) {
    stats.rejected += 1;
    return error(
      res,
      429,
      "requests",
      `Rate limit reached: the evaluation provider serves ${capacity} requests at a time.`,
      "rate_limit_exceeded",
    );
  }

  stats.inFlight += 1;
  stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
  try {
    const requested =
      kind === "chat" ? (body.max_completion_tokens ?? body.max_tokens) : body.max_output_tokens;
    const outputTokens = Math.min(Number(requested) || maxOutputTokens, maxOutputTokens);
    await sleep(latencyMs);
    const text = "Mock response from the Tyr evaluation provider.";
    sendJson(
      res,
      200,
      kind === "chat" ? chatCompletion(body, outputTokens, text) : response(body, outputTokens, text),
    );
    stats.served += 1;
  } finally {
    stats.inFlight -= 1;
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`evaluation provider on 127.0.0.1:${port} capacity=${capacity} latencyMs=${latencyMs}`);
});
