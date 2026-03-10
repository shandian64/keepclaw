---
name: codex-sa-control
description: Delegate work from OpenClaw to the dedicated Codex workspace configured by `OPENCLAW_CODEX_WORKSPACE`, or to one of the fixed sa1-sa5 Codex workspaces under `OPENCLAW_CODEX_SA_ROOT` when the user explicitly names and authorizes them. Use when the user wants Codex to run a task, resume a Codex session, inspect queued jobs, or run a repository review for sa1.
metadata:
  { "openclaw": { "emoji": "🧩", "os": ["linux"], "requires": { "bins": ["python3", "codex"] } } }
---

# Codex Control

Use this skill when OpenClaw should hand work to a managed Codex workspace:

- `codex` -> `OPENCLAW_CODEX_WORKSPACE` (defaults to `~/.openclaw/codex-workspace`)
- `sa1` -> `${OPENCLAW_CODEX_SA_ROOT}/sa1`
- `sa2` -> `${OPENCLAW_CODEX_SA_ROOT}/sa2`
- `sa3` -> `${OPENCLAW_CODEX_SA_ROOT}/sa3`
- `sa4` -> `${OPENCLAW_CODEX_SA_ROOT}/sa4`
- `sa5` -> `${OPENCLAW_CODEX_SA_ROOT}/sa5`

Rules:

- Prefer `codex` by default.
- Only use `sa1` to `sa5` when the user explicitly names them or explicitly authorizes them.
- Always require an explicit target for `run`, `resume`, and `review`. Do not guess.

Prefer this skill when:

- the user wants a task delegated into the dedicated Codex workspace
- the user explicitly says `sa1` to `sa5`
- the user wants to continue a prior Codex session in one of those managed workspaces
- the user wants to inspect queued or running Codex jobs
- the user wants a Codex review for `sa1`

Do not use this skill for arbitrary filesystem paths. It is intentionally restricted to the managed workspaces above.

## Preferred Interface

Prefer the plugin tool `codex_job` when it is available. It submits background jobs, keeps per-target queues, and lets OpenClaw auto-notify the user when a job completes or needs a decision.

Use these actions:

- `run`
- `resume_last`
- `resume_session`
- `review`
- `answer`
- `list`
- `show`
- `cancel`
- `clear_finished`
- `status`
- `targets`

For direct user control in chat, prefer these commands:

- `/codex-jobs`
- `/codex-job <job_id>`
- `/codex-cancel <job_id>`
- `/codex-answer <job_id> <decision>`

## Helper

Use the bundled helper:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py --help
```

The helper prints JSON to stdout only. It is the backend for the plugin tool and commands.

## Commands

Show target map and capabilities:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py targets
```

Inspect one target:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py status --target codex
```

Submit a background task to the dedicated Codex workspace:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  run --target codex --mode ephemeral --prompt 'Reply with OK only.'
```

Submit a background task and force notifications to a specific route:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  run --target codex --mode ephemeral --prompt 'Reply with OK only.' \
  --notify-channel telegram --notify-target telegram:<chat_id> --notify-account default
```

Submit a persistent task that can be resumed later:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  run --target codex --mode persistent --prompt 'Inspect the repo and summarize risks.'
```

Resume the last session in one target:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  resume --target codex --last --prompt 'Continue.'
```

Resume by explicit session id:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  resume --target codex --session-id 019cd45a-93d9-7171-8907-7040567e1fe9 --prompt 'Continue.'
```

Run a Codex review for `sa1`:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  review --target sa1 --uncommitted
```

List all jobs:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py jobs list
```

List only externally discovered Codex processes:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py jobs list --source external
```

Show one job:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py jobs show --job-id <job_id>
```

Continue a completed job with new user input:

```bash
python3 <openclaw-source>/skills/codex-sa-control/scripts/codex_sa.py \
  answer --job-id <job_id> --prompt 'Use option B and continue.'
```

## Behavior Notes

- The helper always runs Codex with process `cwd` set to the chosen target directory.
- The preferred safe default target is `codex` (`OPENCLAW_CODEX_WORKSPACE`).
- `sa1` to `sa5` remain available for explicit user-directed work only.
- The helper always adds `--skip-git-repo-check` for `run`, `resume`, and `review`. On this machine that is required even for `sa1`, because Codex otherwise blocks on the trusted-directory check.
- `review` is supported only for `sa1`. For `codex` and `sa2` to `sa5`, the helper returns a structured JSON error immediately.
- `resume --last` uses the helper's own per-target session ledger, not Codex's global most-recent session picker.
- `run` defaults to `ephemeral`, but persistent mode is better when the user may need to answer follow-up questions.
- `resume` defaults to `persistent`.
- Jobs are queued per target. One target runs at most one job at a time.
- Shell submissions default to `--notify-policy telegram-last`. If there is no usable Telegram route, the job still runs and is marked as no-notify.
- The unified jobs view includes both helper-managed jobs and externally discovered WSL `codex` processes.
- Externally discovered WSL `codex` processes are monitored in the jobs view, but they do not auto-push completion messages by default.
- External tasks can be observed and usually canceled, but only helper-managed jobs support `/codex-answer`.
- Long prompts are safer through stdin than shell quoting. If needed, pass `--prompt-file -` style content by piping into the helper.
