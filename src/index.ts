import { createGateway } from "./server.js";

const port = Number(process.env["PORT"] ?? 8787);
const upstreamUrl = process.env["UPSTREAM_URL"];
const openaiUpstreamUrl = process.env["OPENAI_UPSTREAM_URL"];
const upstreamTimeoutMs = process.env["UPSTREAM_TIMEOUT_MS"]
  ? Number(process.env["UPSTREAM_TIMEOUT_MS"])
  : undefined;
const maxRequestBodyBytes = process.env["MAX_REQUEST_BODY_BYTES"]
  ? Number(process.env["MAX_REQUEST_BODY_BYTES"])
  : undefined;


if (!upstreamUrl && !openaiUpstreamUrl) {
  throw new Error(
    "at least one of UPSTREAM_URL or OPENAI_UPSTREAM_URL must be set",
  );
}

const { server } = createGateway({
  ...(upstreamUrl !== undefined ? { upstreamUrl } : {}),
  ...(openaiUpstreamUrl !== undefined ? { openaiUpstreamUrl } : {}),
  ...(upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs } : {}),
  ...(maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes } : {}),
  pools: [

    {
      name: "default",
      modelPrefixes: ["claude", "gpt", "o1", "o3", "o4"],
      model: "claude-sonnet-4",
      maxConcurrent: Number(process.env["MAX_CONCURRENT"] ?? 50),
      budget: Number(process.env["TOKEN_BUDGET"] ?? 500_000),
      highPriorityReserve: Number(process.env["HIGH_PRIORITY_RESERVE"] ?? 0),
    },
  ],
});

server.listen(port, () => {
  const routes = [
    upstreamUrl ? `/v1/messages -> ${upstreamUrl}` : undefined,
    openaiUpstreamUrl ? `/v1/chat/completions -> ${openaiUpstreamUrl}` : undefined,
  ].filter(Boolean);
  console.log(`torii-gateway listening on :${port} (${routes.join(", ")})`);
});
