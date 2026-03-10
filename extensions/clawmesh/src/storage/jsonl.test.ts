import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/clawmesh";
import { describe, expect, it } from "vitest";
import { appendJsonlRecord, loadJsonlRecords } from "./jsonl.js";

describe("ClawMesh JSONL helpers", () => {
  it("appends and reloads JSONL records", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmesh-jsonl-"));
    const filePath = path.join(tmpDir, "records.jsonl");
    const queue = new KeyedAsyncQueue();

    await appendJsonlRecord({
      queue,
      filePath,
      record: { id: "one", status: "ok" },
    });
    await appendJsonlRecord({
      queue,
      filePath,
      record: { id: "two", status: "dry_run" },
    });

    const records = await loadJsonlRecords(filePath, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : null;
      const status = typeof record.status === "string" ? record.status : null;
      return id && status ? { id, status } : null;
    });

    expect(records).toEqual([
      { id: "one", status: "ok" },
      { id: "two", status: "dry_run" },
    ]);
  });
});
