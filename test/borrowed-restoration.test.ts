import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLMBorrowedConcurrencyDeadlineError,
  LLMBulkheadRejectedError,
  type LLMRequest,
} from "async-bulkhead-llm";
import { normalizeAdmissionClassesConfig } from "../src/admission-policy.js";
import { createPools } from "../src/pools.js";
import { createGateway } from "../src/server.js";
import type { TyrAdmissionAuditEvent } from "../src/telemetry.js";

const request: LLMRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "borrowed background work" }],
  max_tokens: 350,
};

const openServers: Server[] = [];

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function poolConfig() {
  return {
    name: "openai",
    modelPrefixes: ["gpt"],
    model: "gpt-4o",
    maxConcurrent: 2,
    budget: 1_000,
    adaptiveEstimation: { enabled: false },
    progressiveReconciliation: { enabled: false },
    admissionClasses: {
      defaultClass: "background",
      classes: {
        interactive: {
          protectedConcurrent: 1,
          protectedInFlightTokens: 600,
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
        },
        background: {
          maxConcurrent: 2,
          maxInFlightTokens: 1_000,
          borrowedAdmissionSlot: {
            releaseMechanism: "deadline_abandonment" as const,
            deadlineMs: 20,
          },
        },
      },
    },
  };
}

describe("resource-specific borrowed-capacity restoration", () => {
  it("releases the borrowed local slot while retaining accounting until work settles", async () => {
    const pools = createPools([poolConfig()]);
    const pool = pools.get("openai")!;
    const prepared = pool.prepare(request, "normal", "background");
    let finish!: () => void;
    let callbackSignal: AbortSignal | undefined;
    const held = pool.run(
      request,
      prepared,
      async (signal, context) => {
        callbackSignal = signal;
        expect(context).toMatchObject({
          resources: { borrowedConcurrency: true },
          borrowedAdmissionSlot: {
            releaseMechanism: "deadline_abandonment",
            deadlineMs: 20,
          },
        });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      { priority: "normal", admissionClass: "background" },
    );

    await expect(held).rejects.toBeInstanceOf(
      LLMBorrowedConcurrencyDeadlineError,
    );
    expect(callbackSignal?.aborted).toBe(true);
    expect(pool.stats()).toMatchObject({
      bulkhead: { inFlight: 0 },
      llm: {
        inFlight: 1,
        released: 0,
        borrowedConcurrencyAbandoned: 1,
        // The lease expired; nothing here was abandoned by an explicit call.
        borrowedConcurrencyAbandonedByCause: { deadline: 1 },
      },
      admissionClasses: {
        classes: {
          background: { inFlight: 0, borrowedConcurrencyAbandoned: 1 },
        },
      },
      tyr: {
        restoration: {
          admissionSlots: {
            enforceability: "enforced",
            configuredDeadlinesMs: { background: 20 },
            released: 1,
            releasedByCause: { deadline: 1 },
          },
          upstreamCapacity: {
            enforceability: "unverified",
            cancellationRequested: 1,
            activeAccountingHolds: 1,
          },
        },
      },
    });

    const anotherBackground = pool.prepare(request, "normal", "background");
    expect(anotherBackground.advisory).toMatchObject({
      admit: false,
      reason: "budget_limit",
      detail: { constraint: "admission_class_protection" },
    });
    await expect(
      pool.run(request, anotherBackground, async () => undefined, {
        priority: "normal",
        admissionClass: "background",
      }),
    ).rejects.toBeInstanceOf(LLMBulkheadRejectedError);

    const interactive = pool.prepare(request, "normal", "interactive");
    await expect(
      pool.run(request, interactive, async (_signal, context) => {
        expect(context?.resources.borrowedConcurrency).toBe(false);
        return "protected";
      }, {
        priority: "normal",
        admissionClass: "interactive",
      }),
    ).resolves.toBe("protected");

    let unboundedDrained = false;
    const unboundedDrain = pool.drain().then(() => {
      unboundedDrained = true;
    });
    await Promise.resolve();
    expect(unboundedDrained).toBe(false);

    finish();
    await unboundedDrain;
    expect(unboundedDrained).toBe(true);
    await expect(pool.drain(100)).resolves.toEqual({
      drained: true,
      inFlight: 0,
      pending: 0,
    });
    expect(pool.stats()).toMatchObject({
      llm: { inFlight: 0, released: 2 },
      tokenBudget: { inFlightTokens: 0 },
      tyr: {
        restoration: {
          upstreamCapacity: { activeAccountingHolds: 0 },
        },
      },
    });
  });

  it("returns a truthful 504 and labels upstream reclamation unverified", async () => {
    let providerWorkActive = false;
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages?: Array<{ content?: string }>;
        };
        const slow = body.messages?.[0]?.content?.includes("deadline") === true;
        const complete = () => {
          providerWorkActive = false;
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-test",
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
          );
        };
        if (slow) {
          providerWorkActive = true;
          setTimeout(complete, 200);
        } else {
          complete();
        }
      });
    });
    const upstreamUrl = await listen(upstream);
    const audits: TyrAdmissionAuditEvent[] = [];
    const gateway = createGateway({
      openaiUpstreamUrl: upstreamUrl,
      pools: [poolConfig()],
      resolveAdmissionClass: (req) =>
        req.headers["x-test-class"] === "interactive"
          ? "interactive"
          : "background",
      telemetry: {
        metricsEnabled: true,
        auditEnabled: true,
        auditSink: (event) => audits.push(event),
      },
    });
    const gatewayUrl = await listen(gateway.server);

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "deadline please" }],
        max_tokens: 350,
      }),
    });
    expect(response.status).toBe(504);
    expect(response.headers.get("x-admission-slot-borrowed")).toBe("true");
    expect(response.headers.get("x-admission-slot-deadline-ms")).toBe("20");
    expect(await response.json()).toMatchObject({
      error: {
        type: "borrowed_admission_deadline",
        resource: "admission_slot",
        localSlotReleased: true,
        upstreamCancellation: "requested",
        upstreamReclamation: "unverified",
        resources: { borrowedConcurrency: true },
      },
    });
    expect(providerWorkActive).toBe(true);
    expect(audits[0]).toMatchObject({
      schema: "tyr.admission-audit.v2",
      outcome: "admitted",
      settlement: "borrowed_admission_deadline",
      resources: { borrowedConcurrency: true },
      restoration: {
        admissionSlot: {
          releaseMechanism: "deadline_abandonment",
          enforceability: "enforced",
          outcome: "released",
          deadlineMs: 20,
        },
        upstreamCapacity: {
          releaseMechanism: "abort_signal",
          enforceability: "unverified",
          outcome: "cancellation_requested",
        },
      },
    });

    const followup = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "quick" }],
        max_tokens: 100,
      }),
    });
    expect(followup.status).toBe(200);
    await followup.text();

    const metrics = await (await fetch(`${gatewayUrl}/metrics`)).text();
    expect(metrics).toContain(
      'tyr_resource_release_events_total{enforceability="enforced",outcome="released",pool="openai",release_mechanism="deadline_abandonment",resource="admission_slot"} 1',
    );
    expect(metrics).toContain(
      'tyr_resource_release_events_total{enforceability="unverified",outcome="cancellation_requested",pool="openai",release_mechanism="abort_signal",resource="upstream_capacity"} 1',
    );
  });

  it("rejects incomplete or misleading borrowed-slot policies", () => {
    for (const policy of [
      { releaseMechanism: "timeout", deadlineMs: 10 },
      { releaseMechanism: "deadline_abandonment", deadlineMs: 0 },
      { releaseMechanism: "deadline_abandonment", deadlineMs: 10, extra: true },
    ]) {
      expect(() =>
        normalizeAdmissionClassesConfig(
          {
            defaultClass: "background",
            classes: {
              background: { borrowedAdmissionSlot: policy },
            },
          } as never,
          "policy",
          false,
        ),
      ).toThrow(/borrowedAdmissionSlot/);
    }
  });
});
