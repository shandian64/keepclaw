# KeepClaw Project Notes

## Overview

KeepClaw is a source-first, self-hosted fork of OpenClaw. The goal is not to replace upstream OpenClaw's product vision; it is to keep a customized deployment manageable, reproducible, and publishable as a single repo.

The fork keeps the `openclaw` CLI and most upstream concepts intact, while bundling local plugins, local skills, and environment-specific integrations that would otherwise live in `~/.openclaw`.

## Fork goals

- Keep custom code inside the repo instead of the runtime state directory.
- Make local automation features reproducible across rebuilds.
- Support source-based deployment on a single self-hosted machine.
- Stay close enough to upstream that regular merges are still feasible.

## Bundled customizations

Current fork-specific additions include:

- custom plugins such as `codex-jobs`, `local-output-guidance`, and `tavily-search`
- a customized `memory-lancedb` backend for long-term memory
- bundled skills such as `codex-sa-control`, `windows-browser-wsl`, `imagegen`, `wuyi-imagegen`, `env-guard`, `self-backup`, and `ssl-certificate-checker`
- a local environment model driven by `~/.openclaw/local.env`

Not everything is vendored into the repo. Runtime state, credentials, caches, sessions, and optional third-party add-ons remain outside the repo under `~/.openclaw`.

## Development model

Source lives in this repo. Runtime state lives in `~/.openclaw`.

The expected local workflow is:

```bash
cp scripts/dev/local.env.example ~/.openclaw/local.env
scripts/dev/install-local-source.sh
```

Machine-specific values such as local workspace paths, browser executable paths, and API keys must stay in `~/.openclaw/local.env`, not in committed source.

## Upstream sync

This repo should keep:

- `origin` -> `https://github.com/shandian64/keepclaw.git`
- `upstream` -> `https://github.com/openclaw/openclaw.git`

Typical update flow:

```bash
git fetch upstream --tags
git checkout main
git merge upstream/main
```

Conflicts are most likely in:

- bundled custom plugins
- bundled custom skills
- `extensions/memory-lancedb`
- any fork-specific README or packaging metadata

## Licensing

KeepClaw is distributed under `AGPL-3.0-or-later`, while preserving OpenClaw's original MIT license text for upstream-derived code.

See:

- [LICENSE](../LICENSE)
- [LICENSES/openclaw-upstream-MIT.txt](../LICENSES/openclaw-upstream-MIT.txt)
- [NOTICE](../NOTICE)
