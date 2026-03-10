import type { OpenClawPluginApi } from "openclaw/plugin-sdk/clawmesh";
import { createClawMeshReplayCommand } from "./src/commands/replay.js";
import { createClawMeshStatusCommand } from "./src/commands/status.js";
import { clawMeshConfigSchema, resolveClawMeshConfig } from "./src/config.js";
import { createGitHubWebhookHandler } from "./src/github/webhook-handler.js";
import { resolveClawMeshRuntimePaths } from "./src/runtime-paths.js";
import { createClawMeshBootstrapService } from "./src/service.js";
import { createClawMeshStore } from "./src/storage/store.js";

const plugin = {
  id: "clawmesh",
  name: "ClawMesh",
  description: "GitHub dry-run orchestration scaffold with append-only receipts.",
  configSchema: clawMeshConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolveClawMeshConfig(api.pluginConfig);
    const runtimePaths = resolveClawMeshRuntimePaths(api.runtime.state.resolveStateDir());
    const store = createClawMeshStore(runtimePaths);

    api.registerService(createClawMeshBootstrapService({ store, logger: api.logger }));
    api.registerHttpRoute({
      path: config.github.webhookPath,
      auth: "plugin",
      match: "exact",
      handler: createGitHubWebhookHandler({
        config,
        store,
        logger: api.logger,
      }),
    });
    api.registerCommand(createClawMeshStatusCommand({ store, runtimePaths }));
    api.registerCommand(createClawMeshReplayCommand({ store }));
  },
};

export default plugin;
