import { ensureClawMeshRuntime, loadTaskEnvelopes, type ClawMeshStore } from "../storage/store.js";

function parseReplayArgs(input: string | undefined): { dryRun: boolean; targetId?: string } {
  const tokens = (input ?? "").trim().split(/\s+/).filter(Boolean);
  const dryRun = tokens.includes("--dry-run");
  const targetId = tokens.find((token) => !token.startsWith("--"));
  return { dryRun, ...(targetId ? { targetId } : {}) };
}

export function createClawMeshReplayCommand(params: { store: ClawMeshStore }) {
  return {
    name: "clawmesh-replay",
    description: "Replay a recorded ClawMesh event in dry-run mode only.",
    acceptsArgs: true,
    handler: async (ctx: { args?: string }) => {
      const parsed = parseReplayArgs(ctx.args);
      if (!parsed.dryRun) {
        return {
          text:
            "ClawMesh replay is dry-run only in PR-1.\n" +
            "Usage: /clawmesh-replay --dry-run [eventId]",
        };
      }

      await ensureClawMeshRuntime(params.store);
      const envelopes = await loadTaskEnvelopes(params.store);
      if (envelopes.length === 0) {
        return {
          text: "ClawMesh replay (dry-run)\nNo recorded events available.",
        };
      }

      const selected =
        envelopes.find(
          (entry) => entry.eventId === parsed.targetId || entry.traceId === parsed.targetId,
        ) ?? envelopes.at(-1);

      return {
        text: [
          "ClawMesh replay (dry-run)",
          `- eventId: ${selected?.eventId ?? "(none)"}`,
          `- traceId: ${selected?.traceId ?? "(none)"}`,
          "- placeholder: ACP execution is not implemented in PR-1.",
        ].join("\n"),
      };
    },
  };
}
