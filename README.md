# KeepClaw

<p align="center">
  <a href="https://github.com/shandian64/keepclaw"><img src="https://img.shields.io/badge/Fork-KeepClaw-1f6feb?style=for-the-badge" alt="KeepClaw"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg?style=for-the-badge" alt="AGPL-3.0-or-later"></a>
</p>

**KeepClaw** is an AGPL fork of **OpenClaw** focused on local automation, source-first self-hosting, and bundled custom plugins and skills.

It keeps the upstream `openclaw` CLI/config surface, but adds opinionated local tooling for runtime orchestration, memory, search, browser control, and image-generation workflows.

[Project Notes](docs/keepclaw.md) · [Upstream OpenClaw](https://github.com/openclaw/openclaw) · [Upstream Docs](https://docs.openclaw.ai)

## Why this fork exists

- Keep custom plugins and skills in the source tree instead of `~/.openclaw`.
- Preserve a source-install workflow for a heavily customized single-user deployment.
- Add local integrations that are useful in WSL/self-hosted setups.
- Stay close enough to upstream OpenClaw that regular upstream merges remain practical.

## What KeepClaw adds

- Bundled custom plugins such as `codex-jobs`, `local-output-guidance`, and `tavily-search`.
- A customized `memory-lancedb` integration as the active long-term memory backend.
- Bundled local skills for Codex workspace control, Windows browser control from WSL, local image generation, backups, and environment guards.
- A local environment convention via `~/.openclaw/local.env` so machine-specific paths and keys stay out of the repo.

## From source

Runtime: **Node >= 22**

```bash
git clone https://github.com/shandian64/keepclaw.git
cd keepclaw

cp scripts/dev/local.env.example ~/.openclaw/local.env
pnpm install
pnpm build

pnpm openclaw onboard --install-daemon
```

To refresh a local source install after changes:

```bash
scripts/dev/install-local-source.sh
```

The CLI command remains `openclaw`.

## Local configuration

Machine-specific paths, API keys, and runtime directories belong in:

```bash
~/.openclaw/local.env
```

Start from:

```bash
scripts/dev/local.env.example
```

Runtime state, logs, credentials, sessions, and caches stay under `~/.openclaw`; they are intentionally not part of this repo.

## Upstream relationship

KeepClaw is maintained as an enhanced fork, not a clean-room rewrite. Most core gateway, CLI, and UI behavior still comes from upstream OpenClaw.

Recommended remote setup:

```bash
git remote -v
# origin   https://github.com/shandian64/keepclaw.git
# upstream https://github.com/openclaw/openclaw.git
```

Typical sync flow:

```bash
git fetch upstream --tags
git checkout main
git merge upstream/main
```

## License

This fork is distributed under **GNU AGPL-3.0-or-later**. It includes upstream OpenClaw code that remains available under the upstream **MIT License**.

- Fork license: [LICENSE](LICENSE)
- Upstream license text preserved at [LICENSES/openclaw-upstream-MIT.txt](LICENSES/openclaw-upstream-MIT.txt)
- Fork notice and attribution: [NOTICE](NOTICE)

If you deploy a modified networked version of KeepClaw, AGPL source-disclosure obligations apply.
