import type { ClawMeshRuntimePaths } from "../runtime-paths.js";
import {
  ensureClawMeshRuntime,
  loadReceipts,
  loadTaskEnvelopes,
  type ClawMeshStore,
} from "../storage/store.js";

export function buildClawMeshStatusText(params: {
  runtimePaths: ClawMeshRuntimePaths;
  envelopeCount: number;
  receiptCount: number;
  lastEventId?: string;
  lastReceiptAction?: string;
}): string {
  return [
    "ClawMesh dry-run status",
    `- runtimeRoot: ${params.runtimePaths.rootDir}`,
    `- envelopes: ${params.envelopeCount}`,
    `- receipts: ${params.receiptCount}`,
    `- lastEvent: ${params.lastEventId ?? "(none)"}`,
    `- lastReceipt: ${params.lastReceiptAction ?? "(none)"}`,
  ].join("\n");
}

export function createClawMeshStatusCommand(params: {
  store: ClawMeshStore;
  runtimePaths: ClawMeshRuntimePaths;
}) {
  return {
    name: "clawmesh-status",
    description: "Show ClawMesh dry-run runtime status.",
    handler: async () => {
      await ensureClawMeshRuntime(params.store);
      const envelopes = await loadTaskEnvelopes(params.store);
      const receipts = await loadReceipts(params.store);
      return {
        text: buildClawMeshStatusText({
          runtimePaths: params.runtimePaths,
          envelopeCount: envelopes.length,
          receiptCount: receipts.length,
          lastEventId: envelopes.at(-1)?.eventId,
          lastReceiptAction: receipts.at(-1)?.action,
        }),
      };
    },
  };
}
