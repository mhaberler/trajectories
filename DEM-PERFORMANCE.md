# DEM `/v1/elevation/line` performance

Cold vs warm disk-cache latency for **Joerd** (AWS Terrarium PNG, fixed z12) and **Mapterhorn** (PMTiles), measured 2026-08-10.

## Method

- Endpoint: `POST /v1/elevation/line` with `interval_sec=15`
- Matrix: **10 / 100 / 1000** track vertices × **10 / 100 / 1000 km** eastbound geodesics
- Region: Alps start ~`46.5°N, 10.5°E`; each cell offset by **+2° lat** so corridors do not share z12 tiles
- **Cold**: empty on-disk tile cache for that backend, then first request
- **Warm**: identical request immediately after (disk + in-process decode LRU)
- Isolated uvicorn instances (not production `:8010`):
  - Joerd → `:8012`, cache `.cache/joerd-bench`
  - Mapterhorn → `:8011`, cache `.cache/mapterhorn-bench`
- Wall time is client-side `perf_counter` around the HTTP round-trip
- Repro: `scripts/bench_dem_line.py` · raw JSON: `bench_dem_line_joerd.json`, `bench_dem_line_mapterhorn.json`

## Wall time (seconds)

### Joerd

| points | km | cold | warm | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0.686 | 0.004 | 172× |
| 100 | 10 | 0.296 | 0.005 | 59× |
| 1000 | 10 | 0.271 | 0.068 | 4× |
| 10 | 100 | 0.635 | 0.007 | 91× |
| 100 | 100 | 0.913 | 0.010 | 91× |
| 1000 | 100 | 1.017 | 0.073 | 14× |
| 10 | 1000 | 0.568 | 0.007 | 81× |
| 100 | 1000 | 5.006 | 0.024 | 209× |
| 1000 | 1000 | 12.834 | 1.289 | 10× |

### Mapterhorn

| points | km | cold | warm | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0.695 | 0.006 | 116× |
| 100 | 10 | 0.351 | 0.008 | 44× |
| 1000 | 10 | 0.721 | 0.056 | 13× |
| 10 | 100 | 1.205 | 0.005 | 241× |
| 100 | 100 | 0.828 | 0.010 | 83× |
| 1000 | 100 | 1.115 | 0.087 | 13× |
| 10 | 1000 | 0.919 | 0.008 | 115× |
| 100 | 1000 | 8.009 | 0.021 | 381× |
| 1000 | 1000 | 16.712 | 2.573 | 6.5× |

## Head-to-head (Mapterhorn / Joerd)

| points | km | cold ratio | warm ratio |
| ---: | ---: | ---: | ---: |
| 10 | 10 | 1.01× | 1.50× |
| 100 | 10 | 1.19× | 1.60× |
| 1000 | 10 | 2.66× | 0.82× |
| 10 | 100 | 1.90× | 0.71× |
| 100 | 100 | 0.91× | 1.00× |
| 1000 | 100 | 1.10× | 1.19× |
| 10 | 1000 | 1.62× | 1.14× |
| 100 | 1000 | 1.60× | 0.88× |
| 1000 | 1000 | 1.30× | 2.00× |

Ratio `>1` means Mapterhorn is slower.

## Unique tiles (same corridors)

Both backends touched the same number of z12 tiles per cell (distance-dominated):

| points | km | unique tiles |
| ---: | ---: | ---: |
| 10–1000 | 10 | 3 |
| 10 | 100 | 10 |
| 100–1000 | 100 | 19–20 |
| 10 | 1000 | 10 |
| 100 | 1000 | 100 |
| 1000 | 1000 | 242 |

## Findings

1. **Cold cost tracks distance (unique tiles), not sample count**, until the longest / densest cells. Short tracks (10 km, ~3 tiles) finish cold in ~0.3–0.7 s for both backends.
2. **Warm is usually &lt;100 ms** for ≤100 km. The outlier is **1000 pts / 1000 km**: Joerd ~1.3 s, Mapterhorn ~2.6 s (242 tiles, decode-bound).
3. **Joerd is faster cold on long tracks** in this run (1000 km: ~5–13 s vs Mapterhorn ~8–17 s). Short tracks are roughly tied.
4. **Warm is mixed**: Mapterhorn sometimes edges out Joerd on light cells; Joerd is ~2× faster on the heaviest warm cell.
5. **Coverage**: Mapterhorn can return fewer samples / empty lines outside its archives (seen earlier on NZ corridors). Joerd Terrarium is effectively global. Prefer Joerd when geographic coverage matters; both are fine over the Alps for this matrix.
6. Production default remains **`TRAJECTORIES_DEM_BACKEND=joerd`** (`:8010`).

## Re-run

```bash
# terminals: Joerd :8012 and Mapterhorn :8011 with empty .cache/*-bench dirs
python3 scripts/bench_dem_line.py \
  --base http://127.0.0.1:8012 --lat0 46.5 --lon0 10.5 \
  --cache-dir .cache/joerd-bench \
  --clear-cmd 'rm -rf .cache/joerd-bench/*' \
  --out bench_dem_line_joerd.json

python3 scripts/bench_dem_line.py \
  --base http://127.0.0.1:8011 --lat0 46.5 --lon0 10.5 \
  --cache-dir .cache/mapterhorn-bench \
  --clear-cmd 'rm -rf .cache/mapterhorn-bench/*' \
  --out bench_dem_line_mapterhorn.json
```
