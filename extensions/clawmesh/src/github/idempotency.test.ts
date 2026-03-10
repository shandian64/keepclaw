import { describe, expect, it } from "vitest";
import { computeTaskIdempotencyKey } from "./idempotency.js";

describe("ClawMesh idempotency keying", () => {
  it("changes across distinct delivery ids for the same payload identity", () => {
    const payload = {
      kind: "issues",
      action: "edited",
      issueId: 501,
      number: 17,
      labels: [],
      isPullRequest: false,
      updatedAt: "2026-03-11T00:00:00Z",
    } as const;

    const first = computeTaskIdempotencyKey({
      deliveryId: "delivery-1",
      repoFullName: "keepclaw/demo",
      payload,
    });
    const second = computeTaskIdempotencyKey({
      deliveryId: "delivery-2",
      repoFullName: "keepclaw/demo",
      payload,
    });

    expect(first).not.toBe(second);
  });
});
