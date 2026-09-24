#!/usr/bin/env bash
#
# Deploy the track-import playground to https://vps.mah.priv.at/trajectories/track-import/
# (Caddy Basic Auth — same /trajectories* matcher as the main UI).
#
# Aufruf: bun run deploy:vps:track-import   (oder: bash scripts/deploy-vps-track-import.sh)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TRAJECTORIES_VPS_TRACK_IMPORT_DEST:-/var/www/vps/trajectories/track-import}"
if [[ "$DEST" != /* || "$DEST" == "/" ]]; then
  echo "Refusing unsafe deployment destination: $DEST" >&2
  exit 1
fi
BASE="/trajectories/track-import/"

echo "==> Baue track-import (base=${BASE}) ..."
cd "$PROJECT_DIR"
bunx vite build --config track-import/vite.config.js --base="$BASE"

# vite-plugin-cesium does path.join(outDir, "/trajectories/track-import/cesium").
# An absolute segment drops outDir, so Cesium.js never arrives in dist and the
# page throws "Cesium is not defined". Copy the prebuilt bundle in ourselves.
CESIUM_SRC="$PROJECT_DIR/node_modules/cesium/Build/Cesium"
CESIUM_DEST="$PROJECT_DIR/track-import/dist/cesium"
rm -rf "$CESIUM_DEST"
mkdir -p "$CESIUM_DEST"
cp -a "$CESIUM_SRC/Assets" "$CESIUM_SRC/ThirdParty" "$CESIUM_SRC/Workers" "$CESIUM_SRC/Widgets" "$CESIUM_SRC/Cesium.js" "$CESIUM_DEST/"

echo "==> Synchronisiere track-import/dist/ → ${DEST}/ ..."
if mkdir -p "$DEST" 2>/dev/null && [[ -w "$DEST" ]]; then
  rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/track-import/dist/" "$DEST/"
else
  sudo mkdir -p "$DEST"
  sudo rsync -a --delete --exclude=.DS_Store "$PROJECT_DIR/track-import/dist/" "$DEST/"
fi

echo "==> Fertig: https://vps.mah.priv.at/trajectories/track-import/"
echo "    (Basic Auth: user trajectories — hash in /etc/caddy/Caddyfile)"
