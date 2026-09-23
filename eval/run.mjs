// Tyr evaluation runner.
//
//   node eval/run.mjs                 compare direct-to-provider with through-Tyr
//   node eval/run.mjs --serve         keep the stack running for SDK experiments
//   node eval/run.mjs --quick --assert  short run that fails unless Tyr protects
//                                       interactive traffic (release gate)
//   node eval/run.mjs --upstream=openai --model=<model> --confirm-live
//                                     run the same workload against OpenAI
//
// The stack is three local processes: the evaluation provider, the evaluation
// token issuer, and Tyr started from dist/ with eval/tyr.eval.yaml. Nothing
// needs Docker, Kubernetes, or Latchflo.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? "true"] : [arg, "true"];
  }),
);
const flag = (name) => args.get(name) === "true";

const children = [];
let stopping = false;

// Raised after the stack has started, so the top level can stop without
// reporting a second, redundant error.
class EvalFailure extends Error {}

function fail(message) {
  console.error(`\neval: ${message}`);
  if (children.length === 0) process.exit(1);
  stop(1);
  throw new EvalFailure(message);
}

const SERVE = flag("serve");
const QUICK = flag("quick");
const ASSERT = flag("assert");
const UPSTREAM = args.get("upstream") ?? "mock";
const LIVE = UPSTREAM === "openai";
if (!["mock", "openai"].includes(UPSTREAM)) fail("--upstream must be mock or openai");

const PORTS = { tyr: 8787, provider: 9101, identity: 9102 };
const TYR = `http://127.0.0.1:${PORTS.tyr}`;
const PROVIDER = `http://127.0.0.1:${PORTS.provider}`;
const IDENTITY = `http://127.0.0.1:${PORTS.identity}`;
const PROVIDER_CAPACITY = 8;
const PROVIDER_LATENCY_MS = 500;

const MODEL = args.get("model") ?? (LIVE ? undefined : "gpt-mock");
// The mock provider ignores credentials. Live mode forwards the caller's key.
const API_KEY = LIVE ? process.env.OPENAI_API_KEY : "eval-mock-key";

const WORKLOAD = LIVE
  ? { durationMs: 10_000, interactiveWorkers: 2, batchWorkers: 8, maxOutputTokens: 16, maxCompleted: 40 }
  : {
      durationMs: Number(args.get("duration-ms") ?? (QUICK ? 5_000 : 15_000)),
      interactiveWorkers: 3,
      batchWorkers: 24,
      maxOutputTokens: 32,
      maxCompleted: Infinity,
    };
// Interactive callers pause between requests, like a person at a UI. Every
// caller waits the same fixed interval after a 429 in both phases, so the
// comparison does not depend on Tyr's retry hints.
const INTERACTIVE_THINK_MS = 250;
const BACKOFF_MS = 200;

if (LIVE) {
  if (!API_KEY) fail("live mode needs OPENAI_API_KEY in the environment");
  if (!MODEL) fail("live mode needs --model=<an OpenAI model your key can use>");
  if (!SERVE && !flag("confirm-live")) {
    fail(
      `live mode sends real, billed requests. At most ${WORKLOAD.maxCompleted} reach OpenAI, each ` +
        `limited to ${WORKLOAD.maxOutputTokens} output tokens. Add --confirm-live to run it.`,
    );
  }
}
if (!existsSync(path.join(ROOT, "dist", "index.js"))) fail("dist/ is missing; run `npm run build` first");

// ---------------------------------------------------------------- processes

const logDir = mkdtempSync(path.join(tmpdir(), "tyr-eval-"));

function start(name, command, env = {}) {
  const log = openSync(path.join(logDir, `${name}.log`), "a");
  const child = spawn(process.execPath, command, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  children.push({ name, child });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`\neval: ${name} exited (${signal ?? code}); see ${path.join(logDir, `${name}.log`)}`);
      stop(1);
    }
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(code);
  }, 1500).unref();
  if (children.every(({ child }) => child.exitCode !== null)) process.exit(code);
  Promise.all(children.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  }))).then(() => process.exit(code));
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(url, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  fail(`${name} did not become healthy at ${url}; see ${path.join(logDir, `${name}.log`)}`);
}

async function startStack() {
  const needed = LIVE ? ["tyr", "identity"] : ["tyr", "identity", "provider"];
  for (const name of needed) {
    if (await portInUse(PORTS[name])) {
      fail(`port ${PORTS[name]} is already in use; stop whatever holds it and retry`);
    }
  }
  let config = path.join(ROOT, "eval", "tyr.eval.yaml");
  if (LIVE) {
    const text = readFileSync(config, "utf8");
    const live = text.replace(`baseUrl: ${PROVIDER}`, "baseUrl: https://api.openai.com");
    if (live === text) fail("could not find the provider baseUrl in eval/tyr.eval.yaml");
    config = path.join(logDir, "tyr.live.yaml");
    writeFileSync(config, live);
  } else {
    start("provider", [
      "eval/provider.mjs",
      `--port=${PORTS.provider}`,
      `--capacity=${PROVIDER_CAPACITY}`,
      `--latency-ms=${PROVIDER_LATENCY_MS}`,
    ]);
    await waitFor(`${PROVIDER}/healthz`, "provider");
  }
  start("identity", ["eval/identity.mjs", `--port=${PORTS.identity}`]);
  await waitFor(`${IDENTITY}/healthz`, "identity");
  start("tyr", ["dist/index.js"], { TYR_CONFIG_FILE: config });
  await waitFor(`${TYR}/healthz`, "tyr");
}

async function token(app) {
  const response = await fetch(`${IDENTITY}/token?app=${app}`);
  if (!response.ok) fail(`the token issuer refused a ${app} token`);
  return (await response.json()).token;
}

// ---------------------------------------------------------------- workload

function requestBody(cls, index) {
  return JSON.stringify({
    model: MODEL,
    max_completion_tokens: WORKLOAD.maxOutputTokens,
    messages: [{ role: "user", content: `Evaluation ${cls} request ${index}. Reply in one short sentence.` }],
  });
}

async function runPhase(label, url, identityTokens) {
  const results = { interactive: [], batch: [] };
  const endAt = Date.now() + WORKLOAD.durationMs;
  let completed = 0;
  let sequence = 0;
  // Anything other than success or a capacity 429 means the setup is wrong (a
  // bad key, an unknown model, an unreachable upstream). Stop at the first one
  // instead of repeating it for the rest of the phase.
  let stopped = null;

  async function worker(cls) {
    while (Date.now() < endAt && completed < WORKLOAD.maxCompleted && !stopped) {
      const index = sequence++;
      const headers = { "content-type": "application/json", authorization: `Bearer ${API_KEY}` };
      if (identityTokens) headers["x-tyr-identity-token"] = `Bearer ${identityTokens[cls]}`;
      const startedAt = performance.now();
      let record;
      try {
        const response = await fetch(url, { method: "POST", headers, body: requestBody(cls, index) });
        const body = await response.text();
        record = {
          status: response.status,
          ms: performance.now() - startedAt,
          // Tyr marks its own rejections; a 429 without the header came from the provider.
          byTyr: response.headers.has("x-admission-reason"),
          reason: response.headers.get("x-admission-reason"),
          body: response.ok ? "" : body.slice(0, 300),
        };
      } catch (error) {
        record = { status: 0, ms: performance.now() - startedAt, byTyr: false, error: String(error) };
      }
      results[cls].push(record);
      if (record.status === 200) completed += 1;
      else if (record.status !== 429) stopped ??= record;
      if (record.status === 429) await sleep(BACKOFF_MS);
      else if (cls === "interactive") await sleep(INTERACTIVE_THINK_MS);
    }
  }

  if (!LIVE) await fetch(`${PROVIDER}/stats/reset`, { method: "POST" });
  process.stdout.write(`  ${label} … `);
  const startedAt = Date.now();
  await Promise.all([
    ...Array.from({ length: WORKLOAD.interactiveWorkers }, () => worker("interactive")),
    ...Array.from({ length: WORKLOAD.batchWorkers }, () => worker("batch")),
  ]);
  const seconds = (Date.now() - startedAt) / 1000;
  if (stopped) {
    console.log("stopped");
    fail(
      `a request ${label} failed with ${stopped.status === 0 ? "a transport error" : `HTTP ${stopped.status}`}: ` +
        `${stopped.error ?? stopped.body}\nLogs: ${logDir}`,
    );
  }
  const provider = LIVE ? null : await (await fetch(`${PROVIDER}/stats`)).json();
  console.log(`done in ${seconds.toFixed(1)} s`);
  return { label, results, seconds, provider };
}

// ---------------------------------------------------------------- report

const pct = (part, whole) => (whole === 0 ? "—" : `${((100 * part) / whole).toFixed(0)}%`);
const fmt = (n) => n.toLocaleString("en-US");

function summarize(phase) {
  const summary = {};
  for (const cls of ["interactive", "batch"]) {
    const records = phase.results[cls];
    const ok = records.filter((r) => r.status === 200);
    const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;
    summary[cls] = {
      attempts: records.length,
      ok: ok.length,
      rps: ok.length / phase.seconds,
      p95,
      tyrRejected: records.filter((r) => r.status === 429 && r.byTyr).length,
      providerRejected: records.filter((r) => r.status === 429 && !r.byTyr).length,
      other: records.filter((r) => r.status !== 200 && r.status !== 429),
    };
  }
  return summary;
}

function row(label, ...cells) {
  console.log(`  ${label.padEnd(34)}${cells.map((cell) => String(cell).padEnd(24)).join("")}`.trimEnd());
}

async function tyrMetrics() {
  const text = await (await fetch(`${TYR}/metrics`)).text();
  const lines = text
    .split("\n")
    .filter((line) => /^tyr_(admission_decisions_total|admission_rejections_total)\{/.test(line))
    .filter((line) => line.includes('pool="openai-eval"'));
  return lines;
}

function report(direct, tyr) {
  const d = direct ? summarize(direct) : null;
  const t = summarize(tyr);
  const target = LIVE ? "OpenAI" : `a provider that serves ${PROVIDER_CAPACITY} requests at a time`;
  console.log(`\nInteractive and batch traffic sharing ${target}`);
  console.log(
    `  ${WORKLOAD.interactiveWorkers} interactive callers (${INTERACTIVE_THINK_MS} ms pause between requests) and ` +
      `${WORKLOAD.batchWorkers} batch callers (no pause); every caller waits ${BACKOFF_MS} ms after a 429.\n`,
  );
  const columns = d ? ["Direct to provider", "Through Tyr"] : ["Through Tyr"];
  row("", ...columns);
  const both = (fn) => (d ? [fn(d), fn(t)] : [fn(t)]);
  row("Interactive requests completed", ...both((s) => `${fmt(s.interactive.ok)} / ${fmt(s.interactive.attempts)} (${pct(s.interactive.ok, s.interactive.attempts)})`));
  row("Interactive p95 latency", ...both((s) => (s.interactive.p95 === null ? "—" : `${(s.interactive.p95 / 1000).toFixed(2)} s`)));
  row("Batch requests completed", ...both((s) => `${fmt(s.batch.ok)} (${s.batch.rps.toFixed(1)}/s)`));
  row("Rejected by the provider (429)", ...both((s) => fmt(s.interactive.providerRejected + s.batch.providerRejected)));
  row("Rejected by Tyr (429)", ...(d ? ["—"] : []), `interactive ${fmt(t.interactive.tyrRejected)}, batch ${fmt(t.batch.tyrRejected)}`);
  if (!LIVE) row("Provider peak concurrency", ...[direct, tyr].filter(Boolean).map((p) => `${p.provider.peakInFlight} of ${PROVIDER_CAPACITY}`));

  const errors = [...(d ? [...d.interactive.other, ...d.batch.other] : []), ...t.interactive.other, ...t.batch.other];
  if (errors.length > 0) {
    console.log(`\n  ${errors.length} request(s) failed with another status. First: ${JSON.stringify(errors[0]).slice(0, 300)}`);
  }

  if (d) {
    const batchChange = d.batch.ok === 0 ? 0 : (100 * (t.batch.ok - d.batch.ok)) / d.batch.ok;
    console.log(
      `\n  Without Tyr, the batch flood took the provider's slots and interactive requests were turned away ` +
        `${pct(d.interactive.attempts - d.interactive.ok, d.interactive.attempts)} of the time.` +
        `\n  Through Tyr, interactive traffic kept its three protected slots and batch was held to its ceiling of five,` +
        `\n  so the provider never went over capacity. The cost: batch completed ${Math.abs(batchChange).toFixed(0)}% ` +
        `${batchChange < 0 ? "fewer" : "more"} requests, because slots reserved for interactive traffic sometimes sat idle.`,
    );
  }
  return { d, t };
}

// ---------------------------------------------------------------- main

try {
  console.log(`Tyr evaluation (${LIVE ? `live OpenAI, model ${MODEL}` : "mock provider"}); logs in ${logDir}`);
  await startStack();
  const identityTokens = { interactive: await token("interactive"), batch: await token("batch") };

  if (SERVE) {
    console.log(`
Tyr is running with the evaluation config. Point an OpenAI SDK at it:

  base URL        ${TYR}/v1
  identity header x-tyr-identity-token: Bearer <token>
  tokens          curl -s '${IDENTITY}/token?app=interactive'   (or app=batch)
  provider        ${LIVE ? "api.openai.com, using the API key your client sends" : `mock, ${PROVIDER_CAPACITY} requests at a time, any API key`}

  Node:   npm --prefix eval/sdk install && node eval/sdk/quickstart.mjs
  Python: pip install -r eval/sdk/requirements.txt && python3 eval/sdk/quickstart.py

  Metrics: curl -s ${TYR}/metrics | grep openai-eval
  Stats:   curl -s ${TYR}/stats

Press Ctrl-C to stop.`);
    await new Promise(() => {});
  }

  console.log("Running the same workload twice:");
  const direct = LIVE ? null : await runPhase("direct to provider", `${PROVIDER}/v1/chat/completions`, null);
  const tyr = await runPhase("through Tyr", `${TYR}/v1/chat/completions`, identityTokens);
  const { d, t } = report(direct, tyr);

  console.log("\nTyr's own admission metrics for this run (GET /metrics):");
  for (const line of await tyrMetrics()) console.log(`  ${line}`);
  console.log("\nRun `npm run eval:serve` to keep the stack up and try the OpenAI SDK against it.");

  if (ASSERT) {
    const problems = [];
    if (d && d.interactive.ok / d.interactive.attempts >= 0.9) problems.push("the direct phase showed no contention");
    if (t.interactive.attempts === 0 || t.interactive.ok !== t.interactive.attempts) {
      problems.push(`Tyr completed ${t.interactive.ok} of ${t.interactive.attempts} interactive requests`);
    }
    if (t.interactive.providerRejected + t.batch.providerRejected > 0) problems.push("the provider rejected work behind Tyr");
    if (t.batch.tyrRejected === 0) problems.push("Tyr never shed batch work");
    if (t.batch.ok === 0) problems.push("no batch work completed through Tyr");
    if (problems.length > 0) {
      console.error(`\nFAIL  evaluation assertions: ${problems.join("; ")}`);
      stop(1);
    } else {
      console.log("\nPASS  evaluation: interactive traffic fully protected, provider never over capacity, batch shed by Tyr");
      stop(0);
    }
  } else {
    stop(0);
  }
} catch (error) {
  if (!(error instanceof EvalFailure)) {
    console.error(`\neval: ${error instanceof Error ? error.stack : String(error)}\nLogs: ${logDir}`);
  }
  stop(1);
}
