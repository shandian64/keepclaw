import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClawMeshConfig } from "../config.js";
import { resolveClawMeshRuntimePaths } from "../runtime-paths.js";
import { loadReceipts, loadTaskEnvelopes, createClawMeshStore } from "../storage/store.js";
import { signGitHubWebhook } from "./signature.js";
import { createGitHubWebhookHandler } from "./webhook-handler.js";

function createMockResponse() {
  const headers: Record<string, string> = {};
  const resObj = {
    statusCode: 0,
    headersSent: false,
    body: "",
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
    },
    end: (body?: string) => {
      resObj.headersSent = true;
      resObj.body = body ?? "";
      return resObj;
    },
  };
  return {
    headers,
    res: resObj as unknown as ServerResponse & { body: string },
  };
}

function buildIssuesPayload() {
  return {
    action: "opened",
    repository: {
      full_name: "keepclaw/demo",
    },
    sender: {
      login: "octocat",
      id: 42,
    },
    issue: {
      id: 501,
      number: 17,
      title: "Dry run me",
      body: "Please route this to ClawMesh",
      html_url: "https://github.com/keepclaw/demo/issues/17",
      updated_at: "2026-03-11T00:00:00Z",
      labels: [{ name: "codex" }],
    },
  };
}

describe("ClawMesh GitHub webhook handler", () => {
  it("suppresses duplicate deliveries by idempotency key", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawmesh-webhook-"));
    const runtimePaths = resolveClawMeshRuntimePaths(stateDir);
    const store = createClawMeshStore(runtimePaths);
    const payload = JSON.stringify(buildIssuesPayload());
    const secret = "clawmesh-secret";
    const handler = createGitHubWebhookHandler({
      config: resolveClawMeshConfig({
        github: {
          webhookSecret: secret,
        },
      }),
      store,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      readBody: async () => payload,
    });

    const req = {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signGitHubWebhook(payload, secret),
      },
    } as unknown as IncomingMessage;

    const first = createMockResponse();
    await handler(req, first.res);
    const second = createMockResponse();
    await handler(req, second.res);

    const envelopes = await loadTaskEnvelopes(store);
    const receipts = await loadReceipts(store);

    expect(first.res.statusCode).toBe(202);
    expect(second.res.statusCode).toBe(200);
    expect(envelopes).toHaveLength(1);
    expect(receipts).toHaveLength(3);
    expect(receipts.at(-1)?.action).toBe("ingest.duplicate_suppressed");
  });
});
