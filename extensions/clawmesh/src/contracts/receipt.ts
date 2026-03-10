export type ReceiptAction = "ingest.accepted" | "ingest.duplicate_suppressed" | "route.dry_run";

export type ReceiptStatus = "ok" | "duplicate" | "dry_run" | "error";

export type Receipt = {
  schemaVersion: 1;
  receiptId: string;
  traceId: string;
  eventId: string;
  action: ReceiptAction;
  targetAgent: string | null;
  sessionKey: string | null;
  inputDigest: string;
  status: ReceiptStatus;
  createdAt: string;
  resultRef: string | null;
  error: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseReceipt(value: unknown): Receipt | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const receiptId = asString(record.receiptId);
  const traceId = asString(record.traceId);
  const eventId = asString(record.eventId);
  const action = asString(record.action);
  const inputDigest = asString(record.inputDigest);
  const status = asString(record.status);
  const createdAt = asString(record.createdAt);
  if (
    record.schemaVersion !== 1 ||
    !receiptId ||
    !traceId ||
    !eventId ||
    !action ||
    !inputDigest ||
    !status ||
    !createdAt
  ) {
    return null;
  }
  if (
    action !== "ingest.accepted" &&
    action !== "ingest.duplicate_suppressed" &&
    action !== "route.dry_run"
  ) {
    return null;
  }
  if (status !== "ok" && status !== "duplicate" && status !== "dry_run" && status !== "error") {
    return null;
  }
  return {
    schemaVersion: 1,
    receiptId,
    traceId,
    eventId,
    action,
    targetAgent: typeof record.targetAgent === "string" ? record.targetAgent : null,
    sessionKey: typeof record.sessionKey === "string" ? record.sessionKey : null,
    inputDigest,
    status,
    createdAt,
    resultRef: typeof record.resultRef === "string" ? record.resultRef : null,
    error: typeof record.error === "string" ? record.error : null,
  };
}
