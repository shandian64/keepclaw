import type { TaskEnvelopeEventType } from "./contracts/task-envelope.js";
import { SUPPORTED_GITHUB_EVENT_TYPES, isSupportedGitHubEventType } from "./github/events.js";

export const DEFAULT_GITHUB_WEBHOOK_PATH = "/plugins/clawmesh/github/webhook";

export type ClawMeshConfig = {
  github: {
    webhookPath: string;
    webhookSecret: string;
    allowedEvents: TaskEnvelopeEventType[];
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeWebhookPath(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return DEFAULT_GITHUB_WEBHOOK_PATH;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function normalizeAllowedEvents(value: unknown): TaskEnvelopeEventType[] {
  if (!Array.isArray(value)) {
    return [...SUPPORTED_GITHUB_EVENT_TYPES];
  }
  const allowed = value.filter((entry): entry is TaskEnvelopeEventType =>
    typeof entry === "string" ? isSupportedGitHubEventType(entry) : false,
  );
  return allowed.length > 0 ? Array.from(new Set(allowed)) : [...SUPPORTED_GITHUB_EVENT_TYPES];
}

export function resolveClawMeshConfig(pluginConfig?: Record<string, unknown>): ClawMeshConfig {
  const root = asRecord(pluginConfig) ?? {};
  const github = asRecord(root.github) ?? {};
  const webhookSecret = typeof github.webhookSecret === "string" ? github.webhookSecret.trim() : "";

  return {
    github: {
      webhookPath: normalizeWebhookPath(github.webhookPath),
      webhookSecret,
      allowedEvents: normalizeAllowedEvents(github.allowedEvents),
    },
  };
}

export const clawMeshConfigSchema = {
  parse(value: unknown): ClawMeshConfig {
    const root = asRecord(value) ?? {};
    return resolveClawMeshConfig(root);
  },
  uiHints: {
    "github.webhookPath": {
      label: "GitHub Webhook Path",
      help: "Public plugin-owned path for GitHub webhook delivery.",
    },
    "github.webhookSecret": {
      label: "GitHub Webhook Secret",
      help: "Shared secret used to verify X-Hub-Signature-256.",
      sensitive: true,
    },
    "github.allowedEvents": {
      label: "GitHub Allowed Events",
      help: "Small allowlist of GitHub event types accepted by ClawMesh.",
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      github: {
        type: "object",
        additionalProperties: false,
        properties: {
          webhookPath: {
            type: "string",
            default: DEFAULT_GITHUB_WEBHOOK_PATH,
          },
          webhookSecret: {
            type: "string",
            minLength: 1,
          },
          allowedEvents: {
            type: "array",
            items: {
              type: "string",
              enum: [...SUPPORTED_GITHUB_EVENT_TYPES],
            },
          },
        },
      },
    },
  },
};
