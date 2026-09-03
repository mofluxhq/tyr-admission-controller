import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMAdmissionLimits } from "async-bulkhead-llm";
import {
  createLatchfloManagedMode,
  LatchfloTyrAgent,
  type LatchfloRoutingTopology,
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

function desiredState(
  expiresAt: string,
  routingTopology?: LatchfloRoutingTopology,
): string {
  return JSON.stringify({
    controllerEpoch: 7,
    serverTime: new Date().toISOString(),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs: 10_000,
    ...(routingTopology === undefined ? {} : { routingTopology }),
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

  it("delivers validated Latchflo routing topology without requiring it from older controllers", async () => {
    const { control } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const observed: LatchfloRoutingTopology[] = [];
    let polls = 0;
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        polls += 1;
        return Promise.resolve(
          new Response(
            desiredState(
              new Date(Date.now() + 10_000).toISOString(),
              polls === 1
                ? {
                    revision: 3,
                    members: [
                      { instanceId: "tyr-a", endpoint: "http://tyr-a:8787/" },
                      { instanceId: "tyr-b", endpoint: "http://tyr-b:8787" },
                    ],
                  }
                : undefined,
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
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
      onRoutingTopology: (topology) => observed.push(topology),
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(observed).toEqual([
      {
        revision: 3,
        members: [
          { instanceId: "tyr-a", endpoint: "http://tyr-a:8787" },
          { instanceId: "tyr-b", endpoint: "http://tyr-b:8787" },
        ],
      },
    ]);

    await agent.pollNow();
    expect(observed).toHaveLength(1);
    agent.stop();
  });

  it("rejects malformed routing endpoints before applying desired-state grants", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
    });
    const fetchStub: typeof globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(
            desiredState(new Date(Date.now() + 10_000).toISOString(), {
              revision: 1,
              members: [
                { instanceId: "tyr-b", endpoint: "file:///tmp/not-routable" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
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

    await expect(agent.start()).rejects.toThrow(/must use http or https/);
    expect(applied).toHaveLength(0);
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

describe("Latchflo admission-class grants", () => {
  const CLASS_POOL_LIMITS: LLMAdmissionLimits = {
    revision: 0,
    maxConcurrent: 0,
    maxQueue: 0,
    tokenBudget: { budget: 0, highPriorityReserve: 0 },
    admissionClasses: {
      premium: { maxConcurrent: 0, maxInFlightTokens: 0 },
      noisy: { maxConcurrent: 0, maxInFlightTokens: 0 },
    },
  };

  function classDesiredState(
    admissionClasses: unknown,
    revision = 11,
  ): string {
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
          revision,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
          limits: {
            revision,
            maxConcurrent: 8,
            maxQueue: 0,
            tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
            ...(admissionClasses === undefined ? {} : { admissionClasses }),
          },
        },
      ],
    });
  }

  function collectingFetch(body: string): {
    readonly fetch: typeof globalThis.fetch;
    readonly registrations: unknown[];
    readonly acks: unknown[];
  } {
    const registrations: unknown[] = [];
    const acks: unknown[] = [];
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/register")) {
        registrations.push(JSON.parse(String(init?.body ?? "{}")));
        return Promise.resolve(
          new Response(
            JSON.stringify({ agentToken: "issued", controllerEpoch: 7 }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/ack")) {
        acks.push(JSON.parse(String(init?.body ?? "{}")));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    return { fetch: fetchImpl, registrations, acks };
  }

  it("advertises the admissionClasses capability when registering", async () => {
    const { control } = createControl({ ...CLASS_POOL_LIMITS });
    const stub = collectingFetch(
      classDesiredState({
        premium: {
          protectedConcurrent: 1,
          maxConcurrent: 2,
          protectedInFlightTokens: 2_000,
          maxInFlightTokens: 4_000,
        },
        noisy: {
          protectedConcurrent: 2,
          maxConcurrent: 6,
          protectedInFlightTokens: 4_000,
          maxInFlightTokens: 12_000,
        },
      }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      bootstrapToken: "bootstrap",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(stub.registrations).toHaveLength(1);
    expect(stub.registrations[0]).toMatchObject({
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      capabilities: {
        admissionClasses: true,
        admissionClassDemand: true,
        grantOccupancyAck: true,
        admissionClassOccupancyAck: true,
        borrowedAdmissionSlotDeadlines: true,
      },
    });
    agent.stop();
  });

  it("applies the per-replica class partition carried on the grant", async () => {
    const { control, applied } = createControl({ ...CLASS_POOL_LIMITS });
    const stub = collectingFetch(
      classDesiredState({
        premium: {
          protectedConcurrent: 1,
          maxConcurrent: 2,
          protectedInFlightTokens: 2_000,
          maxInFlightTokens: 4_000,
        },
        noisy: {
          protectedConcurrent: 2,
          maxConcurrent: 6,
          protectedInFlightTokens: 4_000,
          maxInFlightTokens: 12_000,
        },
      }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.[0]?.limits.admissionClasses).toEqual({
      premium: {
        protectedConcurrent: 1,
        maxConcurrent: 2,
        protectedInFlightTokens: 2_000,
        maxInFlightTokens: 4_000,
      },
      noisy: {
        protectedConcurrent: 2,
        maxConcurrent: 6,
        protectedInFlightTokens: 4_000,
        maxInFlightTokens: 12_000,
      },
    });
    agent.stop();
  });

  it("keeps the locally configured class table when a grant omits classes", async () => {
    const { control, applied } = createControl({
      ...CLASS_POOL_LIMITS,
      admissionClasses: {
        premium: { maxConcurrent: 3, maxInFlightTokens: 5_000 },
        noisy: { maxConcurrent: 5, maxInFlightTokens: 11_000 },
      },
    });
    const stub = collectingFetch(classDesiredState(undefined));
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(true);
    expect(applied[0]?.[0]?.limits.admissionClasses).toEqual({
      premium: { maxConcurrent: 3, maxInFlightTokens: 5_000 },
      noisy: { maxConcurrent: 5, maxInFlightTokens: 11_000 },
    });
    agent.stop();
  });

  it("fails closed with protected floors and restores the last class table", async () => {
    const initial: LLMAdmissionLimits = {
      ...CLASS_POOL_LIMITS,
      admissionClasses: {
        premium: {
          protectedConcurrent: 0,
          maxConcurrent: 0,
          protectedInFlightTokens: 0,
          maxInFlightTokens: 0,
        },
        noisy: {
          protectedConcurrent: 0,
          maxConcurrent: 0,
          protectedInFlightTokens: 0,
          maxInFlightTokens: 0,
        },
      },
    };
    const { control, applied } = createControl(initial);
    const acks: unknown[] = [];
    let revision = 11;
    let includeClasses = true;
    let expiresAt = new Date(Date.now() + 100).toISOString();
    const grantedClasses = {
      premium: {
        protectedConcurrent: 1,
        maxConcurrent: 2,
        protectedInFlightTokens: 2_000,
        maxInFlightTokens: 4_000,
      },
      noisy: {
        protectedConcurrent: 2,
        maxConcurrent: 6,
        protectedInFlightTokens: 4_000,
        maxInFlightTokens: 12_000,
      },
    };
    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(
            classDesiredState(
              includeClasses ? grantedClasses : undefined,
              revision,
            ).replace(
              /"expiresAt":"[^"]+"/,
              `"expiresAt":"${expiresAt}"`,
            ),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/ack")) {
        acks.push(JSON.parse(String(init?.body)));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: fetchImpl,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    await waitFor(() => applied.length === 2);
    expect(applied[1]?.[0]?.limits).toMatchObject({
      revision: 12,
      maxConcurrent: 0,
      maxQueue: 0,
      admissionClasses: {
        premium: {
          protectedConcurrent: 0,
          maxConcurrent: 2,
          protectedInFlightTokens: 0,
          maxInFlightTokens: 4_000,
        },
        noisy: {
          protectedConcurrent: 0,
          maxConcurrent: 6,
          protectedInFlightTokens: 0,
          maxInFlightTokens: 12_000,
        },
      },
    });

    revision = 13;
    includeClasses = false;
    expiresAt = new Date(Date.now() + 10_000).toISOString();
    await agent.pollNow();
    expect(applied[2]?.[0]?.limits.admissionClasses).toEqual(grantedClasses);

    const applyCount = applied.length;
    await agent.pollNow();
    expect(applied).toHaveLength(applyCount);
    expect(acks.at(-1)).toMatchObject({ status: "applied", revision: 13 });
    expect(agent.ready()).toBe(true);
    agent.stop();
  });

  it("rejects the grant instead of throwing when class keys disagree", async () => {
    const { control, applied } = createControl({ ...CLASS_POOL_LIMITS });
    const stub = collectingFetch(
      classDesiredState({
        premium: { maxConcurrent: 2, maxInFlightTokens: 4_000 },
        unexpected: { maxConcurrent: 6, maxInFlightTokens: 12_000 },
      }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(false);
    expect(applied).toHaveLength(0);
    expect(stub.acks).toHaveLength(1);
    expect(stub.acks[0]).toMatchObject({
      status: "rejected",
      reason: "admission_class_key_mismatch",
    });
    agent.stop();
  });

  it("rejects class limits for a pool that has no class table", async () => {
    const { control, applied } = createControl({
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
      tokenBudget: { budget: 0, highPriorityReserve: 0 },
    });
    const stub = collectingFetch(
      classDesiredState({ premium: { maxConcurrent: 2 } }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(false);
    expect(applied).toHaveLength(0);
    expect(stub.acks[0]).toMatchObject({
      status: "rejected",
      reason: "admission_classes_not_configured",
    });
    agent.stop();
  });

  it("treats a same-revision grant with different class limits as a conflict", async () => {
    const { control, applied } = createControl({
      ...CLASS_POOL_LIMITS,
      revision: 11,
      maxConcurrent: 8,
      maxQueue: 0,
      tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
      admissionClasses: {
        premium: { maxConcurrent: 2, maxInFlightTokens: 4_000 },
        noisy: { maxConcurrent: 6, maxInFlightTokens: 12_000 },
      },
    });
    const stub = collectingFetch(
      classDesiredState({
        premium: { maxConcurrent: 4, maxInFlightTokens: 4_000 },
        noisy: { maxConcurrent: 4, maxInFlightTokens: 12_000 },
      }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    expect(agent.ready()).toBe(false);
    expect(applied).toHaveLength(0);
    expect(stub.acks[0]).toMatchObject({
      status: "rejected",
      reason: "revision_content_conflict",
    });
    agent.stop();
  });

  it("rejects a malformed class table on the grant", async () => {
    const { control } = createControl({ ...CLASS_POOL_LIMITS });
    const stub = collectingFetch(
      classDesiredState({ premium: { maxConcurrent: -1 } }),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(agent.start()).rejects.toThrow(
      /admissionClasses\["premium"\]\.maxConcurrent must be a safe integer >= 0/,
    );
    expect(agent.ready()).toBe(false);
    agent.stop();
  });

  it("rejects a reserved class ID on the grant", async () => {
    const { control } = createControl({ ...CLASS_POOL_LIMITS });
    const stub = collectingFetch(
      classDesiredState(JSON.parse('{"__proto__":{"maxConcurrent":1}}')),
    );
    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: ["openai-primary"],
      agentToken: "persisted-token",
      control,
      fetch: stub.fetch,
      logger: { info() {}, warn() {}, error() {} },
    });

    await expect(agent.start()).rejects.toThrow(/reserved class ID/);
    expect(agent.ready()).toBe(false);
    agent.stop();
  });
});

describe("Latchflo acknowledged capacity handoff evidence", () => {
  it("publishes post-ack occupancy and accelerates until the published drain is safe", async () => {
    const pool = "openai-primary";
    let revision = 10;
    let maxConcurrent = 8;
    let tokenBudget = 16_000;
    let inFlight = 6;
    let inFlightTokens = 12_000;
    let current: LLMAdmissionLimits = {
      revision: 0,
      maxConcurrent: 0,
      maxQueue: 0,
      tokenBudget: { budget: 0, highPriorityReserve: 0 },
    };
    const events: Array<{ type: "ack" | "heartbeat"; body: unknown }> = [];

    const control: TyrControlPlane = {
      limits: () => ({ [pool]: current }),
      stats: () => ({
        [pool]: {
          bulkhead: { inFlight, pending: 0 },
          tokenBudget: { inFlightTokens },
        } as unknown as TyrPoolStats,
      }),
      applyLimits: (updates) => {
        const update = updates[0];
        if (update === undefined) {
          return { applied: false, reason: "unknown_pool", pool };
        }
        const previous = current;
        current = update.limits;
        return {
          applied: true,
          pools: {
            [pool]: {
              previous,
              current,
              ...(update.provenance === undefined
                ? {}
                : { provenance: update.provenance }),
            },
          },
        };
      },
    };

    const state = (): string =>
      JSON.stringify({
        controllerEpoch: 7,
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: 10_000,
        pollIntervalMs: 10_000,
        grants: [
          {
            grantId: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
            instanceId: "tyr-a",
            pool,
            controllerEpoch: 7,
            revision,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            limits: {
              revision,
              maxConcurrent,
              maxQueue: 0,
              tokenBudget: { budget: tokenBudget, highPriorityReserve: 0 },
            },
          },
        ],
      });

    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(state(), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      if (url.endsWith("/ack")) {
        events.push({
          type: "ack",
          body: JSON.parse(String(init?.body ?? "{}")),
        });
      } else if (url.endsWith("/heartbeat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          demand?: Array<{ inFlight?: number }>;
        };
        events.push({ type: "heartbeat", body });
        if (revision === 11 && body.demand?.[0]?.inFlight === 6) {
          inFlight = 4;
          inFlightTokens = 8_000;
        }
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: [pool],
      agentToken: "persisted-token",
      control,
      fetch: fetchImpl,
      demandProvider: () => [
        {
          pool,
          observedAt: new Date().toISOString(),
          inFlight,
          pending: 0,
          recentAdmissions: 0,
          recentRejections: 0,
          recentBudgetRejections: 0,
          recentConcurrencyRejections: 0,
          inFlightTokens,
          availableTokens: Math.max(0, tokenBudget - inFlightTokens),
        },
      ],
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    await waitFor(() => events.some((event) => event.type === "heartbeat"));
    events.length = 0;

    revision = 11;
    maxConcurrent = 4;
    tokenBudget = 8_000;
    await agent.pollNow();

    expect(events[0]?.type).toBe("ack");
    expect(events[0]?.body).toMatchObject({
      status: "applied",
      revision: 11,
      occupancy: { inFlight: 6, inFlightTokens: 12_000 },
    });
    expect(events[1]?.type).toBe("heartbeat");
    expect(events[1]?.body).toMatchObject({
      demand: [{ pool, inFlight: 6, inFlightTokens: 12_000 }],
    });
    expect(inFlight).toBe(4);
    expect(inFlightTokens).toBe(8_000);

    await waitFor(
      () => events.filter((event) => event.type === "heartbeat").length >= 2,
      1_500,
    );
    expect(
      events.filter((event) => event.type === "heartbeat").at(-1)?.body,
    ).toMatchObject({
      demand: [{ pool, inFlight: 4, inFlightTokens: 8_000 }],
    });
    agent.stop();
  });
});

describe("Latchflo acknowledged admission-class handoff evidence", () => {
  it("publishes ordered class occupancy and accelerates until shared borrowing is safe", async () => {
    const pool = "openai-primary";
    let desiredRevision = 10;
    let premiumInFlight = 8;
    let premiumInFlightTokens = 16_000;
    let current: LLMAdmissionLimits = {
      revision: 10,
      maxConcurrent: 8,
      maxQueue: 0,
      tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
      admissionClasses: {
        premium: {
          protectedConcurrent: 4,
          maxConcurrent: 8,
          protectedInFlightTokens: 8_000,
          maxInFlightTokens: 16_000,
        },
        noisy: {
          protectedConcurrent: 0,
          maxConcurrent: 8,
          protectedInFlightTokens: 0,
          maxInFlightTokens: 16_000,
        },
      },
    };
    type ClassEvidence = {
      readonly admissionClass?: string;
      readonly borrowedConcurrent?: number;
      readonly borrowedInFlightTokens?: number;
    };
    type EventBody = {
      readonly status?: string;
      readonly revision?: number;
      readonly occupancy?: { readonly admissionClasses?: readonly ClassEvidence[] };
      readonly demand?: readonly { readonly admissionClasses?: readonly ClassEvidence[] }[];
    };
    const events: Array<{ type: "ack" | "heartbeat"; body: EventBody }> = [];

    const stats = (): TyrPoolStats => {
      const premiumLimits = current.admissionClasses?.premium;
      const noisyLimits = current.admissionClasses?.noisy;
      if (premiumLimits === undefined || noisyLimits === undefined) {
        throw new Error("class limits must be present");
      }
      const premiumProtectedConcurrent = premiumLimits.protectedConcurrent ?? 0;
      const premiumProtectedTokens = premiumLimits.protectedInFlightTokens ?? 0;
      const premiumProtectedConcurrentInUse = Math.min(
        premiumInFlight,
        premiumProtectedConcurrent,
      );
      const premiumProtectedTokensInUse = Math.min(
        premiumInFlightTokens,
        premiumProtectedTokens,
      );
      return {
        bulkhead: { inFlight: premiumInFlight, pending: 0 },
        tokenBudget: {
          inFlightTokens: premiumInFlightTokens,
          available: Math.max(0, 16_000 - premiumInFlightTokens),
        },
        admissionClasses: {
          defaultClass: "noisy",
          classes: {
            noisy: {
              limits: noisyLimits,
              inFlight: 0,
              protectedConcurrentInUse: 0,
              borrowedConcurrent: 0,
              inFlightTokens: 0,
              protectedTokensInUse: 0,
              borrowedInFlightTokens: 0,
              admitted: 0,
              released: 0,
              rejected: 0,
              rejectedByReason: {},
              totalReserved: 0,
              totalConsumed: 0,
              totalRefunded: 0,
              totalOverrun: 0,
              totalBorrowedAdmissions: 0,
              totalBorrowedTokensReserved: 0,
            },
            premium: {
              limits: premiumLimits,
              inFlight: premiumInFlight,
              protectedConcurrentInUse: premiumProtectedConcurrentInUse,
              borrowedConcurrent: Math.max(
                0,
                premiumInFlight - premiumProtectedConcurrentInUse,
              ),
              inFlightTokens: premiumInFlightTokens,
              protectedTokensInUse: premiumProtectedTokensInUse,
              borrowedInFlightTokens: Math.max(
                0,
                premiumInFlightTokens - premiumProtectedTokensInUse,
              ),
              admitted: 0,
              released: 0,
              rejected: 0,
              rejectedByReason: {},
              totalReserved: 0,
              totalConsumed: 0,
              totalRefunded: 0,
              totalOverrun: 0,
              totalBorrowedAdmissions: 0,
              totalBorrowedTokensReserved: 0,
            },
          },
          shared: {
            maxConcurrent: 0,
            inFlight: 0,
            availableConcurrent: 0,
            tokenBudget: { budget: 0, inFlightTokens: 0, available: 0 },
          },
        },
      } as unknown as TyrPoolStats;
    };

    const desiredClasses = (): NonNullable<LLMAdmissionLimits["admissionClasses"]> =>
      desiredRevision === 10
        ? (current.admissionClasses as NonNullable<
            LLMAdmissionLimits["admissionClasses"]
          >)
        : {
            premium: {
              protectedConcurrent: 4,
              maxConcurrent: 8,
              protectedInFlightTokens: 8_000,
              maxInFlightTokens: 16_000,
            },
            noisy: {
              protectedConcurrent: 2,
              maxConcurrent: 8,
              protectedInFlightTokens: 4_000,
              maxInFlightTokens: 16_000,
            },
          };

    const control: TyrControlPlane = {
      limits: () => ({ [pool]: current }),
      stats: () => ({ [pool]: stats() }),
      applyLimits: (updates) => {
        const update = updates[0];
        if (update === undefined) {
          return { applied: false, reason: "unknown_pool", pool };
        }
        const previous = current;
        current = update.limits;
        return {
          applied: true,
          pools: {
            [pool]: {
              previous,
              current,
              ...(update.provenance === undefined
                ? {}
                : { provenance: update.provenance }),
            },
          },
        };
      },
    };

    const demandProvider = () => {
      const currentStats = stats();
      const classes = currentStats.admissionClasses?.classes;
      if (classes === undefined) throw new Error("class stats must be present");
      return [
        {
          pool,
          observedAt: new Date().toISOString(),
          inFlight: premiumInFlight,
          pending: 0,
          recentAdmissions: 0,
          recentRejections: 0,
          recentBudgetRejections: 0,
          recentConcurrencyRejections: 0,
          inFlightTokens: premiumInFlightTokens,
          availableTokens: Math.max(0, 16_000 - premiumInFlightTokens),
          admissionClasses: Object.keys(classes)
            .sort()
            .map((admissionClass) => {
              const state = classes[admissionClass];
              if (state === undefined) throw new Error("class stat missing");
              return {
                admissionClass,
                inFlight: state.inFlight,
                recentAdmissions: 0,
                recentRejections: 0,
                recentBudgetRejections: 0,
                recentConcurrencyRejections: 0,
                protectedConcurrent: state.limits.protectedConcurrent ?? 0,
                protectedConcurrentInUse: state.protectedConcurrentInUse,
                borrowedConcurrent: state.borrowedConcurrent,
                ...(state.limits.maxConcurrent === undefined
                  ? {}
                  : { maxConcurrent: state.limits.maxConcurrent }),
                inFlightTokens: state.inFlightTokens,
                protectedInFlightTokens:
                  state.limits.protectedInFlightTokens ?? 0,
                protectedTokensInUse: state.protectedTokensInUse,
                borrowedInFlightTokens: state.borrowedInFlightTokens,
                ...(state.limits.maxInFlightTokens === undefined
                  ? {}
                  : { maxInFlightTokens: state.limits.maxInFlightTokens }),
              };
            }),
        },
      ];
    };

    const fetchImpl: typeof globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.endsWith("/desired-state")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              controllerEpoch: 7,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: 10_000,
              pollIntervalMs: 10_000,
              grants: [
                {
                  grantId: `00000000-0000-4000-8000-${String(desiredRevision).padStart(12, "0")}`,
                  instanceId: "tyr-a",
                  pool,
                  controllerEpoch: 7,
                  revision: desiredRevision,
                  issuedAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 30_000).toISOString(),
                  limits: {
                    revision: desiredRevision,
                    maxConcurrent: 8,
                    maxQueue: 0,
                    tokenBudget: { budget: 16_000, highPriorityReserve: 0 },
                    admissionClasses: desiredClasses(),
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (url.endsWith("/ack")) {
        events.push({
          type: "ack",
          body: JSON.parse(String(init?.body ?? "{}")),
        });
      } else if (url.endsWith("/heartbeat")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        events.push({ type: "heartbeat", body });
        const premium = body.demand?.[0]?.admissionClasses?.find(
          (entry: { admissionClass?: string }) => entry.admissionClass === "premium",
        );
        if (desiredRevision === 11 && premium?.borrowedConcurrent === 4) {
          premiumInFlight = 6;
          premiumInFlightTokens = 12_000;
        }
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    const agent = new LatchfloTyrAgent({
      controlPlaneUrl: "http://latchflo.invalid",
      instanceId: "tyr-a",
      pools: [pool],
      agentToken: "persisted-token",
      control,
      fetch: fetchImpl,
      demandProvider,
      logger: { info() {}, warn() {}, error() {} },
    });

    await agent.start();
    await waitFor(() => events.some((event) => event.type === "heartbeat"));
    events.length = 0;

    desiredRevision = 11;
    await agent.pollNow();

    expect(events[0]?.type).toBe("ack");
    expect(events[0]?.body).toMatchObject({
      status: "applied",
      revision: 11,
      occupancy: {
        admissionClasses: expect.arrayContaining([
          expect.objectContaining({
            admissionClass: "premium",
            borrowedConcurrent: 4,
            borrowedInFlightTokens: 8_000,
          }),
          expect.objectContaining({
            admissionClass: "noisy",
            protectedConcurrent: 2,
            protectedInFlightTokens: 4_000,
          }),
        ]),
      },
    });
    expect(events[1]?.type).toBe("heartbeat");

    await waitFor(
      () => events.filter((event) => event.type === "heartbeat").length >= 2,
      1_500,
    );
    const finalHeartbeat = events
      .filter((event) => event.type === "heartbeat")
      .at(-1)?.body;
    expect(finalHeartbeat).toMatchObject({
      demand: [
        {
          admissionClasses: expect.arrayContaining([
            expect.objectContaining({
              admissionClass: "premium",
              borrowedConcurrent: 2,
              borrowedInFlightTokens: 4_000,
            }),
          ]),
        },
      ],
    });
    agent.stop();
  });
});
