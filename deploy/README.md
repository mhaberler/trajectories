# Deploy Trajectories API on this VPS

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
