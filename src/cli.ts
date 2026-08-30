#!/usr/bin/env node

import { loadRuntimeConfigFile } from "./config.js";

function usage(): string {
  return [
    "Usage:",
    "  tyr validate --config <path>",
    "",
    "Validates a Tyr YAML configuration without starting the server.",
  ].join("\n");
}

function configPathFromArgs(args: string[]): string {
  if (args[0] !== "validate") {
    throw new Error(usage());
  }

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a file path\n\n${usage()}`);
      }
      return value;
    }
    if (arg?.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.length === 0) {
        throw new Error(`--config requires a file path\n\n${usage()}`);
      }
      return value;
    }
  }

  throw new Error(`missing --config <path>\n\n${usage()}`);
}

try {
  const configPath = configPathFromArgs(process.argv.slice(2));
  const runtime = loadRuntimeConfigFile(configPath);
  const routes = [
    runtime.gateway.upstreamUrl !== undefined ? "/v1/messages" : undefined,
    runtime.gateway.openaiUpstreamUrl !== undefined
      ? "/v1/chat/completions"
      : undefined,
    runtime.gateway.openaiUpstreamUrl !== undefined ? "/v1/responses" : undefined,
  ].filter((route): route is string => route !== undefined);

  console.log("configuration valid");
  console.log(`source: ${runtime.source.kind === "file" ? runtime.source.path : "environment"}`);
  if (runtime.source.kind === "file") {
    console.log(`version: ${runtime.source.version}`);
    console.log(`fingerprint: sha256:${runtime.source.fingerprint}`);
  }
  console.log(`port: ${runtime.port}`);
  console.log(`pools: ${runtime.gateway.pools.map((pool) => pool.name).join(", ")}`);
  console.log(`routes: ${routes.join(", ")}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`configuration invalid\n${detail}`);
  process.exitCode = 1;
}
