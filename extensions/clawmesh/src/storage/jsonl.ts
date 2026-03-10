import fs from "node:fs/promises";
import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/clawmesh";

export type JsonlParser<T> = (value: unknown) => T | null;

async function ensureRuntimePath(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700).catch(() => undefined);
}

export async function appendJsonlRecord<T>(params: {
  queue: KeyedAsyncQueue;
  filePath: string;
  record: T;
}): Promise<void> {
  const resolved = path.resolve(params.filePath);
  await params.queue.enqueue(resolved, async () => {
    await ensureRuntimePath(resolved);
    await fs.appendFile(resolved, `${JSON.stringify(params.record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.chmod(resolved, 0o600).catch(() => undefined);
  });
}

export async function loadJsonlRecords<T>(filePath: string, parse: JsonlParser<T>): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const records: T[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = parse(JSON.parse(trimmed) as unknown);
        if (parsed) {
          records.push(parsed);
        }
      } catch {
        // Skip invalid JSONL lines so append-only logs remain readable.
      }
    }
    return records;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
