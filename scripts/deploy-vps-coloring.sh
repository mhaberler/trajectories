#!/usr/bin/env bash
#
# Deploy the track-import playground to https://vps.mah.priv.at/trajectories/coloring/
# (Caddy Basic Auth — same /trajectories* matcher as the main UI).
#
# Aufruf: bun run deploy:vps:coloring   (oder: bash scripts/deploy-vps-coloring.sh)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="mah@vps.mah.priv.at:/var/www/vps/trajectories/coloring"
BASE="/trajectories/coloring/"

echo "==> Baue track-import (base=${BASE}) ..."
cd "$PROJECT_DIR"
bunx vite build --config track-import/vite.config.js --base="$BASE"

echo "==> Synchronisiere track-import/dist/ → ${DEST}/ ..."
if [[ "$DEST" == *:* ]]; then
  remote_path="${DEST#*:}"
  ssh "${DEST%%:*}" "mkdir -p $(printf %q "$remote_path")"
  rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/track-import/dist/" "$DEST/"
elif mkdir -p "$DEST" 2>/dev/null && [[ -w "$DEST" ]]; then
  rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/track-import/dist/" "$DEST/"
else
  sudo mkdir -p "$DEST"
  sudo rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/track-import/dist/" "$DEST/"
fi

echo "==> Fertig: https://vps.mah.priv.at/trajectories/coloring/"
echo "    (Basic Auth: user trajectories — hash in /etc/caddy/Caddyfile)"
