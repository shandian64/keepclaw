import path from "node:path";

export type ClawMeshRuntimePaths = {
  rootDir: string;
  envelopesPath: string;
  receiptsPath: string;
};

export function resolveClawMeshRuntimePaths(stateDir: string): ClawMeshRuntimePaths {
  const rootDir = path.join(stateDir, "runtime", "clawmesh");
  return {
    rootDir,
    envelopesPath: path.join(rootDir, "envelopes.jsonl"),
    receiptsPath: path.join(rootDir, "receipts.jsonl"),
  };
}
