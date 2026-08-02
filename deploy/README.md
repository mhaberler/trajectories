# Deploy on this VPS

## Web UI (`vps.mah.priv.at/trajectories`)

Static Vite build behind Caddy Basic Auth (username **`trajectories`**).

```bash
cd /home/mah/src/trajectories
bun install
bun run deploy:vps   # builds with base=/trajectories/ → /var/www/vps/trajectories/
```

Caddy — merge the directives from [`Caddyfile.vps-trajectories.snippet`](Caddyfile.vps-trajectories.snippet) into the existing `vps.mah.priv.at` site block. Set the password hash once:

```bash
caddy hash-password --plaintext 'YOUR_PASSWORD'
# paste hash into basic_auth { trajectories <hash> }
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -sS -o /dev/null -w '%{http_code}\n' -u trajectories:YOUR_PASSWORD \
  https://vps.mah.priv.at/trajectories/
```

The trajectory HTTP API stays on `trajectory.mah.priv.at` (no Basic Auth); the UI “API abrufen” option calls it cross-origin.

---

## Trajectories API (`trajectory.mah.priv.at`)

Domain: `trajectory.mah.priv.at` → reverse-proxy to uvicorn on `127.0.0.1:8010`.

## 1. App deps

```bash
cd /home/mah/src/trajectories
source python/.venv/bin/activate
pip install -e "python/[api,om]"
```

## 2. systemd

Runs as user `openmeteo-api`. Grant traverse on `/home/mah` (home is mode 700):

```bash
sudo setfacl -m u:openmeteo-api:--x /home/mah
sudo cp deploy/trajectories-api.service /etc/systemd/system/
sudo cp deploy/trajectories-api.env.example /etc/default/trajectories-api.env   # optional
sudo systemctl daemon-reload
sudo systemctl enable --now trajectories-api.service
sudo systemctl status trajectories-api.service
curl -sS http://127.0.0.1:8010/health
```

## 3. Caddy

Append the stanza from [`Caddyfile.trajectory.snippet`](Caddyfile.trajectory.snippet) to `/etc/caddy/Caddyfile`, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -sS https://trajectory.mah.priv.at/health
# Swagger: https://trajectory.mah.priv.at/docs
```
