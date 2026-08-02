# trajectories (Python)

Installable port of the web app compute pipeline: Open-Meteo ICON-EU / ICON-D2
→ Petterssen trajectories → GeoJSON (SimpleStyle).

## Install

```bash
python3 -m venv python/.venv
source python/.venv/bin/activate
pip install -e "python/[dev]"
playwright install chromium   # only for Windy visual tests
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

# Rough visual equivalence vs Windy built-in / traj plugin (ICON-D2 + ICON-EU):
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
```
