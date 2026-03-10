import crypto from "node:crypto";

export function signGitHubWebhook(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyGitHubWebhookSignature(params: {
  body: string;
  secret: string;
  signature: string | undefined;
}): { ok: true } | { ok: false; reason: string } {
  const secret = params.secret.trim();
  if (!secret) {
    return { ok: false, reason: "Missing webhook secret" };
  }
  const signature = params.signature?.trim();
  if (!signature) {
    return { ok: false, reason: "Missing X-Hub-Signature-256 header" };
  }
  if (!signature.startsWith("sha256=")) {
    return { ok: false, reason: "Unsupported signature format" };
  }
  const expected = signGitHubWebhook(params.body, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, reason: "Invalid signature" };
  }
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, reason: "Invalid signature" };
  }
  return { ok: true };
}
