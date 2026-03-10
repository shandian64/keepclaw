import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClawMeshRuntimePaths } from "../runtime-paths.js";
import { createClawMeshStore } from "../storage/store.js";
import { createClawMeshStatusCommand } from "./status.js";

describe("ClawMesh status command", () => {
  it("reports empty dry-run state", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmesh-status-"));
    const runtimePaths = resolveClawMeshRuntimePaths(stateDir);
    const store = createClawMeshStore(runtimePaths);
    const command = createClawMeshStatusCommand({
      store,
      runtimePaths,
    });

    const result = await command.handler();

    expect(result.text).toContain("ClawMesh dry-run status");
    expect(result.text).toContain("- envelopes: 0");
    expect(result.text).toContain("- receipts: 0");
    expect(result.text).toContain("- lastEvent: (none)");
    expect(result.text).toContain("- lastReceipt: (none)");
  });
});
