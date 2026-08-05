import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMAdmissionLimits } from "async-bulkhead-llm";
import {
  createLatchfloManagedMode,
  LatchfloTyrAgent,
} from "../src/latchflo.js";
import type {
  AdmissionProvenance,
  PoolLimitsUpdate,
  TyrPoolStats,
} from "../src/pools.js";
import type { TyrControlPlane } from "../src/server.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function createControl(initial: LLMAdmissionLimits): {
  readonly control: TyrControlPlane;
  readonly applied: PoolLimitsUpdate[][];
} {
  const limits: Record<string, LLMAdmissionLimits> = {
    "openai-primary": initial,
  };
  const applied: PoolLimitsUpdate[][] = [];
  const control: TyrControlPlane = {
    limits: () => ({ ...limits }),
    stats: () => ({} as Record<string, TyrPoolStats>),
    applyLimits: (updates) => {
      applied.push([...updates]);
      const results: Record<
        string,
        {
          previous: LLMAdmissionLimits;
          current: LLMAdmissionLimits;
          provenance?: AdmissionProvenance;
        }
      > = {};
      for (const update of updates) {
        const previous = limits[update.pool];
        if (previous === undefined) {
          return {
            applied: false,
            reason: "unknown_pool",
            pool: update.pool,
          };
        }
        limits[update.pool] = update.limits;
        results[update.pool] = {
          previous,
          current: update.limits,
          ...(update.provenance === undefined
            ? {}
            : { provenance: update.provenance }),
        };
      }
      return { applied: true, pools: results };
    },
  };
  return { control, applied };
}

function desiredState(expiresAt: string): string {
  return JSON.stringify({
    controllerEpoch: 7,
    serverTime: new Date().toISOString(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
    grants: [
      {
        grantId: "00000000-0000-4000-8000-000000000007",
        instanceId: "tyr-a",
        pool: "openai-primary",
        controllerEpoch: 7,
        revision: 11,
        issuedAt: new Date().toISOString(),
        expiresAt,
        limits: { revision: 11, maxConcurrent: 4, maxQueue: 1 },
      },
    ],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("condition was not met before timeout"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("Latchflo managed mode", () => {
  it("applies Latchflo provenance and becomes ready", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.[0]?.provenance).toMatchObject({
      source: "latchflo",
      controllerEpoch: 7,
      revision: 11,
    });
    agent.stop();
  });

  it("fails closed and drops readiness when a grant expires", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 40).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    await waitFor(() => applied.length === 2);
    expect(agent.ready()).toBe(false);
    expect(applied[1]?.[0]).toMatchObject({
      limits: { revision: 12, maxConcurrent: 0, maxQueue: 0 },
      provenance: { source: "latchflo", revision: 12 },
    });
    agent.stop();
  });

  it("registers, persists the rotated token, and recovers readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tyr-latchflo-"));
    tempDirectories.push(directory);
    const tokenFile = join(directory, "state", "agent.token");
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let registrations = 0;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        registrations += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "rotated-agent-token", controllerEpoch: 7 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const mode = createLatchfloManagedMode({
      config: {
        url: "http://latchflo.invalid",
        instanceId: "tyr-a",
        pools: ["openai-primary"],
        bootstrapTokenEnv: "TEST_BOOTSTRAP_TOKEN",
        agentTokenFile: tokenFile,
        retryIntervalMs: 100,
        retryMaxIntervalMs: 400,
        requestTimeoutMs: 1_000,
      },
      control,
      env: { TEST_BOOTSTRAP_TOKEN: "bootstrap-token" },
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    mode.start();
    await waitFor(() => mode.ready());
    expect(registrations).toBe(1);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe("rotated-agent-token");
    mode.stop();
  });

  it("keeps a freshly issued token in memory when persisting it fails", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let registrations = 0;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        registrations += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "fresh-token", controllerEpoch: 7 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const failures: Array<{ operation: string; reason: string }> = [];
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      bootstrapToken: "bootstrap-token",
      control,
      fetch: fetchStub,
      onAgentToken: () => {
        throw new Error("EACCES: permission denied, open '/var/lib/tyr/latchflo-agent.token'");
      },
      onFailure: (event) => failures.push(event),
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    expect(registrations).toBe(1);
    expect(failures).toContainEqual({ operation: "persist", reason: "persist_error" });

    // A second cycle must reuse the in-memory token instead of registering
    // again just because it could not be durably persisted.
    await agent.pollNow();
    expect(registrations).toBe(1);
    agent.stop();
  });

  it("keeps a valid grant ready through a transient poll failure", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let failPoll = false;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        if (failPoll) return Promise.resolve(new Response("offline", { status: 503 }));
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    failPoll = true;
    await expect(agent.pollNow()).rejects.toThrow(/desired-state poll failed/);
    expect(agent.ready()).toBe(true);
    agent.stop();
  });

  it("refreshes a stale persisted credential after a 401", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const authorizations: string[] = [];
    let registrations = 0;
    const fetchStub: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(`${url}:${authorization}`);
      if (url.endsWith("/v1/agents/register")) {
        registrations += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "fresh-token", controllerEpoch: 7 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state") && authorization === "Bearer stale-token") {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      bootstrapToken: "bootstrap-token",
      agentToken: "stale-token",
      control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(registrations).toBe(1);
    expect(agent.ready()).toBe(true);
    expect(authorizations.some((value) => value.endsWith(":Bearer fresh-token"))).toBe(true);
    agent.stop();
  });

  it("discards a persisted token rejected with 401 when no bootstrap token is available", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let fetches = 0;
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "revoked-token",
      control,
      fetch: () => {
        fetches += 1;
        return Promise.resolve(new Response("revoked", { status: 401 }));
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(agent.pollNow()).rejects.toThrow(/revoked/);
    expect(fetches).toBe(1);

    // The persisted token is now known-bad and there is no bootstrap token
    // to re-register with: the next attempt must fail fast locally with a
    // clear, actionable message instead of repeating the same doomed
    // request against Latchflo forever.
    await expect(agent.pollNow()).rejects.toThrow(/bootstrap token is required/);
    expect(fetches).toBe(1);
  });

  it("rejects malformed desired state before applying limits", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const malformed = JSON.parse(
      desiredState(new Date(Date.now() + 10_000).toISOString()),
    ) as { grants: Array<{ expiresAt: string }> };
    malformed.grants[0]!.expiresAt = "not-a-timestamp";
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(malformed), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(agent.start()).rejects.toThrow(/expiresAt must be a valid timestamp/);
    expect(applied).toHaveLength(0);
  });

  it("does not restart a connected agent merely because no grant exists yet", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let registrations = 0;
    let desiredStatePolls = 0;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        registrations += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "fresh-token", controllerEpoch: 7 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state")) {
        desiredStatePolls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              controllerEpoch: 7,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 10_000,
              pollIntervalMs: 10_000,
              grants: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const mode = createLatchfloManagedMode({
      config: {
        url: "http://latchflo.invalid",
        instanceId: "tyr-a",
        pools: ["openai-primary"],
        bootstrapTokenEnv: "TEST_BOOTSTRAP_TOKEN",
        retryIntervalMs: 100,
        retryMaxIntervalMs: 400,
        requestTimeoutMs: 1_000,
      },
      control,
      env: { TEST_BOOTSTRAP_TOKEN: "bootstrap-token" },
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    mode.start();
    await waitFor(() => desiredStatePolls === 1);
    await sleep(180);
    expect(mode.ready()).toBe(false);
    expect(registrations).toBe(1);
    expect(desiredStatePolls).toBe(1);
    mode.stop();
  });

  it("retries transient startup failures with bounded jitter", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let registrations = 0;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        registrations += 1;
        if (registrations === 1) {
          return Promise.resolve(new Response("offline", { status: 503 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "fresh-token", controllerEpoch: 7 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 10_000).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const mode = createLatchfloManagedMode({
      config: {
        url: "http://latchflo.invalid",
        instanceId: "tyr-a",
        pools: ["openai-primary"],
        bootstrapTokenEnv: "TEST_BOOTSTRAP_TOKEN",
        retryIntervalMs: 20,
        retryMaxIntervalMs: 80,
        requestTimeoutMs: 1_000,
      },
      control,
      env: { TEST_BOOTSTRAP_TOKEN: "bootstrap-token" },
      fetch: fetchStub,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    mode.start();
    await waitFor(() => mode.ready());
    expect(registrations).toBe(2);
    mode.stop();
  });

  it("keeps retrying a non-retryable startup failure instead of giving up forever", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    let fetches = 0;
    let permanentErrors = 0;
    const mode = createLatchfloManagedMode({
      config: {
        url: "http://latchflo.invalid",
        instanceId: "tyr-a",
        pools: ["openai-primary"],
        bootstrapTokenEnv: "MISSING_BOOTSTRAP_TOKEN",
        retryIntervalMs: 20,
        retryMaxIntervalMs: 80,
        requestTimeoutMs: 1_000,
      },
      control,
      env: {},
      fetch: () => {
        fetches += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      random: () => 0,
      logger: {
        info() {},
        warn() {},
        error() {
          permanentErrors += 1;
        },
      },
    });

    mode.start();
    // A missing bootstrap token fails locally without an HTTP call, but the
    // agent must keep retrying with backoff rather than stopping after the
    // first attempt: only a restart could previously recover from this.
    await waitFor(() => permanentErrors >= 3);
    expect(fetches).toBe(0);
    expect(mode.ready()).toBe(false);

    mode.stop();
    const errorsAtStop = permanentErrors;
    await sleep(100);
    expect(permanentErrors).toBe(errorsAtStop);
  });

  it("keeps expiration enforcement active when acknowledgements fail", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(desiredState(new Date(Date.now() + 40).toISOString()), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/ack")) {
        return Promise.reject(new Error("ack transport unavailable"));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: fetchStub,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    await waitFor(() => applied.length === 2);
    expect(agent.ready()).toBe(false);
    expect(applied[1]?.[0]?.limits).toMatchObject({
      revision: 12,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    agent.stop();
  });

});
