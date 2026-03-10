export type RouteDecision = {
  targetHarness: "codex";
  runtime: "acp";
  sessionMode: "one-shot";
  deliveryTarget: "github";
  policyFlags: {
    dryRun: true;
    reviewOnly: boolean;
    commentOnly: boolean;
  };
  reason: string;
};
