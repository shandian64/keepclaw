import type { RouteDecision } from "./contracts/route-decision.js";
import type { TaskEnvelope } from "./contracts/task-envelope.js";

export function decideDryRunRoute(envelope: TaskEnvelope): RouteDecision {
  const reviewOnly = envelope.eventType === "pull_request_review_comment";
  const commentOnly = envelope.eventType === "issues" || envelope.eventType === "issue_comment";

  return {
    targetHarness: "codex",
    runtime: "acp",
    sessionMode: "one-shot",
    deliveryTarget: "github",
    policyFlags: {
      dryRun: true,
      reviewOnly,
      commentOnly,
    },
    reason: `Dry-run placeholder for ${envelope.eventType}`,
  };
}
