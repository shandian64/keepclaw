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
