#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
ENV_FILE="$STATE_DIR/local.env"
EXAMPLE_ENV="$ROOT_DIR/scripts/dev/local.env.example"
NODE22_BIN="$STATE_DIR/tools/node-v22.22.0/bin"

if [[ -d "$NODE22_BIN" ]]; then
  export PATH="$NODE22_BIN:$PATH"
fi

if [[ ! -f "$ENV_FILE" && -f "$EXAMPLE_ENV" ]]; then
  mkdir -p "$STATE_DIR"
  cp "$EXAMPLE_ENV" "$ENV_FILE"
  echo "Created local env template: $ENV_FILE"
fi

cd "$ROOT_DIR"
pnpm install
pnpm build

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload || true
  systemctl --user restart openclaw-gateway.service || true
fi

echo "Source install refreshed from $ROOT_DIR"
echo "Local env: $ENV_FILE"
