export type TaskEnvelopeEventType =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment";

export type TaskEnvelopeRepo = {
  owner: string;
  name: string;
  fullName: string;
};

export type TaskEnvelopeActor = {
  login: string;
  id?: number;
};

type TaskEnvelopePayloadBase = {
  action: string;
  number: number;
  title?: string;
  body?: string;
  url?: string;
  labels: string[];
  updatedAt?: string;
};

export type TaskEnvelopePayload =
  | (TaskEnvelopePayloadBase & {
      kind: "issues";
      issueId: number;
      isPullRequest: boolean;
    })
  | (TaskEnvelopePayloadBase & {
      kind: "issue_comment";
      issueId: number;
      commentId: number;
      commentBody?: string;
      isPullRequest: boolean;
    })
  | (TaskEnvelopePayloadBase & {
      kind: "pull_request";
      pullRequestId: number;
      draft: boolean;
      baseRef?: string;
      headRef?: string;
    })
  | (TaskEnvelopePayloadBase & {
      kind: "pull_request_review_comment";
      pullRequestId: number;
      commentId: number;
      commentBody?: string;
      path?: string;
      baseRef?: string;
      headRef?: string;
    });

export type TaskEnvelope = {
  schemaVersion: 1;
  eventId: string;
  traceId: string;
  source: "github";
  eventType: TaskEnvelopeEventType;
  repo: TaskEnvelopeRepo;
  actor: TaskEnvelopeActor;
  threadKey: string;
  payload: TaskEnvelopePayload;
  receivedAt: string;
  idempotencyKey: string;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPayloadKind(value: unknown): value is TaskEnvelopePayload["kind"] {
  return (
    value === "issues" ||
    value === "issue_comment" ||
    value === "pull_request" ||
    value === "pull_request_review_comment"
  );
}

export function parseTaskEnvelope(value: unknown): TaskEnvelope | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const repo = asRecord(record.repo);
  const actor = asRecord(record.actor);
  const payload = asRecord(record.payload);
  if (!repo || !actor || !payload || !isPayloadKind(payload.kind)) {
    return null;
  }
  const eventId = asString(record.eventId);
  const traceId = asString(record.traceId);
  const eventType = asString(record.eventType);
  const threadKey = asString(record.threadKey);
  const receivedAt = asString(record.receivedAt);
  const idempotencyKey = asString(record.idempotencyKey);
  const fullName = asString(repo.fullName);
  const owner = asString(repo.owner);
  const name = asString(repo.name);
  const login = asString(actor.login);
  const action = asString(payload.action);
  const number = asNumber(payload.number);
  const labels = Array.isArray(payload.labels)
    ? payload.labels.filter((entry): entry is string => typeof entry === "string")
    : null;
  if (
    record.schemaVersion !== 1 ||
    record.source !== "github" ||
    !eventId ||
    !traceId ||
    !eventType ||
    !threadKey ||
    !receivedAt ||
    !idempotencyKey ||
    !fullName ||
    !owner ||
    !name ||
    !login ||
    !action ||
    number === undefined ||
    !labels
  ) {
    return null;
  }
  if (
    eventType !== "issues" &&
    eventType !== "issue_comment" &&
    eventType !== "pull_request" &&
    eventType !== "pull_request_review_comment"
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    eventId,
    traceId,
    source: "github",
    eventType,
    repo: {
      owner,
      name,
      fullName,
    },
    actor: {
      login,
      ...(asNumber(actor.id) !== undefined ? { id: asNumber(actor.id) } : {}),
    },
    threadKey,
    payload: payload as TaskEnvelopePayload,
    receivedAt,
    idempotencyKey,
  };
}
