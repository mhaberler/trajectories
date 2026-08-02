# trajectories (Python)

Installable port of the web app compute pipeline: Open-Meteo ICON-EU / ICON-D2
→ Petterssen trajectories → GeoJSON (SimpleStyle).

## Install

```bash
python3 -m venv python/.venv
source python/.venv/bin/activate
pip install -e "python/[dev]"
playwright install chromium   # for Windy / web↔Python visual tests
npm install                   # Vite — required for web↔Python compare
```

For local `.om` acceleration (optional):

```bash
pip install -e "python/[om]"   # or use [dev], which includes omfiles
```

## Data backends

| Mode | How |
|------|-----|
| `auto` (default) | Prefer local OM under `TRAJECTORIES_OM_ROOT` (default `/open-meteo` if present); else HTTP |
| `om` | Require local files + `omfiles` |
| `http` | Open-Meteo forecast API only |

```bash
# force HTTP even when /open-meteo exists
trajectories ... --backend http

# force local
trajectories ... --backend om --om-root /open-meteo
```

Env: `TRAJECTORIES_BACKEND`, `TRAJECTORIES_OM_ROOT` (empty string disables auto-detect), `TRAJECTORIES_API_BASE`.

**Note:** Local trees have model-level specific humidity but no `relative_humidity_level*`. With `--met-extras` on the OM backend, marker dewpoint uses **q** only; RH on markers may be missing/NaN.

## CLI

```bash
trajectories \
  --lat 47.23 --lon 15.82 \
  --time 2026-07-23T05:00:00Z \
  --model icon_d2 \
  --duration 2 \
  --height 500 --height 1500 \
  --method height \
  --height-ref agl \
  -o out.geojson
```

Stdout by default. Override API with `--api-base` or `TRAJECTORIES_API_BASE`.

## Library

```python
from trajectories import compute_trajectories

gj = compute_trajectories(
    lat=47.23, lon=15.82,
    time="2026-07-23T05:00:00Z",
    model="icon_d2",
    duration_h=2,
    heights=[500, 1500],
    methods=["height"],
    backend="auto",  # or "om" / "http"
)
```

## Tests

```bash
pytest python/tests/test_integrator_unit.py
pytest python/tests/test_backend_resolve.py

# Local OM smoke + loose OM↔HTTP compare (needs /open-meteo + omfiles)
RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om

# Rough visual equivalence vs Windy built-in trajectories (ICON-D2 + ICON-EU).
# Driver: wind layer → model → right-click → "Wind trajectories" → capture API paths.
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
# Debug UI: WINDY_HEADED=1 RUN_WINDY_TESTS=1 pytest ... -m windy

# Near-exact web app GeoJSON download vs Python (≤50 m). Spawns Vite + Playwright.
RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py
# Debug UI: WEB_PY_HEADED=1 RUN_WEB_PY_TESTS=1 pytest ... -m web_py
```
