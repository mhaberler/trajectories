#!/usr/bin/env python3
"""Query ICON global / EU / D2 for a few model-level vars over HTTP.

Uses each model's configured Open-Meteo base + path from ``trajectories.config``
(icon_global → open-meteo-temp ``/v1/dwd-icon``; D2/EU → main ``/v1/forecast``).

Usage (from repo root):
  source python/.venv/bin/activate
  python python/examples/compare_icon_models.py [lat] [lon]

Env:
  TRAJECTORIES_API_BASE              default host for D2/EU
  TRAJECTORIES_ICON_GLOBAL_API_BASE  host for icon_global
"""

from __future__ import annotations

import json
import sys
from urllib.parse import urlencode

import httpx

from trajectories import config

LAT = float(sys.argv[1]) if len(sys.argv) > 1 else 47.8
LON = float(sys.argv[2]) if len(sys.argv) > 2 else 16.2

# A few full-level Heidi vars near the boundary layer + surface-ish W on half levels.
MODELS = ("icon_global", "icon_eu", "icon_d2")


def hourly_vars(model_key: str) -> list[str]:
    m = config.MODELS[model_key]
    n = int(m["nLevels"])
    half = int(m.get("nHalfLevels") or (n + 1))
    # Full levels: near-surface and one mid-troposphere sample
    full = (n, max(1, n - 20))
    vars_ = []
    for l in full:
        vars_.extend(
            [
                f"wind_u_component_level{l}",
                f"wind_v_component_level{l}",
                f"height_agl_level{l}",
                f"temperature_level{l}",
            ]
        )
    # W + half-level AGL near the surface (see open-meteo wind_w_profile.py)
    for l in (half, half - 1, half - 5):
        if l >= 1:
            vars_.append(f"wind_w_level{l}")
            vars_.append(f"height_half_agl_level{l}")
    # de-dupe, keep order
    seen: set[str] = set()
    out: list[str] = []
    for v in vars_:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def query_model(client: httpx.Client, model_key: str) -> dict:
    m = config.MODELS[model_key]
    url = config.model_forecast_url(model_key)
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": ",".join(hourly_vars(model_key)),
        "models": m["apiModel"],
        "forecast_hours": 2,
        "windspeed_unit": "ms",
        "timeformat": "unixtime",
    }
    full = f"{url}?{urlencode(params)}"
    print(f"\n=== {model_key} ({m['label']}) ===", file=sys.stderr)
    print(f"GET {full}", file=sys.stderr)
    resp = client.get(url, params=params)
    try:
        data = resp.json()
    except Exception:
        print(f"HTTP {resp.status_code}: non-JSON body:\n{resp.text[:500]}", file=sys.stderr)
        return {"model": model_key, "error": True, "reason": f"HTTP {resp.status_code}"}
    if not resp.is_success or (isinstance(data, dict) and data.get("error")):
        reason = data.get("reason") if isinstance(data, dict) else resp.text[:200]
        return {"model": model_key, "error": True, "reason": reason, "http": resp.status_code}

    h = data.get("hourly") or {}
    units = data.get("hourly_units") or {}
    # Prefer the second timestep (one hour ahead), else first.
    ti = 1 if len(h.get("time") or []) > 1 else 0
    sample = {
        "model": model_key,
        "apiModel": m["apiModel"],
        "url": url,
        "latitude": data.get("latitude"),
        "longitude": data.get("longitude"),
        "elevation_m": data.get("elevation"),
        "time": (h.get("time") or [None])[ti],
        "vars": {},
    }
    for name, series in h.items():
        if name == "time" or not isinstance(series, list):
            continue
        val = series[ti] if ti < len(series) else None
        sample["vars"][name] = {"value": val, "unit": units.get(name)}
    return sample


def main() -> int:
    results = []
    with httpx.Client(timeout=60.0, trust_env=False) as client:
        for key in MODELS:
            if key not in config.MODELS:
                print(f"skip unknown model {key}", file=sys.stderr)
                continue
            results.append(query_model(client, key))

    print(json.dumps({"lat": LAT, "lon": LON, "models": results}, indent=2))

    ok = sum(1 for r in results if not r.get("error"))
    print(f"\n# {ok}/{len(results)} model(s) ok", file=sys.stderr)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
