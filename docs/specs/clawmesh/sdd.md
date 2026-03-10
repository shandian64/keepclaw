# ClawMesh SDD v0.1

## 0. Baseline audit: what KeepClaw already is

KeepClaw is not a clean-room rewrite. It is an AGPL fork of OpenClaw that keeps the upstream `openclaw` CLI/config surface and adds bundled custom plugins, skills, and a source-first self-hosting workflow. The repo explicitly says its goal is to keep local customizations in source control and stay close enough to upstream for regular merges. Relevant fork-specific additions already include `codex-jobs`, `local-output-guidance`, `tavily-search`, and a customized `memory-lancedb` backend. The workspace is already wired as a pnpm monorepo with `extensions/*`, so a new `extensions/clawmesh` package fits the current structure naturally.

### What the current prototype gives us

The most useful prototype piece is `codex-jobs`:

- plugin description: background Codex workspace jobs with queueing, notifications, and reply commands
- helper-backed model: a JS plugin delegates to a Python helper (`skills/codex-sa-control/scripts/codex_sa.py`)
- fixed-target mental model: `codex` plus explicit `sa1`-`sa5`
- queue semantics: one running job per target, additional work queued per target
- user-facing affordances: `/codex-jobs`, `/codex-job`, `/codex-cancel`, `/codex-answer`
- delivery semantics: it resolves a prior session or channel route and pushes completion/failure/decision-needed notifications back to the user

### Why this is only a prototype for ClawMesh

`codex-jobs` is good at “background work on fixed local Codex workspaces.”
ClawMesh needs to generalize that into:

- multi-agent orchestration, not just one helper-managed runner
- ACP-native sessions for Codex / Claude Code / Gemini-class external harnesses
- event ingress from GitHub/webhooks/rooms
- append-only receipts + replay
- thread-aware routing instead of one-off message sendback

So the right move is **evolution, not copy-paste**.

---

## 1. Product definition

**ClawMesh** is an OpenClaw-native orchestration extension that turns external coding agents into durable team workers.

### One-line pitch

> GitHub and chat events come in, ClawMesh routes them to the right ACP-backed agent session, preserves thread continuity, and records every handoff in an append-only receipt ledger.

### Target user

A single trusted operator or a small trusted team running a self-hosted OpenClaw gateway and coordinating external coding agents such as Codex and Claude Code.

### Problem statement

Today, KeepClaw has local job delegation for Codex, but not a general-purpose mesh for:

- multi-agent routing
- GitHub-first workflow automation
- durable receipt/replay
- ACP session lifecycle management across multiple harnesses
- channel/thread continuity

### Design principles

1. **OpenClaw-native first**: build as an extension, not a parallel control plane.
2. **ACP-first**: external coding harnesses should use ACP sessions, not ad hoc shell wrappers, when possible.
3. **GitHub-first v1**: first shipping path is GitHub Issue/PR events.
4. **Receipts over vibes**: every action should be traceable.
5. **Single trusted operator boundary**: do not pretend to be hostile multi-tenant infra.
6. **Upstream-friendly**: minimize fork blast radius and keep most logic inside `extensions/clawmesh`.

---

## 2. Scope

### In scope for v1

1. GitHub webhook ingestion
2. Event normalization into an internal task envelope
3. Rule-based agent selection (`codex`, `claude`, later others)
4. ACP session spawn / bind / steer / close lifecycle
5. Append-only receipt ledger with replay support
6. GitHub comment/review-comment writeback
7. One secondary delivery target: Discord thread **or** Telegram topic (pick one, not both in first PR)
8. Operator commands for status, replay, dry-run, and stuck-session inspection

### Out of scope for v1

1. Public SaaS / multi-tenant control plane
2. Full room-connector zoo (Ant Farm, Moltbook, custom protocols)
3. Rich IDE-side agents beyond ACP-backed Codex / Claude Code
4. Autonomous planning/governance councils
5. Auto-merge or destructive repo actions without explicit operator opt-in
6. Full UI rewrite

---

## 3. Functional requirements

### FR-1 Event ingress

ClawMesh must accept signed GitHub webhook events and normalize these event types at minimum:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review_comment`

### FR-2 Internal task envelope

Every accepted event must be converted into a canonical envelope:

- `event_id`
- `trace_id`
- `source`
- `event_type`
- `repo`
- `actor`
- `thread_key`
- `payload`
- `received_at`
- `idempotency_key`

### FR-3 Rule-based routing

The router must support deterministic rules based on:

- repository
- event type
- labels
- slash command / mention override
- branch prefix (optional in v1)

Routing result must contain:

- target harness (`codex`, `claude`, etc.)
- runtime = `acp`
- session mode (`persistent` or `one-shot`)
- delivery target
- policy flags (`review_only`, `comment_only`, `dry_run`)

### FR-4 ACP lifecycle management

ClawMesh must be able to:

- spawn a new ACP session for a target harness
- bind a channel thread to that session when configured
- steer an existing bound session on follow-up events
- cancel or close a session
- detect a stale/missing session and recover safely

### FR-5 Receipt ledger

Every action must create an append-only receipt with:

- `receipt_id`
- `trace_id`
- `event_id`
- `action`
- `target_agent`
- `session_key`
- `input_digest`
- `status`
- `created_at`
- `result_ref`
- `error`

### FR-6 Replay

Operator must be able to replay an event or resume a partially completed flow using the saved envelope and receipts.

### FR-7 Writeback

For v1, ClawMesh must support GitHub writeback:

- issue comments
- PR comments or review comments
- status note on failure / retry / dry-run outcome

### FR-8 Observability

Operator must be able to inspect:

- queue depth
- last N receipts
- active ACP sessions
- failed routes
- replay status

---

## 4. Non-functional requirements

### NFR-1 Maintainability

All ClawMesh logic should live primarily under `extensions/clawmesh` with only minimal root-level integration.

### NFR-2 Determinism

Routing and idempotency must be deterministic. Same webhook delivery should not cause duplicate agent work.

### NFR-3 Auditability

All side effects must be represented in receipts. If it acted, we should be able to prove it acted.

### NFR-4 Failure isolation

One failed target harness or delivery channel must not crash the whole background service loop.

### NFR-5 Upstream mergeability

Avoid touching OpenClaw core unless an extension point is genuinely missing.

### NFR-6 Security posture

Assume one trusted operator boundary per gateway. Do not market or design v1 as safe hostile multi-tenant isolation.

---

## 5. Proposed architecture

## 5.1 Package location

Create:

```text
extensions/clawmesh/
  index.ts
  openclaw.plugin.json
  package.json
  src/
    contracts/
      event.ts
      receipt.ts
      route.ts
      config.ts
    services/
      ingress-github.ts
      normalize.ts
      router.ts
      acp-runtime.ts
      receipts.ts
      replay.ts
      delivery-github.ts
      delivery-discord.ts   # or telegram.ts in v1, not both
      queue.ts
    commands/
      status.ts
      replay.ts
      dry-run.ts
    test/
```

## 5.2 Main flow

```text
GitHub Webhook
  -> ingress-github
  -> normalize -> TaskEnvelope
  -> idempotency check
  -> router
  -> acp-runtime
  -> delivery
  -> receipt append
```

## 5.3 Plugin capabilities to use

Use OpenClaw plugin APIs for:

- HTTP route registration
- background service loop
- agent tools / operator commands
- optional Gateway RPC if needed later

## 5.4 Data persistence

Store runtime state under `~/.openclaw/runtime/clawmesh/`:

- `events.jsonl`
- `receipts.jsonl`
- `bindings.json`
- `queue.json`
- `replay/`
- `dead-letter/`

Do **not** store operator secrets in repo.

---

## 6. Interface contracts

### 6.1 TaskEnvelope

```ts
interface TaskEnvelope {
  eventId: string;
  traceId: string;
  source: "github" | "discord" | "telegram";
  eventType: string;
  repo?: string;
  actor?: string;
  threadKey: string;
  idempotencyKey: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}
```

### 6.2 RouteDecision

```ts
interface RouteDecision {
  targetAgent: string;
  runtime: "acp";
  sessionMode: "persistent" | "one-shot";
  sessionKey?: string;
  deliveryTarget: {
    kind: "github-comment" | "github-review" | "discord-thread" | "telegram-topic";
    ref: string;
  };
  flags?: {
    dryRun?: boolean;
    reviewOnly?: boolean;
    commentOnly?: boolean;
  };
}
```

### 6.3 Receipt

```ts
interface Receipt {
  receiptId: string;
  traceId: string;
  eventId: string;
  action:
    | "event.accepted"
    | "route.selected"
    | "acp.spawned"
    | "acp.steered"
    | "delivery.sent"
    | "delivery.failed"
    | "replay.started"
    | "replay.finished";
  targetAgent?: string;
  sessionKey?: string;
  status: "ok" | "error" | "skipped";
  createdAt: string;
  error?: string;
  resultRef?: string;
}
```

---

## 7. Milestone plan

## M0 - Repository scaffold

### Goal

Land a minimal `extensions/clawmesh` plugin that loads and exposes status commands.

### Deliverables

- plugin manifest
- package scaffold
- config schema
- runtime dir bootstrap
- `/clawmesh-status` command (or similar)
- test for plugin loading

### Acceptance

- `pnpm build` passes
- plugin can be discovered in `openclaw plugins list`
- command prints initialized runtime paths and zero-state counters

## M1 - GitHub ingress + receipts

### Goal

Accept GitHub webhooks, verify signatures, normalize events, append receipts.

### Deliverables

- signed GitHub route
- TaskEnvelope builder
- idempotency key generation
- `events.jsonl` and `receipts.jsonl`
- dead-letter handling for malformed events

### Acceptance

- replaying the same webhook does not duplicate work
- every accepted webhook produces at least two receipts:
  - `event.accepted`
  - `route.selected` or `delivery.failed`

## M2 - ACP runtime integration

### Goal

Route events to Codex or Claude via ACP.

### Deliverables

- ACP spawn wrapper
- binding persistence
- follow-up `steer` support
- stale session detection
- dry-run mode

### Acceptance

- a GitHub comment can trigger a persistent ACP session
- a second comment in same thread reuses that session
- stale session fallback creates a new session and records why

## M3 - GitHub writeback

### Goal

Post results back to GitHub.

### Deliverables

- issue comment delivery
- PR review comment delivery or regular PR comment delivery
- failure writeback template

### Acceptance

- success and failure both create visible GitHub feedback
- receipt links result to GitHub target reference

## M4 - Secondary channel + operator replay

### Goal

Add one threaded chat channel and replay tooling.

### Deliverables

- Discord thread or Telegram topic delivery
- replay command
- stuck-run inspection command

### Acceptance

- operator can replay an event by `trace_id`
- replay path writes fresh receipts without mutating original receipts

---

## 8. First PR scope (what Codex should build now)

Do **not** start with ACP execution. Start with the boring skeleton. Boring skeletons are how ambitious systems avoid becoming cursed spaghetti.

### PR-1 scope

Build `extensions/clawmesh` with:

1. plugin manifest
2. config schema
3. runtime bootstrap under `~/.openclaw/runtime/clawmesh`
4. JSONL append helpers for events and receipts
5. `TaskEnvelope` and `Receipt` TypeScript contracts
6. signed GitHub webhook HTTP route in **dry-run mode only**
7. `/clawmesh-status` command
8. `/clawmesh-replay --dry-run <traceId>` placeholder command
9. tests for signature verification, idempotency, and JSONL append

### Explicit non-goals for PR-1

- no actual ACP spawn yet
- no GitHub writeback yet
- no Discord/Telegram yet
- no UI work

---

## 9. Codex implementation prompt

Use this as the first Codex prompt:

```md
You are implementing the first ClawMesh milestone inside the KeepClaw repo.

Context:

- KeepClaw is a source-first AGPL fork of OpenClaw.
- We are adding a new extension at `extensions/clawmesh`.
- This is NOT a full app or separate server.
- It must fit the existing OpenClaw plugin model and pnpm workspace layout.
- The long-term target is ACP-backed orchestration for Codex/Claude sessions, but this PR is dry-run only.

Goal of this PR:
Build the ClawMesh plugin scaffold with GitHub webhook ingestion and append-only receipts, but do not spawn ACP sessions yet.

Deliverables:

1. Create `extensions/clawmesh/` with plugin manifest + package metadata.
2. Define TypeScript contracts for `TaskEnvelope`, `RouteDecision`, and `Receipt`.
3. Implement runtime bootstrap under `~/.openclaw/runtime/clawmesh`.
4. Implement JSONL append helpers and load helpers.
5. Register a signed GitHub webhook route that:
   - verifies GitHub HMAC signature
   - accepts a small allowlist of event types
   - normalizes the payload into `TaskEnvelope`
   - computes an idempotency key
   - appends envelope + receipts
   - returns a dry-run response
6. Register operator commands:
   - `/clawmesh-status`
   - `/clawmesh-replay` (dry-run placeholder)
7. Add tests for:
   - signature validation
   - duplicate event suppression by idempotency key
   - JSONL append/read
   - command output on empty state

Constraints:

- Keep code isolated to `extensions/clawmesh` unless a missing extension point forces otherwise.
- Use small modules, not one giant file.
- Prefer explicit pure helpers for normalization and idempotency.
- Do not implement ACP execution in this PR.
- Do not implement GitHub comment writeback in this PR.
- Write a short README inside `extensions/clawmesh` explaining the dry-run milestone.

Definition of done:

- `pnpm build` and relevant tests pass.
- Plugin loads without touching core files unless strictly necessary.
- A sample GitHub webhook can be ingested and recorded as dry-run state.
```

---

## 10. Open questions for PR-2

These should be decided before ACP execution lands:

1. Is v1 second delivery target Discord or Telegram?
2. How should thread binding be keyed for GitHub: issue number, PR number, comment thread id, or a composite?
3. Should `codex` and `claude` share a common routing config file, or should agent rules be embedded in plugin config first?
4. Do we want a single `bindings.json`, or split bindings by source channel?
5. Should replay be “same trace id, new receipt chain” or “new trace id linked to parent trace”? My vote: new trace id linked to parent trace.
