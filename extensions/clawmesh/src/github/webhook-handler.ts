import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  type PluginLogger,
} from "openclaw/plugin-sdk/clawmesh";
import type { ClawMeshConfig } from "../config.js";
import { decideDryRunRoute } from "../router.js";
import {
  appendReceipt,
  appendTaskEnvelope,
  buildReceipt,
  buildRouteResultRef,
  ensureClawMeshRuntime,
  findEnvelopeByIdempotencyKey,
  type ClawMeshStore,
  withClawMeshStoreLock,
} from "../storage/store.js";
import { isSupportedGitHubEventType } from "./events.js";
import { readHeader } from "./headers.js";
import { computeEnvelopeInputDigest } from "./idempotency.js";
import { normalizeGitHubWebhook } from "./normalize.js";
import { verifyGitHubWebhookSignature } from "./signature.js";

const PRE_AUTH_MAX_BYTES = 256 * 1024;
const PRE_AUTH_TIMEOUT_MS = 5_000;

type ReadBody = (req: IncomingMessage, maxBytes: number, timeoutMs: number) => Promise<string>;

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): boolean {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return true;
}

function defaultReadBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
}

function methodNotAllowed(res: ServerResponse): boolean {
  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD, POST");
  res.end("Method Not Allowed");
  return true;
}

export function createGitHubWebhookHandler(params: {
  config: ClawMeshConfig;
  store: ClawMeshStore;
  logger: PluginLogger;
  readBody?: ReadBody;
}) {
  const readBody = params.readBody ?? defaultReadBody;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method === "GET") {
      return sendJson(res, 200, {
        plugin: "clawmesh",
        status: "ok",
        mode: "dry-run",
      });
    }
    if (req.method === "HEAD") {
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      return methodNotAllowed(res);
    }

    if (!params.config.github.webhookSecret) {
      return sendJson(res, 503, {
        error: "ClawMesh GitHub webhook secret is not configured",
      });
    }

    const eventHeader = readHeader(req.headers, "x-github-event");
    if (!eventHeader || !isSupportedGitHubEventType(eventHeader)) {
      return sendJson(res, 202, {
        ok: true,
        ignored: true,
        reason: "event_not_allowed",
      });
    }

    if (!params.config.github.allowedEvents.includes(eventHeader)) {
      return sendJson(res, 202, {
        ok: true,
        ignored: true,
        reason: "event_not_enabled",
      });
    }

    const deliveryId = readHeader(req.headers, "x-github-delivery");
    if (!deliveryId) {
      return sendJson(res, 400, {
        error: "Missing X-GitHub-Delivery header",
      });
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req, PRE_AUTH_MAX_BYTES, PRE_AUTH_TIMEOUT_MS);
    } catch (error) {
      if (isRequestBodyLimitError(error)) {
        return sendJson(res, error.statusCode, {
          error: requestBodyErrorToText(error.code),
        });
      }
      params.logger.error(
        `[clawmesh] failed to read GitHub webhook body: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return sendJson(res, 400, {
        error: "Bad Request",
      });
    }

    const signatureResult = verifyGitHubWebhookSignature({
      body: rawBody,
      secret: params.config.github.webhookSecret,
      signature: readHeader(req.headers, "x-hub-signature-256"),
    });
    if (!signatureResult.ok) {
      return sendJson(res, 401, {
        error: signatureResult.reason,
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      return sendJson(res, 400, {
        error: "Invalid JSON payload",
      });
    }

    let envelope;
    try {
      envelope = normalizeGitHubWebhook({
        deliveryId,
        eventType: eventHeader,
        payload: parsedBody,
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await ensureClawMeshRuntime(params.store);

    return await withClawMeshStoreLock(params.store, async () => {
      const existing = await findEnvelopeByIdempotencyKey(params.store, envelope.idempotencyKey);
      const inputDigest = computeEnvelopeInputDigest(envelope);
      if (existing) {
        await appendReceipt(
          params.store,
          buildReceipt({
            envelope,
            action: "ingest.duplicate_suppressed",
            status: "duplicate",
            inputDigest,
            resultRef: existing.eventId,
          }),
        );
        return sendJson(res, 200, {
          ok: true,
          status: "duplicate",
          mode: "dry-run",
          duplicate: true,
          eventId: existing.eventId,
          traceId: existing.traceId,
        });
      }

      const route = decideDryRunRoute(envelope);
      await appendTaskEnvelope(params.store, envelope);
      await appendReceipt(
        params.store,
        buildReceipt({
          envelope,
          action: "ingest.accepted",
          status: "ok",
          inputDigest,
          resultRef: envelope.idempotencyKey,
        }),
      );
      await appendReceipt(
        params.store,
        buildReceipt({
          envelope,
          action: "route.dry_run",
          status: "dry_run",
          inputDigest,
          targetAgent: route.targetHarness,
          resultRef: buildRouteResultRef(route),
        }),
      );

      return sendJson(res, 202, {
        ok: true,
        status: "accepted",
        mode: "dry-run",
        duplicate: false,
        eventId: envelope.eventId,
        traceId: envelope.traceId,
        route,
      });
    });
  };
}
