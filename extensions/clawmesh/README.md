# ClawMesh

ClawMesh is a dry-run orchestration scaffold for KeepClaw/OpenClaw.

PR-1 only does three things:

- ingests signed GitHub webhooks on a plugin-owned route
- normalizes supported events into `TaskEnvelope`
- records envelopes and receipts under `~/.openclaw/runtime/clawmesh`

This milestone does **not** spawn ACP sessions, does **not** write back to GitHub, and does **not** execute any agent work. It only records the dry-run decision path so the next milestone can build on append-only state.
