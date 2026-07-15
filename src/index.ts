import { createGateway } from "./server.js";

const port = Number(process.env["PORT"] ?? 8787);
const upstreamUrl =
  process.env["UPSTREAM_URL"] ?? "https://api.anthropic.com";

const { server } = createGateway({
  upstreamUrl,
  pools: [
    {
      name: "default",
      modelPrefixes: ["claude"],
      model: "claude-sonnet-4",
      maxConcurrent: Number(process.env["MAX_CONCURRENT"] ?? 50),
      budget: Number(process.env["TOKEN_BUDGET"] ?? 500_000),
      highPriorityReserve: Number(process.env["HIGH_PRIORITY_RESERVE"] ?? 0),
    },
  ],
});

server.listen(port, () => {
  console.log(`admission-gateway listening on :${port} → ${upstreamUrl}`);
});
