#!/usr/bin/env python3
"""Cold/warm DEM /v1/elevation/line latency matrix.

Usage:
  python scripts/bench_dem_line.py [--base URL] [--cache-dir PATH] [--clear-cmd CMD]
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# WGS84 approx metres per degree at mid-latitudes
R_EARTH_KM = 6371.0


def dest_point(lat: float, lon: float, bearing_deg: float, dist_km: float) -> tuple[float, float]:
    br = math.radians(bearing_deg)
    d = dist_km / R_EARTH_KM
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(br)
    )
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), ((math.degrees(lon2) + 540) % 360) - 180


def build_points(n: int, dist_km: float, *, lat0: float, lon0: float, bearing: float) -> list[dict]:
    """N vertices evenly spaced along a geodesic of length dist_km."""
    pts: list[dict] = []
    for i in range(n):
        frac = i / (n - 1) if n > 1 else 0.0
        lat, lon = dest_point(lat0, lon0, bearing, dist_km * frac)
        pts.append({"lat": lat, "lon": lon, "t_sec": float(i * 15)})
    return pts


def clear_cache(cache_dir: Path, clear_cmd: str | None) -> None:
    if clear_cmd:
        subprocess.run(clear_cmd, shell=True, check=True)
        return
    if not cache_dir.exists():
        return
    for child in cache_dir.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)


def post_line(base: str, points: list[dict], timeout: float = 300.0) -> tuple[float, dict]:
    body = json.dumps({"points": points, "interval_sec": 15}).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/v1/elevation/line",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    elapsed = time.perf_counter() - t0
    try:
        data = json.loads(raw.decode())
    except json.JSONDecodeError:
        data = {"error": raw[:200].decode(errors="replace"), "http_status": status}
    if status >= 400:
        data = {**data, "http_status": status}
    return elapsed, data


def summarize(data: dict) -> dict:
    props = data.get("properties") or {}
    stats = props.get("dem_stats") or {}
    features = data.get("features") or []
    elevs = [
        f.get("properties", {}).get("elevation")
        for f in features
        if isinstance(f.get("properties"), dict)
    ]
    elevs_f = [float(e) for e in elevs if e is not None]
    return {
        "backend": props.get("dem_backend"),
        "n_elev": props.get("count", len(features)),
        "mean_elev": round(sum(elevs_f) / len(elevs_f), 1) if elevs_f else None,
        "unique_tiles": stats.get("unique_tiles"),
        "cache_hits": stats.get("cache_hits", stats.get("disk_hits")),
        "cache_misses": stats.get("disk_misses"),
        "http_gets": stats.get("http_gets", stats.get("http_ranges")),
        "http_bytes": stats.get("http_bytes"),
        "http_ms": stats.get("http_ms", stats.get("fetch_ms")),
        "decode_ms": stats.get("decode_ms"),
        "sample_ms": stats.get("sample_ms"),
        "total_ms": stats.get("total_ms"),
        "zoom_misses": stats.get("zoom_misses"),
        "http_status": data.get("http_status"),
        "error": data.get("error") or data.get("detail"),
        "dem_stats": stats or None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8010")
    ap.add_argument("--cache-dir", default="/var/cache/trajectories/joerd")
    ap.add_argument(
        "--clear-cmd",
        default=None,
        help="Shell command to clear cache (e.g. sudo rm -rf .../terrarium)",
    )
    ap.add_argument("--points", default="10,100,1000")
    ap.add_argument("--distances", default="10,100,1000")
    ap.add_argument("--lat0", type=float, default=47.0)
    ap.add_argument("--lon0", type=float, default=11.0)
    ap.add_argument(
        "--out",
        default="bench_dem_line_results.json",
        help="JSON results path",
    )
    args = ap.parse_args()

    ns = [int(x) for x in args.points.split(",") if x.strip()]
    ds = [float(x) for x in args.distances.split(",") if x.strip()]
    cache_dir = Path(args.cache_dir)

    rows: list[dict] = []
    print(
        f"{'n':>5} {'km':>6} {'phase':>5} {'wall_s':>8} {'elev':>5} "
        f"{'z_mean':>7} {'tiles':>5} {'hits':>5} {'gets':>5}",
        flush=True,
    )

    cell = 0
    for dist_km in ds:
        for n in ns:
            # Isolate corridors (~2° lat apart) so cold cells don't share z12 tiles.
            lat0 = args.lat0 + cell * 2.0
            lon0 = args.lon0 + (dist_km / 111.0) * 0.05
            cell += 1
            points = build_points(n, dist_km, lat0=lat0, lon0=lon0, bearing=90.0)

            if args.clear_cmd:
                clear_cache(cache_dir, args.clear_cmd)
            time.sleep(0.15)

            for phase in ("cold", "warm"):
                wall, data = post_line(args.base, points)
                s = summarize(data)
                row = {
                    "n_points": n,
                    "distance_km": dist_km,
                    "phase": phase,
                    "wall_s": round(wall, 3),
                    **s,
                }
                rows.append(row)
                err = s.get("error")
                if err:
                    print(
                        f"{n:5d} {dist_km:6.0f} {phase:>5} {wall:8.3f} ERROR {err!r}",
                        flush=True,
                    )
                else:
                    n_elev = s.get("n_elev")
                    z_mean = s.get("mean_elev")
                    tiles = s.get("unique_tiles")
                    hits = s.get("cache_hits")
                    gets = s.get("http_gets")
                    print(
                        f"{n:5d} {dist_km:6.0f} {phase:>5} {wall:8.3f} "
                        f"{n_elev if n_elev is not None else '-':>5} "
                        f"{z_mean if z_mean is not None else '-':>7} "
                        f"{tiles if tiles is not None else '-':>5} "
                        f"{hits if hits is not None else '-':>5} "
                        f"{gets if gets is not None else '-':>5}",
                        flush=True,
                    )

    out = Path(args.out)
    out.write_text(json.dumps(rows, indent=2) + "\n")
    print(f"\nWrote {out.resolve()}", flush=True)

    # Markdown summary table (wall seconds)
    print("\n## Wall time (s)\n")
    print("| points | km | cold | warm | speedup |")
    print("| ---: | ---: | ---: | ---: | ---: |")
    by_key = {(r["n_points"], r["distance_km"], r["phase"]): r for r in rows}
    for dist_km in ds:
        for n in ns:
            c = by_key[(n, dist_km, "cold")]["wall_s"]
            w = by_key[(n, dist_km, "warm")]["wall_s"]
            sp = (c / w) if w > 0 else float("inf")
            print(f"| {n} | {dist_km:g} | {c:.3f} | {w:.3f} | {sp:.1f}x |")

    return 0


if __name__ == "__main__":
    sys.exit(main())
