import type { TaskEnvelopeEventType } from "../contracts/task-envelope.js";

export const SUPPORTED_GITHUB_EVENT_TYPES = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review_comment",
] as const satisfies readonly TaskEnvelopeEventType[];

export function isSupportedGitHubEventType(value: string): value is TaskEnvelopeEventType {
  return SUPPORTED_GITHUB_EVENT_TYPES.includes(value as TaskEnvelopeEventType);
}
