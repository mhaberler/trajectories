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
)
```

## Tests

```bash
pytest python/tests/test_integrator_unit.py

# Rough visual equivalence vs Windy built-in trajectories (ICON-D2 + ICON-EU).
# Driver: wind layer → model → right-click → "Wind trajectories" → capture API paths.
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
# Debug UI: WINDY_HEADED=1 RUN_WINDY_TESTS=1 pytest ... -m windy

# Near-exact web app GeoJSON download vs Python (≤50 m). Spawns Vite + Playwright.
RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py
# Debug UI: WEB_PY_HEADED=1 RUN_WEB_PY_TESTS=1 pytest ... -m web_py
```
