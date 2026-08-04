#!/usr/bin/env python3
"""
Reproduce ICON-D2 elevation=0 over Starnberger See on open-meteo.mah.priv.at.

Local HSURF.om is -999 (water/missing) for these cells; the forecast API exposes
that as elevation: 0.0, which breaks AGL / terrain_m in trajectories.

  source python/.venv/bin/activate
  python python/examples/repro_om_elevation_zero_lake.py

Override host:
  TRAJECTORIES_API_BASE=https://open-meteo.mah.priv.at python ...
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("TRAJECTORIES_API_BASE", "https://open-meteo.mah.priv.at").rstrip("/")

# Known bad lake probes (local HSURF == -999) vs land control nearby.
CASES = [
    ("lake", 47.90, 11.31),
    ("lake", 47.88, 11.31),
    ("lake", 47.92, 11.33),
    ("lake", 47.86, 11.29),
    ("land", 47.90, 11.25),
]


def forecast_elevation(lat: float, lon: float, model: str = "icon_d2") -> dict:
    q = urllib.parse.urlencode(
        {
            "latitude": f"{lat:.5f}",
            "longitude": f"{lon:.5f}",
            "hourly": "temperature_2m",
            "models": model,
            "forecast_days": "1",
            "cell_selection": "nearest",
        }
    )
    url = f"{BASE}/v1/forecast?{q}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def main() -> int:
    print(f"# BASE={BASE}", file=sys.stderr)
    print(
        "# curl lake:\n"
        f"curl -sS -G '{BASE}/v1/forecast' \\\n"
        "  --data-urlencode 'latitude=47.90' \\\n"
        "  --data-urlencode 'longitude=11.31' \\\n"
        "  --data-urlencode 'hourly=temperature_2m' \\\n"
        "  --data-urlencode 'models=icon_d2' \\\n"
        "  --data-urlencode 'forecast_days=1' \\\n"
        "  --data-urlencode 'cell_selection=nearest'\n",
        file=sys.stderr,
    )

    bad = 0
    land_ok = False
    for kind, lat, lon in CASES:
        try:
            d = forecast_elevation(lat, lon)
        except Exception as exc:
            print(f"error: {kind} ({lat},{lon}): {exc}", file=sys.stderr)
            return 1
        if isinstance(d, dict) and d.get("error"):
            print(f"error: {d.get('reason')}", file=sys.stderr)
            return 1
        elev = d.get("elevation")
        print(
            f"{kind:4} probe=({lat:.5f},{lon:.5f}) "
            f"cell=({d.get('latitude')},{d.get('longitude')}) elevation={elev}"
        )
        if kind == "lake" and elev is not None and float(elev) == 0.0:
            bad += 1
        if kind == "land" and elev is not None and float(elev) > 50:
            land_ok = True

    print(
        f"\n# {bad} lake cell(s) with elevation==0; land_ok={land_ok}",
        file=sys.stderr,
    )
    # Exit 0 when the upstream bug is reproduced (lake zeros + sensible land).
    return 0 if bad and land_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
