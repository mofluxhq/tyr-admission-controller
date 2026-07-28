const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && value !== undefined) args.set(key.slice(2), value);
}

function positiveInteger(name, fallback) {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

const url = args.get("url") ?? "http://127.0.0.1:8787/v1/chat/completions";
const requests = positiveInteger("requests", 20);
const concurrency = positiveInteger("concurrency", 2);
const priority = args.get("priority") === "high" ? "high" : "normal";
const results = new Map();
let next = 0;
const startedAt = performance.now();

async function execute(index) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-priority": priority,
      },
      body: JSON.stringify({
        model: "gpt-4o-demo",
        max_completion_tokens: 1000,
        messages: [{ role: "user", content: `demo request ${index}` }],
      }),
    });
    let reason = "";
    if (!response.ok) {
      try {
        const body = await response.json();
        reason = body?.error?.reason ? `:${body.error.reason}` : "";
      } catch {
        // Response classification still works without a JSON error body.
      }
    } else {
      await response.arrayBuffer();
    }
    const key = `${response.status}${reason}`;
    results.set(key, (results.get(key) ?? 0) + 1);
  } catch (error) {
    const key = `transport:${error instanceof Error ? error.name : "error"}`;
    results.set(key, (results.get(key) ?? 0) + 1);
  }
}

async function worker() {
  while (true) {
    const index = next;
    next += 1;
    if (index >= requests) return;
    await execute(index + 1);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker));
const elapsedSeconds = (performance.now() - startedAt) / 1000;

console.log(`sent=${requests} concurrency=${concurrency} priority=${priority}`);
for (const [result, count] of [...results.entries()].sort()) {
  console.log(`${result.padEnd(28)} ${count}`);
}
console.log(`elapsedSeconds=${elapsedSeconds.toFixed(2)}`);
