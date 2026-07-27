import { loadRuntimeConfig } from "./config.js";
import {
  createLatchfloManagedMode,
  type LatchfloManagedMode,
} from "./latchflo.js";
import { createGateway } from "./server.js";

const runtime = loadRuntimeConfig();
const { port, gateway, source } = runtime;
let managedMode: LatchfloManagedMode | undefined;
const createdGateway = createGateway({
  ...gateway,
  ...(runtime.controlPlane === undefined
    ? {}
    : { isReady: () => managedMode?.ready() ?? false }),
});
const { server, control, shutdown } = createdGateway;

if (runtime.controlPlane !== undefined) {
  managedMode = createLatchfloManagedMode({
    config: runtime.controlPlane,
    control,
  });
}

if (source.kind === "file") {
  console.log(
    `configuration loaded source=${source.path} version=${source.version} fingerprint=sha256:${source.fingerprint} pools=${gateway.pools.map((pool) => pool.name).join(",")}`,
  );
} else {
  console.log(
    `configuration loaded source=environment pools=${gateway.pools.map((pool) => pool.name).join(",")}`,
  );
}

server.listen(port, () => {
  const routes = [
    gateway.upstreamUrl ? `/v1/messages -> ${gateway.upstreamUrl}` : undefined,
    gateway.openaiUpstreamUrl
      ? `/v1/chat/completions -> ${gateway.openaiUpstreamUrl}`
      : undefined,
  ].filter(Boolean);
  console.log(`tyr-admission-controller listening on :${port} (${routes.join(", ")})`);
  if (runtime.controlPlane !== undefined) {
    console.log(
      `Latchflo managed mode configured instance=${runtime.controlPlane.instanceId} pools=${runtime.controlPlane.pools.join(",")} controlPlane=${runtime.controlPlane.url}`,
    );
    managedMode?.start();
  }
});

let shuttingDown = false;

function handleShutdownSignal(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  managedMode?.stop();
  console.log(`${signal} received, draining in-flight requests...`);
  shutdown()
    .then((result) => {
      if (!result.drained) {
        console.warn(
          `shutdown drain deadline reached inFlight=${result.inFlight} pending=${result.pending}`,
        );
      }
      console.log("shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("error during shutdown", err);
      process.exit(1);
    });
}

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
