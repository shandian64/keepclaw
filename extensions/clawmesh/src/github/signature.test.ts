import { describe, expect, it } from "vitest";
import { signGitHubWebhook, verifyGitHubWebhookSignature } from "./signature.js";

describe("GitHub webhook signature verification", () => {
  it("accepts a valid X-Hub-Signature-256 value", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "clawmesh-secret";
    const signature = signGitHubWebhook(body, secret);

    expect(
      verifyGitHubWebhookSignature({
        body,
        secret,
        signature,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects an invalid signature", () => {
    const result = verifyGitHubWebhookSignature({
      body: "{}",
      secret: "clawmesh-secret",
      signature: "sha256=deadbeef",
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "Invalid signature" });
  });
});
