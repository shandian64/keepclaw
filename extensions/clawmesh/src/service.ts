import type { PluginLogger } from "openclaw/plugin-sdk/clawmesh";
import { ensureClawMeshRuntime, type ClawMeshStore } from "./storage/store.js";

export function createClawMeshBootstrapService(params: {
  store: ClawMeshStore;
  logger: PluginLogger;
}) {
  return {
    id: "clawmesh-bootstrap",
    start: async () => {
      await ensureClawMeshRuntime(params.store);
      params.logger.info(`[clawmesh] runtime ready at ${params.store.paths.rootDir}`);
    },
  };
}
