# DEM `/v1/elevation/line` performance

Cold vs warm disk-cache latency for **Joerd** (AWS Terrarium PNG, z12), **Mapterhorn** (PMTiles), and **GLO-30** (Copernicus Public 1° COG), measured 2026-08-10.

## Method

- Endpoint: `POST /v1/elevation/line` with `interval_sec=15`
- Matrix: **10 / 100 / 1000** track vertices × **10 / 100 / 1000 km** eastbound geodesics
- Region: Alps start ~`46.5°N, 10.5°E`; each cell offset by **+2° lat** so corridors do not share tiles/COGs
- **Cold**: empty on-disk cache for that backend, then first request
- **Warm**: identical request immediately after (disk + in-process open/decode LRU)
- Isolated uvicorn instances (not production `:8010`):
  - Mapterhorn → `:8011`, cache `.cache/mapterhorn-bench`
  - Joerd → `:8012`, cache `.cache/joerd-bench`
  - GLO-30 → `:8013`, cache `.cache/glo30-bench`
- Wall time is client-side `perf_counter` around the HTTP round-trip
- Repro: `scripts/bench_dem_line.py` · raw JSON under `dem-perf/`

## Wall time (seconds)

### Joerd

| points | km | cold | warm | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 0.782 | 0.004 | 196× |
| 100 | 10 | 0.333 | 0.006 | 56× |
| 1000 | 10 | 0.316 | 0.061 | 5× |
| 10 | 100 | 0.690 | 0.008 | 86× |
| 100 | 100 | 0.901 | 0.012 | 75× |
| 1000 | 100 | 1.021 | 0.057 | 18× |
| 10 | 1000 | 0.579 | 0.008 | 72× |
| 100 | 1000 | 5.127 | 0.037 | 139× |
| 1000 | 1000 | 13.021 | 1.315 | 10× |

### Mapterhorn

| points | km | cold | warm | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 1.512 | 0.008 | 189× |
| 100 | 10 | 0.432 | 0.008 | 54× |
| 1000 | 10 | 0.621 | 0.073 | 9× |
| 10 | 100 | 1.267 | 0.007 | 181× |
| 100 | 100 | 0.813 | 0.013 | 63× |
| 1000 | 100 | 1.464 | 0.060 | 24× |
| 10 | 1000 | 0.845 | 0.006 | 141× |
| 100 | 1000 | 7.917 | 0.029 | 273× |
| 1000 | 1000 | 18.246 | 2.637 | 7× |

### GLO-30

| points | km | cold | warm | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 1.552 | 0.003 | 517× |
| 100 | 10 | 2.045 | 0.014 | 146× |
| 1000 | 10 | 1.745 | 0.171 | 10× |
| 10 | 100 | 2.487 | 0.007 | 355× |
| 100 | 100 | 1.445 | 0.016 | 90× |
| 1000 | 100 | 2.170 | 0.187 | 12× |
| 10 | 1000 | 2.625 | 0.100 | 26× |
| 100 | 1000 | 5.363 | 0.578 | 9× |
| 1000 | 1000 | 7.038 | 0.732 | 10× |

## Head-to-head vs Joerd (ratio >1 = slower than Joerd)

| points | km | MH cold | MH warm | GLO cold | GLO warm |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 1.93× | 2.00× | 1.98× | 0.75× |
| 100 | 10 | 1.30× | 1.33× | 6.14× | 2.33× |
| 1000 | 10 | 1.97× | 1.20× | 5.52× | 2.80× |
| 10 | 100 | 1.84× | 0.88× | 3.60× | 0.88× |
| 100 | 100 | 0.90× | 1.08× | 1.60× | 1.33× |
| 1000 | 100 | 1.43× | 1.05× | 2.13× | 3.28× |
| 10 | 1000 | 1.46× | 0.75× | 4.53× | 12.5× |
| 100 | 1000 | 1.54× | 0.78× | 1.05× | 15.6× |
| 1000 | 1000 | 1.40× | 2.01× | **0.54×** | **0.56×** |

## Unique tiles / COGs (same corridors)

| points | km | Joerd/MH z12 tiles | GLO-30 1° COGs |
| ---: | ---: | ---: | ---: |
| 10–1000 | 10 | 3 | 1 |
| 10 | 100 | 10 | 3 |
| 100–1000 | 100 | 19–20 | 3 |
| 10 | 1000 | 10 | 10 |
| 100 | 1000 | 100 | 20 |
| 1000 | 1000 | 242 | 21 |

## Findings

1. **Cold short tracks:** Joerd wins (~0.3–0.8 s). GLO-30 pays for downloading whole ~40 MB 1° COGs (~1.5–2.5 s) even when only a few samples are needed.
2. **Cold long tracks:** GLO-30 wins on the heaviest cell (**1000 pts / 1000 km: 7.0 s** vs Joerd 13.0 s / Mapterhorn 18.2 s) because ~21 COGs beat ~242 z12 tiles.
3. **Warm:** Joerd/Mapterhorn stay **&lt;100 ms** for ≤100 km. GLO-30 warm is also fast on light cells; on **1000 km** warm is slower than Joerd for sparse samples (open many COGs) but **faster** on the densest cell (0.73 s vs 1.3 / 2.6 s).
4. **Mapterhorn** remains the slowest cold on long Alps corridors in this run; coverage can also thin out outside its archives.
5. **GLO-30** is global (missing/ocean → 0 m), ~30 m DSM, opt-in via `TRAJECTORIES_DEM_BACKEND=glo30`. Best when corridors span many km and the 1° cache can warm; weaker for tiny cold probes.
6. Production default is **`TRAJECTORIES_DEM_BACKEND=glo30`** (`:8010`).

## Re-run

```bash
# Joerd :8012, Mapterhorn :8011, GLO-30 :8013 with empty .cache/*-bench dirs
python3 scripts/bench_dem_line.py \
  --base http://127.0.0.1:8012 --lat0 46.5 --lon0 10.5 \
  --cache-dir .cache/joerd-bench \
  --clear-cmd 'rm -rf .cache/joerd-bench/*' \
  --out dem-perf/bench_dem_line_joerd.json

python3 scripts/bench_dem_line.py \
  --base http://127.0.0.1:8011 --lat0 46.5 --lon0 10.5 \
  --cache-dir .cache/mapterhorn-bench \
  --clear-cmd 'rm -rf .cache/mapterhorn-bench/*' \
  --out dem-perf/bench_dem_line_mapterhorn.json

python3 scripts/bench_dem_line.py \
  --base http://127.0.0.1:8013 --lat0 46.5 --lon0 10.5 \
  --cache-dir .cache/glo30-bench \
  --clear-cmd 'rm -rf .cache/glo30-bench/*' \
  --out dem-perf/bench_dem_line_glo30.json
```
