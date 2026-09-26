# Deploy on this VPS

## Web UI (`vps.mah.priv.at/trajectories`)

Static Vite build behind Caddy Basic Auth (username **`trajectories`**).

```bash
cd /home/mah/src/trajectories
bun install
bun run deploy:vps           # builds with base=/trajectories/ → mah@vps.mah.priv.at:/var/www/vps/trajectories/
bun run deploy:vps:coloring  # track-import → /var/www/vps/trajectories/coloring/
                             # https://vps.mah.priv.at/trajectories/coloring/
```

`deploy:vps` rsync `--delete` excludes `coloring/` so the main UI deploy does not wipe the playground. Same Basic Auth (`/trajectories*`).

Caddy — merge the directives from [`Caddyfile.vps-trajectories.snippet`](Caddyfile.vps-trajectories.snippet) into the existing `vps.mah.priv.at` site block. Set the password hash once:

```bash
caddy hash-password --plaintext 'YOUR_PASSWORD'
# paste hash into basic_auth { trajectories <hash> }
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -sS -o /dev/null -w '%{http_code}\n' -u trajectories:YOUR_PASSWORD \
  https://vps.mah.priv.at/trajectories/
curl -sS -o /dev/null -w '%{http_code}\n' -u trajectories:YOUR_PASSWORD \
  https://vps.mah.priv.at/trajectories/coloring/
```

The trajectory HTTP API stays on `trajectory.mah.priv.at` (no Basic Auth); the UI “API abrufen” option calls it cross-origin.

---

## Trajectories API

The HTTP API, Python package, and API deploy files live in [trajectory-api](https://github.com/mhaberler/trajectory-api) (`/home/mah/src/trajectory-api`).

The live systemd unit on this VPS still runs `/home/mah/src/trajectories/python` until that checkout is cut over. Pulling this branch on the server removes that tree; do not pull it there until the unit points at `trajectory-api`.
