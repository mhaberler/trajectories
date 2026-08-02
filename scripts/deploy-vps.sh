#!/usr/bin/env bash
#
# Deploy the Vite webapp to https://vps.mah.priv.at/trajectories/
# (Caddy Basic Auth — see deploy/Caddyfile.vps-trajectories.snippet).
#
# Aufruf: bun run deploy:vps   (oder: bash scripts/deploy-vps.sh)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TRAJECTORIES_VPS_DEST:-/var/www/vps/trajectories}"
BASE="/trajectories/"

echo "==> Baue Web-Build (base=${BASE}) ..."
cd "$PROJECT_DIR"
bunx vite build --base="$BASE"

echo "==> Synchronisiere dist/ → ${DEST}/ ..."
if mkdir -p "$DEST" 2>/dev/null && [[ -w "$DEST" ]]; then
  rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$DEST/"
else
  sudo mkdir -p "$DEST"
  sudo rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$DEST/"
fi

echo "==> Fertig: https://vps.mah.priv.at/trajectories/"
echo "    (Basic Auth: user trajectories — hash in /etc/caddy/Caddyfile)"
