# Python trajectories module

Port of the web app compute pipeline to an installable Python package + CLI.
Same inputs → same GeoJSON trajectories (Petterssen integration over Open-Meteo ICON fields).

## Goals

- Functional parity with the browser app (`src/windfield.js`, `src/integrator.js`, `src/app.js` export).
- Library API (`compute_trajectories`) and CLI (`trajectories`).
- GeoJSON FeatureCollection with SimpleStyle (`stroke` / `marker-color`) for Placemark tools.
- Tests that prove the port: unit (offline), near-exact vs web UI, rough vs Windy.

## Layout

```
python/
  pyproject.toml          # package trajectories, CLI entry, pytest markers
  README.md               # install / CLI / test recipes
  trajectories/
    config.py             # models, methods, API/OM backend resolution
    windfield.py          # HTTP or local OM client + 4-D interpolation
    om_backend.py         # omfiles reader for /open-meteo rolling chunks
    integrator.py         # Petterssen + adaptive dt + markers
    compute.py            # height × method orchestration → FeatureCollection
    geojson_export.py     # port of web buildGeoJSON
    cli.py / __main__.py
  tests/
    test_integrator_unit.py   # fake-wind Petterssen (always on)
    test_backend_resolve.py   # OM/HTTP resolution (always on)
    test_om_backend.py        # local OM smoke + OM↔HTTP (opt-in)
    test_web_python.py        # web download vs Python (opt-in)
    test_windy_visual.py      # Python vs Windy paths (opt-in)
    web_driver.py             # Vite + Playwright → #download GeoJSON
    windy_driver.py           # Playwright → Windy Wind trajectories API → GPX
    compare_metrics.py        # pairing + haversine / along-track metrics
```

Default API: `https://open-meteo.mah.priv.at` (`TRAJECTORIES_API_BASE` / `--api-base`).
`httpx` uses `trust_env=False` so system proxies do not 403 the private host.

## Design choices (locked)

| Topic | Choice |
|--------|--------|
| Shape | Installable package + library + CLI under `python/` |
| Fidelity | 1:1 JS port (pure Python floats + httpx) |
| Methods | Full set: `height`, `pressure`, `theta`, `z3d` |
| Series | Multi-height × multi-method Cartesian product |
| I/O | stdout GeoJSON; optional `--output` |
| Met extras | `--met-extras` off by default |

## Install & run

```bash
python3 -m venv python/.venv
source python/.venv/bin/activate
pip install -e "python/[dev]"   # includes optional omfiles for local .om reads
playwright install chromium   # for opt-in visual tests
npm install                   # Vite — web↔Python compare only

# Standalone library example (AGL ≤3 km, 10 min markers, met extras):
python python/examples/basic_trajectory.py

trajectories \
  --lat 47.23 --lon 15.82 \
  --time 2026-08-02T11:00:00Z \
  --model icon_d2 \
  --duration 2 \
  --height 500 --height 1500 --height 3000 \
  --method height \
  -o out.geojson
```

### Local OM files (preferred when present)

When `/open-meteo` (or `TRAJECTORIES_OM_ROOT`) contains `dwd_icon_d2` / `dwd_icon_eu` and `omfiles` is installed, the Python package reads wind fields from local `.om` chunks instead of HTTP (`--backend auto`). Force with `--backend om` / `--backend http`.

- AGL heights derived from `static/hhl.om` − `HSURF.om` (no `height_agl_*` on disk).
- Horizontal wind already m/s (HTTP path still converts km/h).
- `--met-extras`: local has specific humidity only — no model-level RH dirs.
- Fidelity vs HTTP: same physics, not bit-identical (`RUN_OM_TESTS=1`).
- I/O strategy (v1): same point-cache as HTTP — per-corner, per-variable `OmChunkFileReader` loads. **Not faster than HTTP yet** (see timing below); a domain slab preload would be the next acceleration step.

### Timing — `basic_trajectory` inputs (2026-08-02)

Stubenberg `47.23, 15.82`; ICON-D2; start `2026-08-02T11:00:00Z`; 2 h; heights 500/1500/3000 m AGL; markers 10 min; `met_extras=True`. Wall time for `compute_trajectories` only (GeoJSON dump omitted):

| Backend | Wall time | Tracks |
|---------|-----------|--------|
| `om`    | **47.7 s** | 3 |
| `http`  | **8.9 s**  | 3 |

HTTP ~5× faster on this host for the point-wise OM reader. Opt-in fidelity tests (`RUN_OM_TESTS=1`) still pass under a multi-km same-physics bound.

## Test strategies

### 1. Unit — integrator (always on)

**File:** `python/tests/test_integrator_unit.py`  
**What:** Synthetic homogeneous / rotational wind fields; no network.  
**Covers:** forward drift, backward inversion, closed rotation, stop-on-data-end, z3d height integration.  
**Port of:** `test/integrator.test.mjs`.

```bash
pytest python/tests/test_integrator_unit.py
pytest python/tests/test_backend_resolve.py
```

**Result:** integrator 5/5; backend resolve 8/8 passed.

### 2. Local OM vs HTTP — same physics (opt-in)

**File:** `python/tests/test_om_backend.py` (`@pytest.mark.om`)  
**Gate:** `RUN_OM_TESTS=1`  
**Needs:** `omfiles`, readable `{OM_ROOT}/dwd_icon_*`, and HTTP API for the compare leg.

**Matrix:** Stubenberg; 2 h; heights `[500, 1500, 3000]`; method `height`; models `icon_d2` + `icon_eu`.

```bash
RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om
```

**Result (2026-08-02):** **4/4 passed** (smoke + OM↔HTTP compare). Loose bounds: median &lt; 5 km, max &lt; 15 km. Artifacts `python/tests/artifacts/om_*.geojson`, `http_*.geojson`.

### 3. Near-exact — web app vs Python (opt-in)

**File:** `python/tests/test_web_python.py` (`@pytest.mark.web_py`)  
**Gate:** `RUN_WEB_PY_TESTS=1`  
**Why:** Primary fidelity check — same Open-Meteo source, same algorithm; UI export path must match CLI/library.

**Flow:**

1. Spawn Vite on repo root.
2. Playwright seeds `localStorage`, opens app, clicks **Trajektorien berechnen**, downloads GeoJSON via `#download`.
3. Python `compute_trajectories` with the **web export’s** `start_time` (web is clock source of truth).
4. Pair LineStrings by `(start_height_m, vertical_motion)`; sample every 10 min for 0…120 min; assert max haversine ≤ **50 m** and matching `status`.

**Matrix:** Stubenberg `47.23, 15.82`; heights `[500, 1500, 3000]` m AGL; method `height`; duration 2 h forward; models `icon_eu` + `icon_d2`. Markers out of scope for v1.

```bash
RUN_WEB_PY_TESTS=1 pytest python/tests/test_web_python.py -m web_py
# headed: WEB_PY_HEADED=1 …
```

**Result (2026-08-02 run):** **2/2 passed.** Max separation **0 m** on all three height pairs for both ICON-EU and ICON-D2 (sampled times). Artifacts under `python/tests/artifacts/` (`web_*.geojson`, `py_*.geojson`, `web-py-compare-map.html`).

### 4. Rough visual — Python vs Windy (opt-in)

**File:** `python/tests/test_windy_visual.py` (`@pytest.mark.windy`)  
**Gate:** `RUN_WINDY_TESTS=1`  
**Why:** External sanity check against Windy’s built-in trajectories (different vertical surfaces / integrator — not bit-identical).

**Flow:**

1. Python computes constant-height AGL tracks.
2. Playwright: wind layer → model → right-click → **Wind trajectories**; capture `node.windy.com/rplanner/v1/trajectory/paths`; convert to GPX.
3. Pair by nominal height (Windy checkboxes → pressure levels 950h/850h/700h ≈ 500/1500/3000 m).
4. Assert median separation &lt; **80 km**, max &lt; **200 km**.

```bash
RUN_WINDY_TESTS=1 pytest python/tests/test_windy_visual.py -m windy
# headed: WINDY_HEADED=1 …
```

**Result (Stubenberg, 2 h):** **2/2 passed.** Example separations: ICON-EU median ~8 km / max ~51 km; ICON-D2 median ~2 km / max ~58 km (850h / 1500 m pair is the outlier — expected when pressure ≠ constant AGL).

## Compare tooling

| Piece | Role |
|--------|------|
| `compare_metrics.py` | Parse mine GeoJSON / Windy GPX; `pair_tracks` / `pair_tracks_by_key`; `median_separation_km`; `max_separation_m` |
| `tools/compare-trajectories.html` | Manual map drop (mine GeoJSON + Windy GPX) |
| Artifacts | `python/tests/artifacts/` — GeoJSON/GPX dumps, Leaflet maps (`web-py-compare-map.html`, `compare-map.html`) |

## Status

- Package usable as CLI/library; GeoJSON matches web export shape (including SimpleStyle).
- Dual backend: local OM preferred when `/open-meteo` + `omfiles` available; HTTP fallback.
- Port fidelity vs web (HTTP path): **confirmed near-exact** (0 m on sampled points for the smoke matrix).
- OM vs HTTP: same-physics opt-in tests pass; point-wise OM I/O is currently **slower** than HTTP (~48 s vs ~9 s on `basic_trajectory` ICON-D2 case).
- Windy: rough agreement only; useful for regression, not a bit-for-bit oracle.
- Generated compare dumps live under `python/tests/artifacts/` (not committed).
