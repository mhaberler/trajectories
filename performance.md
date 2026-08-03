# API performance measures

Summary of work on **trajectory API latency and throughput** since `origin/main` (merge-base `849478e`, branch `flight-profile-ui` as of 2026-08-03). Focus is the Python/FastAPI service behind `https://trajectory.mah.priv.at` and how the web UI uses it.

## Problem

The first local Open-Meteo (`.om`) backend read wind **point-by-point** from disk. On the **`basic_trajectory` smoke case** (Stubenberg, ICON-D2, 2 h, three AGL heights, 10 min markers, `met_extras`), that path took **~48 s** wall time vs **~9 s** over HTTP — unusable for production API.

Goal: **OM backend ≤ HTTP** on typical requests, with **warm unique requests ≈ 1 s** (response cache off).

## Results (smoke case, `compute_trajectories` only)

Stubenberg `47.23, 15.82`; ICON-D2; `2026-08-02T11:00:00Z`; 2 h; heights 500/1500/3000 m AGL; method `height`; markers 10 min; `met_extras=True`. Cache disabled (`TRAJECTORIES_CACHE_MAX=0`).

| Stage | OM backend | HTTP backend |
|-------|------------|--------------|
| Point-fetch OM (baseline) | **47.7 s** | 8.9 s |
| Per-request **slab preload** | ~8.6 s cold / ~5.9 s warm | ~9.0 s |
| **Reader cache + Numba + parallel tracks** | **~1.9 s cold / ~0.92 s warm** | unchanged |

See also [`PYTHON-MODULE.md`](PYTHON-MODULE.md) § “Timing — basic_trajectory inputs”.

---

## Server-side compute (Python / FastAPI)

### 1. Trajectory HTTP API (`942c136`)

- **`GET /v1/trajectory`** — GeoJSON FeatureCollection (same as CLI/library).
- **`GET /v1/wind`** — single-point wind sample (`f0d96f1`).
- Deploy: uvicorn on `:8010`, Caddy reverse proxy, systemd unit (`deploy/`).

Moves heavy work off the browser onto one server with shared local data.

### 2. Dual wind backend — HTTP vs local OM (`b584216`)

- **`--backend auto`** (default): use local `.om` chunks under `TRAJECTORIES_OM_ROOT` (default `/open-meteo` if present), else Open-Meteo HTTP.
- AGL from `static/hhl.om − HSURF.om` (no per-level `height_agl_*` on disk).
- Horizontal wind already m/s on OM (HTTP path still converts km/h).

Files: [`python/trajectories/windfield.py`](python/trajectories/windfield.py), [`python/trajectories/config.py`](python/trajectories/config.py).

### 3. Per-request OM slab preload (`c2b0cfe`)

Instead of one disk read per wind query corner:

- On `WindField.init`, **preload a padded lat/lon/time/level window** into RAM (`OmSlab`).
- **Spatial pad**: half-extent from start ≈ wind speed × duration, clamped **50–120 km** (`SLAB_PAD_KM_*`, `SLAB_SPEED_KMH=40`).
- **Time window**: trajectory span ±1 h.
- **Height bands**: low ≤2.5 km AGL; add high band ≤6.5 km if `max_height > 2000 m`.
- **`wind_at` / `request`** served from slab via `request_from_slab`; corners outside slab fall back to point-fetch.
- **Process-warmed `OmBackend`**: meta/grid/fs reused via `get_om_backend()`.

Files: [`python/trajectories/om_backend.py`](python/trajectories/om_backend.py) (`load_slab`, `request_from_slab`), [`python/trajectories/windfield.py`](python/trajectories/windfield.py).

### 4. Reader cache, slab LRU, parallel I/O (`b3bf5d0`)

**`OmReaderCache`** ([`python/trajectories/om_reader_cache.py`](python/trajectories/om_reader_cache.py)):

- Keep **`.om` readers open** (mmap), LRU cap (`TRAJECTORIES_OM_READER_CACHE`, default 64).
- **Per-path mutex** for thread-safe reads.
- **inotify** (watchdog) invalidation when cached chunk files change.
- **`SlabStaleError`** + **retries** (`SLAB_LOAD_RETRIES=3`) if a file changes mid-load.

**Slab reuse**:

- Process-wide **slab LRU** (`_SLAB_CACHE`, max 8 entries) keyed by request geometry.

**Parallel slab load**:

- Up to **`SLAB_LOAD_WORKERS=16`** threads loading chunk variables concurrently.

**Parallel trajectory tracks**:

- After slab load, **height×method jobs** run in `ThreadPoolExecutor` (`TRACK_WORKERS=8` in [`python/trajectories/compute.py`](python/trajectories/compute.py)).

### 5. Numba height-path interpolation (`b3bf5d0`, `767e80a`)

- Optional **`trajectories[accel]`** extra: [`python/trajectories/interp_fast.py`](python/trajectories/interp_fast.py).
- JIT for vertical interpolation on the **height** integration path; Python fallback if Numba missing.
- **`cache=False`** on `@njit` so editable installs (`pip -e`) do not fail on missing source locators (`767e80a`).

Install: `pip install -e "python/[om,api,accel]"`.

### 6. In-process API response cache (`b3bf5d0`)

- [`python/trajectories/response_cache.py`](python/trajectories/response_cache.py) — TTL/LRU GeoJSON cache for `/v1/trajectory` and `/v1/wind`.
- Env: **`TRAJECTORIES_CACHE_TTL_S`** (default 1800), **`TRAJECTORIES_CACHE_MAX`** (default 64; **0 disables**).
- Wired in [`python/trajectories/api.py`](python/trajectories/api.py).
- **Not** counted toward the ≤1 s unique-latency benchmark (cache hit path is faster by design).

### 7. Fewer OM variables — Magnus RH (`627a627`)

- With `--met-extras`, **relative humidity and dewpoint** derived from **specific humidity q + p + T** (Magnus over water) instead of fetching model `relative_humidity_level*` from disk/API.
- Cuts I/O and slab size for met-enabled runs.

### 8. Input validation / early reject (`3f6d70c`)

- Reject non-finite floats at API boundary (fail fast, avoid wasted compute).
- Not a speedup on valid requests; avoids bad work.

---

## Wire / edge

### 9. Caddy gzip and zstd (`c7636db`)

- [`deploy/Caddyfile.trajectory.snippet`](deploy/Caddyfile.trajectory.snippet): `encode gzip zstd` on `trajectory.mah.priv.at`.
- Compresses large GeoJSON **on the wire** (no gzip middleware in FastAPI).
- Verify: `curl -H 'Accept-Encoding: gzip, zstd' … | grep -i content-encoding` ([`deploy/README.md`](deploy/README.md)).

---

## Client (web UI)

### 10. Server-side trajectories instead of browser integrator (`54260a2`)

- **“API abrufen”** default: one HTTP call replaces many Open-Meteo fetches + in-browser integration.
- **`AbortSignal.timeout(120000)`** on trajectory fetch (`3f6d70c`) — bounded wait, not faster but safer.

### 11. Debounced profile API redraw (`a98f5db`+)

- Flugprofil edits call **`scheduleProfileRedraw`** — **500 ms debounce** before `GET /v1/trajectory`.
- **`profileRedraw` + `profileRedrawGen`**: stale responses discarded if user edits again during flight.
- **`keepSiblings`**: redraw only the candidate track while editing (less DOM/map churn; still one API round-trip).

### 12. Latency visibility (`767e80a`, `033f0fa`)

- Status line shows **API wall time** (`API: … · 1.15 s`) and browser compute time for comparison.

---

## Benchmarking and tests

| Tool | Purpose |
|------|---------|
| [`python/benchmarks/bench_om_strategies.py`](python/benchmarks/bench_om_strategies.py) | Manual cold/warm OM timing; `--repeats`, `--concurrent` |
| `RUN_OM_TESTS=1 pytest python/tests/test_om_backend.py -m om` | OM vs HTTP same-physics (loose distance bounds; widened for float32/Numba) |
| `pytest python/tests/test_om_slab.py` | Slab hit/miss, prefer-slab-over-point-readers |
| `pytest python/tests/test_om_reader_cache.py` | Stale slab / invalidation |

Example:

```bash
cd python
TRAJECTORIES_CACHE_MAX=0 TRAJECTORIES_BACKEND=om \
  python benchmarks/bench_om_strategies.py --repeats 3
```

---

## Configuration reference

| Variable | Default | Role |
|----------|---------|------|
| `TRAJECTORIES_BACKEND` | `auto` | `om` \| `http` \| `auto` |
| `TRAJECTORIES_OM_ROOT` | `/open-meteo` if exists | Local `.om` tree |
| `TRAJECTORIES_CACHE_MAX` | 64 (0=off) | Response cache entries |
| `TRAJECTORIES_CACHE_TTL_S` | 1800 | Response cache TTL |
| `TRAJECTORIES_OM_READER_CACHE` | 64 | Max open `.om` readers |
| `TRAJECTORIES_API_BASE` | open-meteo proxy | HTTP wind fallback |

---

## Commit map (performance-related, `origin/main..HEAD`)

| Commit | Summary |
|--------|---------|
| `b584216` | Dual HTTP/local OM backend |
| `942c136` | FastAPI `/v1/trajectory`, deploy |
| `c2b0cfe` | OM slab preload |
| `b3bf5d0` | Reader cache, slab LRU, parallel tracks, Numba, response cache, benchmark |
| `767e80a` | Numba `cache=False`; UI API latency |
| `627a627` | Magnus RH from q (less OM I/O) |
| `c7636db` | Caddy gzip/zstd |
| `54260a2` | Web UI API fetch path |
| `3f6d70c` | Fetch timeout; API input validation |
| `a98f5db`+ | Flugprofil UI: debounced profile API redraw |

Later commits on `flight-profile-ui` (interactive profile editor, resize, time-drag) are **UX**; they use the same debounced API pattern above.

---

## Not in scope / deferred

- Response cache as primary latency strategy for **unique** requests (benchmark bar excludes it).
- Further Numba beyond height-path interp (Phase E “10×” items in planning notes).
- Map-side time-drag of profile handles (no extra API pattern).
- FastAPI-level gzip (delegated to Caddy).

For architecture and API parameters, see [`PYTHON-MODULE.md`](PYTHON-MODULE.md).
