import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRuntimeConfig,
  loadRuntimeConfigFile,
} from "../src/config.js";

const tempDirs: string[] = [];

function tempConfig(contents: string, filename = "tyr.yaml"): string {
  const dir = mkdtempSync(join(tmpdir(), "tyr-config-"));
  tempDirs.push(dir);
  const path = join(dir, filename);
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const validConfig = `
version: 1
server:
  port: 9090
  maxRequestBodyBytes: 2097152
  maxOutputTokens: 100000
timeouts:
  responseHeadersMs: 10000
  streamIdleMs: 20000
  clientStallMs: 30000
shutdown:
  drainTimeoutMs: 45000
priority:
  trustHeader: false
upstreams:
  anthropic:
    baseUrl: https://api.anthropic.com
  openai:
    baseUrl: https://api.openai.com/
pools:
  - name: interactive
    modelPrefixes: [claude-sonnet-4, claude-haiku-4]
    estimatorModel: claude-sonnet-4-5
    maxConcurrent: 40
    maxQueue: 3
    queueTimeoutMs: 250
    limitsRevision: 17
    inFlightTokenBudget: 400000
    highPriorityTokenReserve: 80000
    defaultOutputReservation: 8192
    opaqueMediaInputTokenReservation: 3072
    admissionMode: observe
    adaptiveEstimation:
      enabled: true
      smoothing: 0.3
      minSamples: 3
      minCorrection: 0.6
      maxCorrection: 1.8
      maxModels: 32
  - name: batch
    modelPrefixes: [gpt-4o, gpt-5]
    estimatorModel: gpt-4o
    maxConcurrent: 20
`;

describe("file configuration", () => {
  it("loads and normalizes a versioned multi-pool YAML file", () => {
    const path = tempConfig(validConfig);
    const config = loadRuntimeConfigFile(path);

    expect(config.port).toBe(9090);
    expect(config.gateway.upstreamUrl).toBe("https://api.anthropic.com");
    expect(config.gateway.openaiUpstreamUrl).toBe("https://api.openai.com");
    expect(config.gateway.responseTimeoutMs).toBe(10_000);
    expect(config.gateway.idleTimeoutMs).toBe(20_000);
    expect(config.gateway.clientStallTimeoutMs).toBe(30_000);
    expect(config.gateway.shutdownDrainTimeoutMs).toBe(45_000);
    expect(config.gateway.pools).toEqual([
      {
        name: "interactive",
        modelPrefixes: ["claude-sonnet-4", "claude-haiku-4"],
        model: "claude-sonnet-4-5",
        maxConcurrent: 40,
        maxQueue: 3,
        queueTimeoutMs: 250,
        initialRevision: 17,
        budget: 400_000,
        highPriorityReserve: 80_000,
        outputCap: 8192,
        opaqueMediaInputTokens: 3072,
        admissionMode: "observe",
        adaptiveEstimation: {
          enabled: true,
          smoothing: 0.3,
          minSamples: 3,
          minCorrection: 0.6,
          maxCorrection: 1.8,
          maxModels: 32,
        },
      },
      {
        name: "batch",
        modelPrefixes: ["gpt-4o", "gpt-5"],
        model: "gpt-4o",
        maxConcurrent: 20,
      },
    ]);
    expect(config.source.kind).toBe("file");
    if (config.source.kind === "file") {
      expect(config.source.path).toBe(path);
      expect(config.source.version).toBe(1);
      expect(config.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("uses documented defaults for optional server and priority fields", () => {
    const path = tempConfig(`
version: 1
upstreams:
  openai:
    baseUrl: http://localhost:8000
pools:
  - name: local
    modelPrefixes: [local-]
    estimatorModel: gpt-4o
    maxConcurrent: 2
    inFlightTokenBudget: 0
`);
    const config = loadRuntimeConfigFile(path);
    expect(config.port).toBe(8787);
    expect(config.gateway.trustPriorityHeader).toBe(false);
    expect(config.gateway.pools[0]?.budget).toBe(0);
  });

  it("loads the opaque-media reservation override", () => {
    const path = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: http://localhost:8000 }
pools:
  - name: local
    modelPrefixes: [local-]
    estimatorModel: gpt-4o
    maxConcurrent: 2
    inFlightTokenBudget: 10000
    opaqueMediaInputTokenReservation: 0
`);
    const config = loadRuntimeConfigFile(path);
    expect(config.gateway.pools[0]?.opaqueMediaInputTokens).toBe(0);
  });

  it("supports Anthropic-only and OpenAI-only configurations", () => {
    const anthropic = loadRuntimeConfigFile(
      tempConfig(`
version: 1
upstreams:
  anthropic: { baseUrl: https://api.anthropic.com }
pools:
  - name: claude
    modelPrefixes: [claude]
    estimatorModel: claude-sonnet-4
    maxConcurrent: 1
`, "anthropic.yaml"),
    );
    expect(anthropic.gateway.upstreamUrl).toBeDefined();
    expect(anthropic.gateway.openaiUpstreamUrl).toBeUndefined();

    const openai = loadRuntimeConfigFile(
      tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: openai
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
`, "openai.yaml"),
    );
    expect(openai.gateway.upstreamUrl).toBeUndefined();
    expect(openai.gateway.openaiUpstreamUrl).toBeDefined();
  });

  it("rejects unknown properties so configuration typos cannot be ignored", () => {
    const path = tempConfig(validConfig.replace("maxConcurrent: 40", "maxConcurent: 40"));
    expect(() => loadRuntimeConfigFile(path)).toThrow(/unknown property.*maxConcurent/);
  });

  it("rejects unsupported versions", () => {
    const path = tempConfig(validConfig.replace("version: 1", "version: 2"));
    expect(() => loadRuntimeConfigFile(path)).toThrow(/supports version 1/);
  });

  it("rejects invalid upstream URLs", () => {
    const path = tempConfig(validConfig.replace("https://api.openai.com/", "ftp://api.openai.com"));
    expect(() => loadRuntimeConfigFile(path)).toThrow(/must use http: or https:/);
  });

  it("requires at least one upstream", () => {
    const path = tempConfig(`
version: 1
upstreams: {}
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
`);
    expect(() => loadRuntimeConfigFile(path)).toThrow(/at least one of upstreams/);
  });

  it("rejects duplicate pool names and model prefixes", () => {
    const duplicateName = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: same
    modelPrefixes: [gpt-4]
    estimatorModel: gpt-4o
    maxConcurrent: 1
  - name: same
    modelPrefixes: [gpt-5]
    estimatorModel: gpt-5
    maxConcurrent: 1
`, "duplicate-name.yaml");
    expect(() => loadRuntimeConfigFile(duplicateName)).toThrow(/duplicate pool name/);

    const duplicatePrefix = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: first
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
  - name: second
    modelPrefixes: [gpt]
    estimatorModel: gpt-5
    maxConcurrent: 1
`, "duplicate-prefix.yaml");
    expect(() => loadRuntimeConfigFile(duplicatePrefix)).toThrow(/duplicate model prefix/);
  });

  it("validates priority reserve relationships", () => {
    const noBudget = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
    highPriorityTokenReserve: 10
`, "no-budget.yaml");
    expect(() => loadRuntimeConfigFile(noBudget)).toThrow(/requires.*inFlightTokenBudget/);

    const tooLarge = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
    inFlightTokenBudget: 10
    highPriorityTokenReserve: 11
`, "too-large.yaml");
    expect(() => loadRuntimeConfigFile(tooLarge)).toThrow(/must not exceed/);
  });

  it("validates admission, versioned limits, and adaptive-estimation settings", () => {
    const badMode = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
    admissionMode: audit
`, "bad-mode.yaml");
    expect(() => loadRuntimeConfigFile(badMode)).toThrow(/admissionMode/);

    const badAdaptive = tempConfig(`
version: 1
upstreams:
  openai: { baseUrl: https://api.openai.com }
pools:
  - name: pool
    modelPrefixes: [gpt]
    estimatorModel: gpt-4o
    maxConcurrent: 1
    inFlightTokenBudget: 1000
    adaptiveEstimation:
      smoothing: 0
`, "bad-adaptive.yaml");
    expect(() => loadRuntimeConfigFile(badAdaptive)).toThrow(/smoothing must be > 0/);

    expect(() =>
      loadRuntimeConfig({
        OPENAI_UPSTREAM_URL: "https://api.openai.com",
        ADAPTIVE_MIN_CORRECTION: "2",
        ADAPTIVE_MAX_CORRECTION: "1",
      }),
    ).toThrow(/ADAPTIVE_MAX_CORRECTION/);
  });

  it("reports malformed YAML and missing files", () => {
    const malformed = tempConfig("version: 1\npools: [\n");
    expect(() => loadRuntimeConfigFile(malformed)).toThrow(/invalid YAML/);
    expect(() => loadRuntimeConfigFile(join(tmpdir(), "tyr-does-not-exist.yaml"))).toThrow(
      /unable to read configuration file/,
    );
  });

  it("loads file mode through TYR_CONFIG_FILE", () => {
    const path = tempConfig(validConfig);
    const config = loadRuntimeConfig({ TYR_CONFIG_FILE: path });
    expect(config.source.kind).toBe("file");
    expect(config.gateway.pools).toHaveLength(2);
  });

  it("rejects mixed file and legacy environment configuration", () => {
    const path = tempConfig(validConfig);
    expect(() =>
      loadRuntimeConfig({
        TYR_CONFIG_FILE: path,
        TOKEN_BUDGET: "1000",
        PORT: "9999",
      }),
    ).toThrow(/cannot be combined.*TOKEN_BUDGET.*PORT|cannot be combined.*PORT.*TOKEN_BUDGET/);
  });

  it("preserves legacy environment configuration when no file is selected", () => {
    const config = loadRuntimeConfig({
      OPENAI_UPSTREAM_URL: "https://api.openai.com",
      TOKEN_BUDGET: "0",
      OPAQUE_MEDIA_INPUT_TOKENS: "4096",
      ADMISSION_MODE: "observe",
      ADAPTIVE_ESTIMATION: "true",
      ADAPTIVE_SMOOTHING: "0.4",
      ADAPTIVE_MIN_SAMPLES: "2",
      ADAPTIVE_MIN_CORRECTION: "0.7",
      ADAPTIVE_MAX_CORRECTION: "1.7",
      ADAPTIVE_MAX_MODELS: "10",
      SHUTDOWN_DRAIN_TIMEOUT_MS: "25000",
    });
    expect(config.source).toEqual({ kind: "environment" });
    expect(config.gateway.shutdownDrainTimeoutMs).toBe(25_000);
    expect(config.gateway.pools[0]).toMatchObject({
      budget: 0,
      admissionMode: "observe",
      adaptiveEstimation: {
        enabled: true,
        smoothing: 0.4,
        minSamples: 2,
        minCorrection: 0.7,
        maxCorrection: 1.7,
        maxModels: 10,
      },
    });
  });

  it("loads legacy environment limit revisions and queue settings", () => {
    const config = loadRuntimeConfig({
      OPENAI_UPSTREAM_URL: "https://api.openai.com",
      MAX_CONCURRENT: "4",
      MAX_QUEUE: "8",
      QUEUE_TIMEOUT_MS: "500",
      ADMISSION_LIMITS_REVISION: "42",
    });

    expect(config.gateway.pools[0]).toMatchObject({
      maxConcurrent: 4,
      maxQueue: 8,
      queueTimeoutMs: 500,
      initialRevision: 42,
    });
  });

});
