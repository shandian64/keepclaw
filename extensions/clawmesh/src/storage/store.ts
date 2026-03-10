import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/clawmesh";
import type { Receipt } from "../contracts/receipt.js";
import { parseReceipt } from "../contracts/receipt.js";
import type { RouteDecision } from "../contracts/route-decision.js";
import type { TaskEnvelope } from "../contracts/task-envelope.js";
import { parseTaskEnvelope } from "../contracts/task-envelope.js";
import type { ClawMeshRuntimePaths } from "../runtime-paths.js";
import { appendJsonlRecord, loadJsonlRecords } from "./jsonl.js";

export type ClawMeshStore = {
  paths: ClawMeshRuntimePaths;
  queue: KeyedAsyncQueue;
};

export function createClawMeshStore(paths: ClawMeshRuntimePaths): ClawMeshStore {
  return {
    paths,
    queue: new KeyedAsyncQueue(),
  };
}

export async function ensureClawMeshRuntime(store: ClawMeshStore): Promise<void> {
  await fs.mkdir(store.paths.rootDir, { recursive: true, mode: 0o700 });
  await fs.chmod(store.paths.rootDir, 0o700).catch(() => undefined);
}

export async function withClawMeshStoreLock<T>(
  store: ClawMeshStore,
  task: () => Promise<T>,
): Promise<T> {
  return await store.queue.enqueue(store.paths.rootDir, task);
}

export async function appendTaskEnvelope(
  store: ClawMeshStore,
  envelope: TaskEnvelope,
): Promise<void> {
  await appendJsonlRecord({
    queue: store.queue,
    filePath: store.paths.envelopesPath,
    record: envelope,
  });
}

export async function appendReceipt(store: ClawMeshStore, receipt: Receipt): Promise<void> {
  await appendJsonlRecord({
    queue: store.queue,
    filePath: store.paths.receiptsPath,
    record: receipt,
  });
}

export async function loadTaskEnvelopes(store: ClawMeshStore): Promise<TaskEnvelope[]> {
  return await loadJsonlRecords(store.paths.envelopesPath, parseTaskEnvelope);
}

export async function loadReceipts(store: ClawMeshStore): Promise<Receipt[]> {
  return await loadJsonlRecords(store.paths.receiptsPath, parseReceipt);
}

export async function findEnvelopeByIdempotencyKey(
  store: ClawMeshStore,
  idempotencyKey: string,
): Promise<TaskEnvelope | null> {
  const envelopes = await loadTaskEnvelopes(store);
  return envelopes.find((entry) => entry.idempotencyKey === idempotencyKey) ?? null;
}

export function buildReceipt(params: {
  envelope: TaskEnvelope;
  action: Receipt["action"];
  status: Receipt["status"];
  inputDigest: string;
  targetAgent?: string | null;
  sessionKey?: string | null;
  resultRef?: string | null;
  error?: string | null;
}): Receipt {
  return {
    schemaVersion: 1,
    receiptId: randomUUID(),
    traceId: params.envelope.traceId,
    eventId: params.envelope.eventId,
    action: params.action,
    targetAgent: params.targetAgent ?? null,
    sessionKey: params.sessionKey ?? null,
    inputDigest: params.inputDigest,
    status: params.status,
    createdAt: new Date().toISOString(),
    resultRef: params.resultRef ?? null,
    error: params.error ?? null,
  };
}

export function buildRouteResultRef(route: RouteDecision): string {
  return `${route.runtime}:${route.targetHarness}:${route.sessionMode}:dry-run`;
}
