import type { TaskEnvelope, TaskEnvelopePayload } from "../contracts/task-envelope.js";
import { sha256Hex } from "../hash.js";

function payloadIdentity(repoFullName: string, payload: TaskEnvelopePayload): string {
  switch (payload.kind) {
    case "issues":
      return `${repoFullName}:${payload.kind}:${payload.action}:${payload.issueId}:${payload.updatedAt ?? ""}`;
    case "issue_comment":
      return `${repoFullName}:${payload.kind}:${payload.action}:${payload.commentId}:${payload.updatedAt ?? ""}`;
    case "pull_request":
      return `${repoFullName}:${payload.kind}:${payload.action}:${payload.pullRequestId}:${payload.updatedAt ?? ""}`;
    case "pull_request_review_comment":
      return `${repoFullName}:${payload.kind}:${payload.action}:${payload.commentId}:${payload.updatedAt ?? ""}`;
  }
}

export function computeTaskTraceId(threadKey: string): string {
  return sha256Hex(`trace:${threadKey}`);
}

export function computeTaskIdempotencyKey(params: {
  deliveryId: string;
  repoFullName: string;
  payload: TaskEnvelopePayload;
}): string {
  return sha256Hex(`${params.deliveryId}:${payloadIdentity(params.repoFullName, params.payload)}`);
}

export function computeEnvelopeInputDigest(envelope: TaskEnvelope): string {
  return sha256Hex(JSON.stringify(envelope.payload));
}
