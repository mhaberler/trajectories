#!/usr/bin/env bash
#
# Deploy the Vite webapp to https://vps.mah.priv.at/trajectories/
# (Caddy Basic Auth — see deploy/Caddyfile.vps-trajectories.snippet).
#
# Aufruf: bun run deploy:vps   (oder: bash scripts/deploy-vps.sh)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

TRAJECTORIES_VPS_DES="mah@vps.mah.priv.at:/var/www/vps/trajectories"

# Optional repo-root .env. Values already exported in the shell win.
if [[ -f "$PROJECT_DIR/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^[[:space:]]*export[[:space:]]+ ]]; then
      line="${line#*export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#"${key%%[![:space:]]*}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ -n "${!key+x}" ]] && continue
    val="${line#*=}"
    val="${val#"${val%%[![:space:]]*}"}"
    if [[ ${#val} -ge 2 && ( "$val" == \"*\" || "$val" == \'*\' ) ]]; then
      val="${val:1:${#val}-2}"
    fi
    printf -v "$key" '%s' "$val"
    export "$key"
  done < "$PROJECT_DIR/.env"
fi

# Empty means the public host, not a local directory on whatever machine runs the script.
DEST="${TRAJECTORIES_VPS_DEST:-mah@vps.mah.priv.at:/var/www/vps/trajectories}"
if [[ "$DEST" == *:* ]]; then
  remote_path="${DEST#*:}"
  if [[ "$remote_path" != /* || "$remote_path" == "/" ]]; then
    echo "Refusing unsafe deployment destination: $DEST" >&2
    exit 1
  fi
elif [[ "$DEST" != /* || "$DEST" == "/" ]]; then
  echo "Refusing unsafe deployment destination: $DEST" >&2
  exit 1
fi
BASE="/trajectories/"

echo "==> Baue Web-Build (base=${BASE}) ..."
cd "$PROJECT_DIR"
bunx vite build --base="$BASE"

# vite-plugin-cesium copies into dist/<base>/cesium; flatten for rsync of dist/.
if [[ -d dist/trajectories/cesium ]]; then
  rm -rf dist/cesium
  mv dist/trajectories/cesium dist/cesium
  rm -rf dist/trajectories
fi

echo "==> Synchronisiere dist/ → ${DEST}/ ..."
RSYNC=(rsync -a --delete --exclude=.DS_Store --exclude=coloring --exclude=coloring/ --exclude=track-import --exclude=track-import/)
if [[ "$DEST" == *:* ]]; then
  ssh "${DEST%%:*}" "mkdir -p $(printf %q "$remote_path")"
  "${RSYNC[@]}" "$PROJECT_DIR/dist/" "$DEST/"
elif mkdir -p "$DEST" 2>/dev/null && [[ -w "$DEST" ]]; then
  "${RSYNC[@]}" "$PROJECT_DIR/dist/" "$DEST/"
else
  sudo mkdir -p "$DEST"
  sudo "${RSYNC[@]}" "$PROJECT_DIR/dist/" "$DEST/"
fi

echo "==> Fertig: https://vps.mah.priv.at/trajectories/"
echo "    (Basic Auth: user trajectories — hash in /etc/caddy/Caddyfile)"
