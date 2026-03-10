import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const STATE_DIR = path.resolve(
  process.env.OPENCLAW_STATE_DIR ||
    process.env.CLAWDBOT_STATE_DIR ||
    path.join(os.homedir(), ".openclaw"),
);
const OPENCLAW_BIN = path.join(STATE_DIR, "bin", "openclaw");
const HELPER_PATH = path.join(REPO_ROOT, "skills", "codex-sa-control", "scripts", "codex_sa.py");
const JOBS_INDEX_PATH = path.join(STATE_DIR, "runtime", "codex-sa-control", "jobs", "index.json");
const SESSION_ROOT = path.join(STATE_DIR, "agents");
const TARGETS = new Set(["sa1", "sa2", "sa3", "sa4", "sa5"]);
const STATUSES = new Set(["queued", "running", "completed", "failed", "canceled"]);
const SOURCES = new Set(["helper", "external"]);
const MANAGEABILITY = new Set(["full", "cancel_only", "observe_only"]);
const NOTIFY_POLICIES = new Set(["telegram-last", "last-chat", "none"]);
const NOTIFIABLE = new Set(["completed", "failed", "canceled"]);
const DEFAULT_POLL_MS = 4000;
const MAX_RESULT_PREVIEW = 1200;
const MAX_LIST_RESULTS = 12;
const RETRY_INTERVAL_MS = 30000;

let watcherTimer = null;
let watcherBusy = false;

function safeTrim(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function compactText(value, limit = 280) {
  const text = safeTrim(value).replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function splitArgs(raw) {
  return safeTrim(raw).split(/\s+/).filter(Boolean);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    if (options.input !== undefined && options.input !== null) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function runHelperJson(args, input) {
  const result = await runProcess("python3", [HELPER_PATH, ...args], input ? { input } : {});
  const stdout = safeTrim(result.stdout);
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    throw new Error(
      compactText(result.stderr || result.stdout || "helper returned non-JSON output", 400),
    );
  }
  if (result.exitCode !== 0 && parsed.ok !== false) {
    parsed.ok = false;
    parsed.error = parsed.error || compactText(result.stderr || "helper failed", 400);
  }
  return parsed;
}

function buildHiddenArgs(context, route) {
  const args = [];
  const push = (flag, value) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text) return;
    args.push(flag, text);
  };

  push("--agent-id", context?.agentId);
  push("--session-key", context?.sessionKey);
  push("--origin-session-id", context?.sessionId);
  push("--message-channel", context?.messageChannel);
  push("--agent-account-id", context?.agentAccountId);
  push("--requester-sender-id", context?.requesterSenderId);
  push("--delivery-channel", route?.channel);
  push("--delivery-target", route?.target);
  push("--delivery-account", route?.accountId);
  push("--delivery-thread-id", route?.threadId);
  return args;
}

async function readSessionEntry(agentId, sessionKey) {
  if (!safeTrim(agentId) || !safeTrim(sessionKey)) return null;
  const sessionsPath = path.join(SESSION_ROOT, agentId, "sessions", "sessions.json");
  const store = await readJson(sessionsPath, {});
  const entry = store?.[sessionKey];
  return entry && typeof entry === "object" ? entry : null;
}

async function resolveRouteFromSession(agentId, sessionKey) {
  const entry = await readSessionEntry(agentId, sessionKey);
  if (!entry) return null;
  const delivery =
    entry.deliveryContext && typeof entry.deliveryContext === "object"
      ? entry.deliveryContext
      : null;
  const route = {
    channel: safeTrim(delivery?.channel || entry.lastChannel),
    target: safeTrim(delivery?.to || entry.lastTo),
    accountId: safeTrim(delivery?.accountId || entry.lastAccountId),
    threadId:
      delivery?.threadId ??
      delivery?.messageThreadId ??
      entry.lastThreadId ??
      entry.messageThreadId ??
      null,
  };
  return route.channel && route.target ? route : null;
}

async function latestRouteForAgent(agentId, preferredChannel) {
  const sessionsPath = path.join(SESSION_ROOT, agentId, "sessions", "sessions.json");
  const store = await readJson(sessionsPath, {});
  let best = null;
  for (const entry of Object.values(store || {})) {
    if (!entry || typeof entry !== "object") continue;
    const delivery =
      entry.deliveryContext && typeof entry.deliveryContext === "object"
        ? entry.deliveryContext
        : null;
    const route = {
      channel: safeTrim(delivery?.channel || entry.lastChannel),
      target: safeTrim(delivery?.to || entry.lastTo),
      accountId: safeTrim(delivery?.accountId || entry.lastAccountId),
      threadId:
        delivery?.threadId ??
        delivery?.messageThreadId ??
        entry.lastThreadId ??
        entry.messageThreadId ??
        null,
      updatedAt: Number(entry.updatedAt || 0),
    };
    if (!route.channel || !route.target) continue;
    if (preferredChannel && route.channel !== preferredChannel) continue;
    if (!best || route.updatedAt > best.updatedAt) best = route;
  }
  return best
    ? {
        channel: best.channel,
        target: best.target,
        accountId: best.accountId,
        threadId: best.threadId,
      }
    : null;
}

async function resolveLatestChatRoute() {
  let agentDirs = [];
  try {
    agentDirs = await readdir(SESSION_ROOT);
  } catch {
    agentDirs = ["telegram", "main"];
  }
  let best = null;
  for (const agentId of agentDirs) {
    const route = await latestRouteForAgent(agentId);
    if (!route) continue;
    const sessionsPath = path.join(SESSION_ROOT, agentId, "sessions", "sessions.json");
    const store = await readJson(sessionsPath, {});
    let updatedAt = 0;
    for (const entry of Object.values(store || {})) {
      const delivery =
        entry?.deliveryContext && typeof entry.deliveryContext === "object"
          ? entry.deliveryContext
          : null;
      const channel = safeTrim(delivery?.channel || entry?.lastChannel);
      const target = safeTrim(delivery?.to || entry?.lastTo);
      if (channel === route.channel && target === route.target) {
        updatedAt = Math.max(updatedAt, Number(entry?.updatedAt || 0));
      }
    }
    if (!best || updatedAt > best.updatedAt) best = { ...route, updatedAt };
  }
  return best
    ? {
        channel: best.channel,
        target: best.target,
        accountId: best.accountId,
        threadId: best.threadId,
      }
    : null;
}

async function resolveDefaultRoute(policy) {
  if (policy === "none") return null;
  if (policy === "last-chat") return resolveLatestChatRoute();
  const telegramRoute = await latestRouteForAgent("telegram", "telegram");
  if (telegramRoute) return telegramRoute;
  return resolveLatestChatRoute();
}

async function resolveRouteFromToolContext(context) {
  const sessionRoute = await resolveRouteFromSession(context?.agentId, context?.sessionKey);
  if (sessionRoute) return sessionRoute;
  const fallback = {
    channel: safeTrim(context?.messageChannel),
    target: safeTrim(context?.requesterSenderId),
    accountId: safeTrim(context?.agentAccountId),
    threadId: null,
  };
  return fallback.channel && fallback.target ? fallback : null;
}

async function resolveRouteFromCommandContext(context) {
  const route = {
    channel: safeTrim(context?.channel),
    target: safeTrim(context?.to || context?.from),
    accountId: safeTrim(context?.accountId),
    threadId: context?.messageThreadId ?? null,
  };
  return route.channel && route.target ? route : null;
}

function formatSubmission(payload) {
  const parts = [
    `Submitted Codex job ${payload.job_id} on ${payload.target}.`,
    `Status: ${payload.status}.`,
  ];
  if (payload.queue_position && payload.queue_position > 0) {
    parts.push(`Queue position: ${payload.queue_position}.`);
  }
  parts.push(`Check: /codex-job ${payload.job_id}`);
  return parts.join(" ");
}

function formatCounts(counts) {
  return `running ${counts.running || 0}, queued ${counts.queued || 0}, failed ${counts.failed || 0}, completed ${counts.completed || 0}, canceled ${counts.canceled || 0}`;
}

function formatJobLine(job) {
  const bits = [
    `${job.job_id.slice(0, 8)}`,
    job.source || "helper",
    job.target_label || job.target,
    job.action,
    job.status,
  ];
  if (job.queue_position) bits.push(`q${job.queue_position}`);
  if (job.manageability && job.manageability !== "full") bits.push(job.manageability);
  if (job.awaiting_user) bits.push("awaiting-user");
  const preview = compactText(job.result_preview || job.error || job.prompt_preview || "", 110);
  return preview ? `- ${bits.join(" | ")} | ${preview}` : `- ${bits.join(" | ")}`;
}

function formatJobsList(payload) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  if (!jobs.length) {
    return `No Codex jobs. Counts: ${formatCounts(payload.counts || {})}`;
  }
  const lines = [
    `Codex jobs: ${formatCounts(payload.counts || {})}`,
    ...jobs.slice(0, MAX_LIST_RESULTS).map(formatJobLine),
  ];
  return lines.join("\n");
}

function formatJobDetails(payload) {
  const job = payload.job || {};
  const lines = [
    `Job ${job.job_id}`,
    `source: ${job.source || "helper"}`,
    `target: ${job.target_label || job.target}`,
    `action: ${job.action}`,
    `status: ${job.status}`,
  ];
  if (job.manageability) lines.push(`manageability: ${job.manageability}`);
  if (job.mode) lines.push(`mode: ${job.mode}`);
  if (job.cwd) lines.push(`cwd: ${job.cwd}`);
  if (job.session_id) lines.push(`session_id: ${job.session_id}`);
  if (job.parent_job_id) lines.push(`parent_job_id: ${job.parent_job_id}`);
  if (job.awaiting_user) lines.push("awaiting_user: true");
  if (job.error) lines.push(`error: ${job.error}`);
  if (job.notify_policy) lines.push(`notify_policy: ${job.notify_policy}`);
  if (payload.result_excerpt) {
    lines.push("");
    lines.push("result:");
    lines.push(payload.result_excerpt.slice(0, 3000));
  } else if (payload.stderr_excerpt) {
    lines.push("");
    lines.push("stderr:");
    lines.push(payload.stderr_excerpt.slice(0, 3000));
  }
  return lines.join("\n");
}

function formatTargets(payload) {
  const items = Array.isArray(payload.targets) ? payload.targets : [];
  return items
    .map((item) => {
      const notes = [];
      if (item.review_supported) notes.push("review");
      if (item.running_job_id) notes.push(`running=${item.running_job_id.slice(0, 8)}`);
      if (item.queue_depth) notes.push(`queued=${item.queue_depth}`);
      return `- ${item.target}: ${item.cwd}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    })
    .join("\n");
}

function notificationSignature(meta) {
  return [
    meta.status || "",
    meta.finished_at || "",
    meta.awaiting_user ? "awaiting" : "done",
    meta.result_preview || "",
    meta.error || "",
  ].join("|");
}

function formatNotification(meta, resultText) {
  const label = meta.target_label || meta.target || meta.source || "codex";
  const externalDone = meta.source === "external" && meta.status === "completed";
  const title =
    meta.status === "failed"
      ? `Codex job ${meta.job_id.slice(0, 8)} on ${label} failed.`
      : meta.status === "canceled"
        ? `Codex job ${meta.job_id.slice(0, 8)} on ${label} was canceled.`
        : meta.awaiting_user
          ? `Codex job ${meta.job_id.slice(0, 8)} on ${label} is waiting for your decision.`
          : externalDone
            ? `Codex job ${meta.job_id.slice(0, 8)} on ${label} exited.`
            : `Codex job ${meta.job_id.slice(0, 8)} on ${label} completed.`;

  const detail =
    meta.status === "failed"
      ? compactText(meta.error || resultText || "Unknown error", MAX_RESULT_PREVIEW)
      : compactText(resultText || meta.result_preview || meta.error || "", MAX_RESULT_PREVIEW);

  const lines = [title];
  if (detail) {
    lines.push("");
    lines.push(detail);
  }
  lines.push("");
  lines.push(`Inspect: /codex-job ${meta.job_id}`);
  if (meta.awaiting_user && meta.continuation_available) {
    lines.push(`Reply: /codex-answer ${meta.job_id} <your decision>`);
  }
  lines.push("List: /codex-jobs");
  return lines.join("\n");
}

async function readJobMeta(jobId) {
  return readJson(path.join(path.dirname(JOBS_INDEX_PATH), jobId, "meta.json"), null);
}

async function readJobResult(jobId) {
  try {
    return await readFile(path.join(path.dirname(JOBS_INDEX_PATH), jobId, "result.txt"), "utf8");
  } catch {
    return "";
  }
}

async function resolveRouteFromMeta(meta) {
  const notification =
    meta?.notification && typeof meta.notification === "object" ? meta.notification : null;
  const policy = safeTrim(notification?.policy) || "telegram-last";
  if (policy === "none") return null;

  const delivery = meta?.delivery && typeof meta.delivery === "object" ? meta.delivery : null;
  const explicit = {
    channel: safeTrim(delivery?.channel),
    target: safeTrim(delivery?.target),
    accountId: safeTrim(delivery?.account_id || delivery?.accountId),
    threadId: delivery?.thread_id ?? delivery?.threadId ?? null,
  };
  if (explicit.channel && explicit.target) return explicit;

  const submission =
    meta?.submission && typeof meta.submission === "object" ? meta.submission : null;
  const sessionRoute = await resolveRouteFromSession(submission?.agent_id, submission?.session_key);
  if (sessionRoute) return sessionRoute;

  const fallback = {
    channel: safeTrim(submission?.message_channel),
    target: safeTrim(submission?.requester_sender_id),
    accountId: safeTrim(submission?.agent_account_id),
    threadId: null,
  };
  if (fallback.channel && fallback.target) return fallback;
  return resolveDefaultRoute(NOTIFY_POLICIES.has(policy) ? policy : "telegram-last");
}

async function sendNotification(route, text) {
  const args = [
    "message",
    "send",
    "--channel",
    route.channel,
    "--target",
    route.target,
    "--message",
    text,
  ];
  if (safeTrim(route.accountId)) args.push("--account", route.accountId);
  if (route.threadId !== null && route.threadId !== undefined && String(route.threadId).trim()) {
    args.push("--thread-id", String(route.threadId));
  }
  const result = await runProcess(OPENCLAW_BIN, args);
  if (result.exitCode !== 0) {
    throw new Error(compactText(result.stderr || result.stdout || "message send failed", 400));
  }
}

async function loadWatcherState(stateDir) {
  return readJson(path.join(stateDir, "notifications.json"), { notifications: {} });
}

async function saveWatcherState(stateDir, state) {
  await writeJson(path.join(stateDir, "notifications.json"), state);
}

async function watcherTick(stateDir, logger) {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    const listing = await runHelperJson(["jobs", "list", "--limit", "500"]);
    const jobs = Array.isArray(listing.jobs) ? listing.jobs : [];
    const state = await loadWatcherState(stateDir);
    const notifications = state.notifications || {};

    for (const summary of jobs) {
      if (!NOTIFIABLE.has(summary.status)) continue;
      const meta = await readJobMeta(summary.job_id);
      if (!meta) continue;
      const signature = notificationSignature(meta);
      const prior = notifications[summary.job_id];
      if (prior?.signature === signature && prior?.sent) continue;
      if (
        prior?.signature === signature &&
        !prior?.sent &&
        prior?.lastAttemptAt &&
        Date.now() - Date.parse(prior.lastAttemptAt) < RETRY_INTERVAL_MS
      ) {
        continue;
      }

      const route = await resolveRouteFromMeta(meta);
      if (!route) {
        notifications[summary.job_id] = {
          signature,
          sent: true,
          skipped: true,
          lastError: "no delivery route",
          sentAt: new Date().toISOString(),
        };
        logger.warn(`codex-jobs: skip notification for ${summary.job_id} (no delivery route)`);
        continue;
      }

      const resultText = await readJobResult(summary.job_id);
      const text = formatNotification(meta, resultText);
      try {
        await sendNotification(route, text);
        notifications[summary.job_id] = {
          signature,
          sent: true,
          sentAt: new Date().toISOString(),
        };
      } catch (error) {
        notifications[summary.job_id] = {
          signature,
          sent: false,
          lastAttemptAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
          attempts: (prior?.attempts || 0) + 1,
        };
        logger.warn(
          `codex-jobs: notification failed for ${summary.job_id}: ${notifications[summary.job_id].lastError}`,
        );
      }
    }

    const knownJobIds = new Set(jobs.map((job) => job.job_id));
    for (const jobId of Object.keys(notifications)) {
      if (!knownJobIds.has(jobId)) delete notifications[jobId];
    }
    await saveWatcherState(stateDir, { notifications });
  } finally {
    watcherBusy = false;
  }
}

async function submitRunLike(action, params, ctx, route) {
  const hidden = buildHiddenArgs(ctx, route);
  if (action === "run") {
    const helperArgs = [
      "run",
      "--target",
      params.target,
      "--mode",
      params.mode || "ephemeral",
      "--prompt-file",
      "-",
      ...hidden,
    ];
    return runHelperJson(helperArgs, params.prompt);
  }
  if (action === "resume_last") {
    const helperArgs = [
      "resume",
      "--target",
      params.target,
      "--last",
      "--mode",
      params.mode || "persistent",
      ...hidden,
    ];
    if (safeTrim(params.prompt)) helperArgs.push("--prompt-file", "-");
    return runHelperJson(helperArgs, safeTrim(params.prompt) ? params.prompt : undefined);
  }
  if (action === "resume_session") {
    const helperArgs = [
      "resume",
      "--target",
      params.target,
      "--session-id",
      params.sessionId,
      "--mode",
      params.mode || "persistent",
      ...hidden,
    ];
    if (safeTrim(params.prompt)) helperArgs.push("--prompt-file", "-");
    return runHelperJson(helperArgs, safeTrim(params.prompt) ? params.prompt : undefined);
  }
  if (action === "review") {
    const helperArgs = ["review", "--target", params.target, ...hidden];
    if (params.uncommitted) helperArgs.push("--uncommitted");
    if (safeTrim(params.base)) helperArgs.push("--base", params.base.trim());
    if (safeTrim(params.commit)) helperArgs.push("--commit", params.commit.trim());
    if (safeTrim(params.title)) helperArgs.push("--title", params.title.trim());
    if (safeTrim(params.prompt)) helperArgs.push("--prompt-file", "-");
    return runHelperJson(helperArgs, safeTrim(params.prompt) ? params.prompt : undefined);
  }
  throw new Error(`unsupported action: ${action}`);
}

async function submitAnswer(jobId, prompt, ctx, route, mode) {
  const hidden = buildHiddenArgs(ctx, route);
  const helperArgs = [
    "answer",
    "--job-id",
    jobId,
    "--mode",
    mode || "persistent",
    "--prompt-file",
    "-",
    ...hidden,
  ];
  return runHelperJson(helperArgs, prompt);
}

function ensureTarget(value) {
  if (!TARGETS.has(value)) throw new Error("target must be one of sa1 to sa5");
}

function ensureJobId(value) {
  if (!safeTrim(value)) throw new Error("jobId is required");
}

async function handleToolAction(params, ctx) {
  const action = safeTrim(params.action);
  if (!action) throw new Error("action is required");
  const route = await resolveRouteFromToolContext(ctx);

  if (action === "run") {
    ensureTarget(params.target);
    if (!safeTrim(params.prompt)) throw new Error("prompt is required for run");
    const payload = await submitRunLike(action, params, ctx, route);
    return formatSubmission(payload);
  }
  if (action === "resume_last") {
    ensureTarget(params.target);
    const payload = await submitRunLike(action, params, ctx, route);
    return formatSubmission(payload);
  }
  if (action === "resume_session") {
    ensureTarget(params.target);
    if (!safeTrim(params.sessionId)) throw new Error("sessionId is required for resume_session");
    const payload = await submitRunLike(action, params, ctx, route);
    return formatSubmission(payload);
  }
  if (action === "review") {
    ensureTarget(params.target);
    const payload = await submitRunLike(action, params, ctx, route);
    return formatSubmission(payload);
  }
  if (action === "answer") {
    ensureJobId(params.jobId);
    if (!safeTrim(params.prompt)) throw new Error("prompt is required for answer");
    const payload = await submitAnswer(params.jobId, params.prompt, ctx, route, params.mode);
    return `Submitted continuation job ${payload.job_id} for ${params.jobId}. Check: /codex-job ${payload.job_id}`;
  }
  if (action === "list") {
    const args = [
      "jobs",
      "list",
      "--limit",
      String(Math.min(Number(params.limit) || MAX_LIST_RESULTS, 100)),
    ];
    if (safeTrim(params.target)) {
      args.push("--target", params.target);
    }
    if (safeTrim(params.status)) {
      if (!STATUSES.has(params.status)) throw new Error("invalid status filter");
      args.push("--status", params.status);
    }
    if (safeTrim(params.source)) {
      if (!SOURCES.has(params.source)) throw new Error("invalid source filter");
      args.push("--source", params.source);
    }
    if (safeTrim(params.manageable)) {
      if (!MANAGEABILITY.has(params.manageable)) throw new Error("invalid manageability filter");
      args.push("--manageable", params.manageable);
    }
    return formatJobsList(await runHelperJson(args));
  }
  if (action === "show") {
    ensureJobId(params.jobId);
    return formatJobDetails(await runHelperJson(["jobs", "show", "--job-id", params.jobId]));
  }
  if (action === "cancel") {
    ensureJobId(params.jobId);
    const payload = await runHelperJson(["jobs", "cancel", "--job-id", params.jobId]);
    return `Job ${payload.job_id} cancel requested.`;
  }
  if (action === "clear_finished") {
    const payload = await runHelperJson(["jobs", "clear", "--finished"]);
    return `Cleared ${payload.cleared} finished jobs.`;
  }
  if (action === "status") {
    ensureTarget(params.target);
    const payload = await runHelperJson(["status", "--target", params.target]);
    return `Target ${payload.target}: running=${payload.running_job_id || "none"}, queued=${payload.queue_depth}, lastSession=${payload.last_session_id || "none"}`;
  }
  if (action === "targets") {
    return formatTargets(await runHelperJson(["targets"]));
  }
  throw new Error(`unsupported action: ${action}`);
}

function formatCommandFailure(error) {
  return { text: `Codex jobs error: ${error instanceof Error ? error.message : String(error)}` };
}

function extractJobFilters(args) {
  const tokens = splitArgs(args);
  const filters = {};
  for (const token of tokens) {
    if (TARGETS.has(token)) filters.target = token;
    else if (token === "helper" || token === "external") filters.source = token;
    else if (MANAGEABILITY.has(token)) filters.manageable = token;
    else if (STATUSES.has(token)) filters.status = token;
    else if (/^\d+$/.test(token)) filters.limit = token;
  }
  return filters;
}

const plugin = {
  id: "codex-jobs",
  name: "Codex Jobs",
  description: "Background Codex workspace jobs with queueing, notifications, and reply commands.",
  register(api) {
    api.registerTool(
      (ctx) => ({
        name: "codex_job",
        description:
          "Submit and manage background Codex jobs in the fixed sa1 to sa5 workspaces. Use this for delegated Codex tasks, queue inspection, canceling jobs, and continuing a job after the user makes a decision.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              enum: [
                "run",
                "resume_last",
                "resume_session",
                "review",
                "answer",
                "list",
                "show",
                "cancel",
                "clear_finished",
                "status",
                "targets",
              ],
            },
            target: { type: "string" },
            prompt: { type: "string" },
            mode: { type: "string", enum: ["ephemeral", "persistent"] },
            sessionId: { type: "string" },
            jobId: { type: "string" },
            status: { type: "string", enum: Array.from(STATUSES) },
            source: { type: "string", enum: Array.from(SOURCES) },
            manageable: { type: "string", enum: Array.from(MANAGEABILITY) },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            uncommitted: { type: "boolean" },
            base: { type: "string" },
            commit: { type: "string" },
            title: { type: "string" },
          },
          required: ["action"],
        },
        async execute(_id, params) {
          try {
            const text = await handleToolAction(params, ctx);
            return { content: [{ type: "text", text }] };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `codex_job failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      }),
      { optional: true, name: "codex_job" },
    );

    api.registerCommand({
      name: "codex-jobs",
      description: "List queued, running, and recent Codex jobs.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          const filters = extractJobFilters(ctx.args || "");
          const args = ["jobs", "list", "--limit", String(filters.limit || MAX_LIST_RESULTS)];
          if (filters.target) args.push("--target", filters.target);
          if (filters.status) args.push("--status", filters.status);
          if (filters.source) args.push("--source", filters.source);
          if (filters.manageable) args.push("--manageable", filters.manageable);
          return { text: formatJobsList(await runHelperJson(args)) };
        } catch (error) {
          return formatCommandFailure(error);
        }
      },
    });

    api.registerCommand({
      name: "codex-job",
      description: "Show one Codex job by job id.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          const jobId = splitArgs(ctx.args || "")[0];
          ensureJobId(jobId);
          return {
            text: formatJobDetails(await runHelperJson(["jobs", "show", "--job-id", jobId])),
          };
        } catch (error) {
          return formatCommandFailure(error);
        }
      },
    });

    api.registerCommand({
      name: "codex-cancel",
      description: "Cancel a queued or running Codex job.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          const jobId = splitArgs(ctx.args || "")[0];
          ensureJobId(jobId);
          const payload = await runHelperJson(["jobs", "cancel", "--job-id", jobId]);
          return { text: `Job ${payload.job_id} cancel requested.` };
        } catch (error) {
          return formatCommandFailure(error);
        }
      },
    });

    api.registerCommand({
      name: "codex-answer",
      description: "Continue a completed Codex job with your decision.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        try {
          const raw = safeTrim(ctx.args || "");
          const [jobId, ...rest] = raw.split(/\s+/);
          ensureJobId(jobId);
          const prompt = rest.join(" ").trim();
          if (!prompt) throw new Error("usage: /codex-answer <job_id> <your decision>");
          const route = await resolveRouteFromCommandContext(ctx);
          const payload = await submitAnswer(
            jobId,
            prompt,
            {
              agentId: undefined,
              sessionKey: undefined,
              sessionId: undefined,
              messageChannel: ctx.channel,
              agentAccountId: ctx.accountId,
              requesterSenderId: ctx.from,
            },
            route,
            "persistent",
          );
          return {
            text: `Submitted continuation job ${payload.job_id} for ${jobId}. Check: /codex-job ${payload.job_id}`,
          };
        } catch (error) {
          return formatCommandFailure(error);
        }
      },
    });

    api.registerService({
      id: "codex-job-watcher",
      start: async (ctx) => {
        const pollMs = Number(api.pluginConfig?.pollMs) || DEFAULT_POLL_MS;
        await watcherTick(ctx.stateDir, ctx.logger);
        watcherTimer = setInterval(() => {
          watcherTick(ctx.stateDir, ctx.logger).catch((error) => {
            ctx.logger.warn(
              `codex-jobs watcher error: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }, pollMs);
        if (typeof watcherTimer?.unref === "function") watcherTimer.unref();
      },
      stop: async () => {
        if (watcherTimer) clearInterval(watcherTimer);
        watcherTimer = null;
      },
    });
  },
};

export default plugin;
