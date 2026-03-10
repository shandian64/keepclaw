import type {
  TaskEnvelope,
  TaskEnvelopeActor,
  TaskEnvelopePayload,
} from "../contracts/task-envelope.js";
import type { TaskEnvelopeEventType, TaskEnvelopeRepo } from "../contracts/task-envelope.js";
import { computeTaskIdempotencyKey, computeTaskTraceId } from "./idempotency.js";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).name : "",
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeRepo(payload: Record<string, unknown>): TaskEnvelopeRepo {
  const repository = asRecord(payload.repository, "repository");
  const fullName = requireString(repository.full_name, "repository.full_name");
  const [owner, name] = fullName.split("/", 2);
  if (!owner || !name) {
    throw new Error("Invalid repository.full_name");
  }
  return { owner, name, fullName };
}

function normalizeActor(payload: Record<string, unknown>): TaskEnvelopeActor {
  const sender = asRecord(payload.sender, "sender");
  const login = requireString(sender.login, "sender.login");
  const id = typeof sender.id === "number" && Number.isFinite(sender.id) ? sender.id : undefined;
  return { login, ...(id !== undefined ? { id } : {}) };
}

function normalizeIssuesPayload(payload: Record<string, unknown>): TaskEnvelopePayload {
  const issue = asRecord(payload.issue, "issue");
  return {
    kind: "issues",
    action: requireString(payload.action, "action"),
    issueId: requireNumber(issue.id, "issue.id"),
    number: requireNumber(issue.number, "issue.number"),
    title: optionalString(issue.title),
    body: optionalString(issue.body),
    url: optionalString(issue.html_url),
    labels: readLabels(issue.labels),
    updatedAt: optionalString(issue.updated_at) ?? optionalString(issue.created_at),
    isPullRequest: Boolean(issue.pull_request && typeof issue.pull_request === "object"),
  };
}

function normalizeIssueCommentPayload(payload: Record<string, unknown>): TaskEnvelopePayload {
  const issue = asRecord(payload.issue, "issue");
  const comment = asRecord(payload.comment, "comment");
  return {
    kind: "issue_comment",
    action: requireString(payload.action, "action"),
    issueId: requireNumber(issue.id, "issue.id"),
    commentId: requireNumber(comment.id, "comment.id"),
    number: requireNumber(issue.number, "issue.number"),
    title: optionalString(issue.title),
    body: optionalString(issue.body),
    url: optionalString(issue.html_url),
    labels: readLabels(issue.labels),
    updatedAt: optionalString(comment.updated_at) ?? optionalString(comment.created_at),
    commentBody: optionalString(comment.body),
    isPullRequest: Boolean(issue.pull_request && typeof issue.pull_request === "object"),
  };
}

function normalizePullRequestPayload(payload: Record<string, unknown>): TaskEnvelopePayload {
  const pullRequest = asRecord(payload.pull_request, "pull_request");
  const head = asRecord(pullRequest.head, "pull_request.head");
  const base = asRecord(pullRequest.base, "pull_request.base");
  return {
    kind: "pull_request",
    action: requireString(payload.action, "action"),
    pullRequestId: requireNumber(pullRequest.id, "pull_request.id"),
    number: requireNumber(pullRequest.number, "pull_request.number"),
    title: optionalString(pullRequest.title),
    body: optionalString(pullRequest.body),
    url: optionalString(pullRequest.html_url),
    labels: readLabels(pullRequest.labels),
    updatedAt: optionalString(pullRequest.updated_at) ?? optionalString(pullRequest.created_at),
    draft: Boolean(pullRequest.draft),
    headRef: optionalString(head.ref),
    baseRef: optionalString(base.ref),
  };
}

function normalizePullRequestReviewCommentPayload(
  payload: Record<string, unknown>,
): TaskEnvelopePayload {
  const pullRequest = asRecord(payload.pull_request, "pull_request");
  const comment = asRecord(payload.comment, "comment");
  const head = asRecord(pullRequest.head, "pull_request.head");
  const base = asRecord(pullRequest.base, "pull_request.base");
  return {
    kind: "pull_request_review_comment",
    action: requireString(payload.action, "action"),
    pullRequestId: requireNumber(pullRequest.id, "pull_request.id"),
    commentId: requireNumber(comment.id, "comment.id"),
    number: requireNumber(pullRequest.number, "pull_request.number"),
    title: optionalString(pullRequest.title),
    body: optionalString(pullRequest.body),
    url: optionalString(comment.html_url) ?? optionalString(pullRequest.html_url),
    labels: readLabels(pullRequest.labels),
    updatedAt: optionalString(comment.updated_at) ?? optionalString(comment.created_at),
    commentBody: optionalString(comment.body),
    path: optionalString(comment.path),
    headRef: optionalString(head.ref),
    baseRef: optionalString(base.ref),
  };
}

function normalizePayload(
  eventType: TaskEnvelopeEventType,
  payload: Record<string, unknown>,
): TaskEnvelopePayload {
  switch (eventType) {
    case "issues":
      return normalizeIssuesPayload(payload);
    case "issue_comment":
      return normalizeIssueCommentPayload(payload);
    case "pull_request":
      return normalizePullRequestPayload(payload);
    case "pull_request_review_comment":
      return normalizePullRequestReviewCommentPayload(payload);
  }
}

function buildThreadKey(repoFullName: string, payload: TaskEnvelopePayload): string {
  switch (payload.kind) {
    case "issues":
      return `github:${repoFullName}:${payload.isPullRequest ? "pr" : "issue"}:${payload.number}`;
    case "issue_comment":
      return `github:${repoFullName}:${payload.isPullRequest ? "pr" : "issue"}:${payload.number}`;
    case "pull_request":
      return `github:${repoFullName}:pr:${payload.number}`;
    case "pull_request_review_comment":
      return `github:${repoFullName}:pr:${payload.number}`;
  }
}

export function normalizeGitHubWebhook(params: {
  deliveryId: string;
  eventType: TaskEnvelopeEventType;
  payload: unknown;
  receivedAt?: string;
}): TaskEnvelope {
  const payload = asRecord(params.payload, "payload");
  const repo = normalizeRepo(payload);
  const actor = normalizeActor(payload);
  const normalizedPayload = normalizePayload(params.eventType, payload);
  const threadKey = buildThreadKey(repo.fullName, normalizedPayload);
  const idempotencyKey = computeTaskIdempotencyKey({
    deliveryId: params.deliveryId,
    repoFullName: repo.fullName,
    payload: normalizedPayload,
  });

  return {
    schemaVersion: 1,
    eventId: params.deliveryId,
    traceId: computeTaskTraceId(threadKey),
    source: "github",
    eventType: params.eventType,
    repo,
    actor,
    threadKey,
    payload: normalizedPayload,
    receivedAt: params.receivedAt ?? new Date().toISOString(),
    idempotencyKey,
  };
}
