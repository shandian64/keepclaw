import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PROVIDER = "ollama";
const DEFAULT_GUIDANCE =
  "Be concise. Do not restate the user's request, transcript history, or tool outputs unless needed. If the answer is unfinished and you still have output budget, continue directly instead of stopping early or adding filler closing lines.";

function resolveStateDir() {
  return path.resolve(
    process.env.OPENCLAW_STATE_DIR ||
      process.env.CLAWDBOT_STATE_DIR ||
      path.join(os.homedir(), ".openclaw"),
  );
}

function resolvePluginConfig(api) {
  const cfg = api.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
  return {
    provider:
      typeof cfg.provider === "string" && cfg.provider.trim()
        ? cfg.provider.trim()
        : DEFAULT_PROVIDER,
    model: typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : "",
    guidance:
      typeof cfg.guidance === "string" && cfg.guidance.trim()
        ? cfg.guidance.trim()
        : DEFAULT_GUIDANCE,
  };
}

async function readSessionMeta(agentId, sessionKey) {
  if (!agentId || !sessionKey) return null;
  const sessionsPath = path.join(resolveStateDir(), "agents", agentId, "sessions", "sessions.json");
  try {
    const raw = await readFile(sessionsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.[sessionKey] ?? null;
  } catch {
    return null;
  }
}

const plugin = {
  id: "local-output-guidance",
  name: "Local Output Guidance",
  description:
    "Adds a compact prompt hint only when the active session is using the local Ollama model.",
  register(api) {
    const pluginCfg = resolvePluginConfig(api);
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!pluginCfg.model) return;
      const sessionMeta = await readSessionMeta(ctx.agentId, ctx.sessionKey);
      if (!sessionMeta) return;
      const provider = sessionMeta.modelProvider || sessionMeta.provider;
      const model = sessionMeta.model;
      if (provider !== pluginCfg.provider || model !== pluginCfg.model) return;
      return {
        prependSystemContext: pluginCfg.guidance,
      };
    });
  },
};

export default plugin;
