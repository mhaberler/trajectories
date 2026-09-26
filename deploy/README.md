# Deploy on this VPS

## Web UI (`vps.mah.priv.at/trajectories`)

Static Vite build behind Caddy Basic Auth (username **`trajectories`**).

```bash
cd /home/mah/src/trajectories
bun install
bun run deploy:vps           # builds with base=/trajectories/ → /var/www/vps/trajectories/
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

The trajectory HTTP API is a separate repository, [trajectories-api](https://github.com/mhaberler/trajectories-api). The UI “API abrufen” option calls the running instance at `https://trajectory.mah.priv.at` (no Basic Auth).
