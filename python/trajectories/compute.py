"""Orchestration: WindField + integrator + GeoJSON — library entry point."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from . import config
from .geojson_export import build_geojson
from .integrator import compute_trajectory
from .windfield import WindField


def _parse_time(time: str | datetime | float | int) -> float:
    if isinstance(time, (int, float)):
        # seconds or ms heuristic
        return float(time) if time > 1e12 else float(time) * 1000
    if isinstance(time, datetime):
        if time.tzinfo is None:
            time = time.replace(tzinfo=timezone.utc)
        return time.timestamp() * 1000
    s = time.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


def _fmt_height(m: float) -> str:
    return f"{round(m)} m"


def make_target(
    wf: WindField,
    lat: float,
    lon: float,
    height_m: float,
    mode: str,
    vmotion: str,
    t0_ms: float,
) -> tuple[dict, str]:
    ref = mode.upper()
    if vmotion == "height":
        return {"type": "height", "mode": mode, "value": height_m}, f"{_fmt_height(height_m)} {ref}"
    d = wf.diagnose_at(lat, lon, height_m, mode, t0_ms)
    if d.get("error"):
        raise RuntimeError(d["error"])
    if vmotion == "pressure":
        return (
            {"type": "pressure", "value": d["p"]},
            f"{_fmt_height(height_m)} → {d['p']:.0f} hPa",
        )
    if vmotion == "theta":
        return (
            {"type": "theta", "value": d["theta"]},
            f"{_fmt_height(height_m)} → θ {d['theta']:.1f} K",
        )
    return (
        {"type": "z3d", "value": d["zAmsl"]},
        f"{_fmt_height(height_m)} {ref} (3D)",
    )


def compute_trajectories(
    *,
    lat: float,
    lon: float,
    time: str | datetime | float | int,
    model: str = "icon_eu",
    duration_h: float = 12,
    heights: Sequence[float] | None = None,
    methods: Sequence[str] | None = None,
    height_ref: str = "agl",
    direction: str | int = "forward",
    marker_interval_min: float = 60,
    met_extras: bool = False,
    api_base: str | None = None,
    om_root: str | None = None,
    backend: str | None = None,
    colors: Sequence[str] | None = None,
) -> dict[str, Any]:
    """
    Compute trajectories and return a GeoJSON FeatureCollection dict.

    ``methods`` may list several vertical modes; ``heights`` several start heights.
    All combinations are run into one FeatureCollection.

    Data source: ``backend`` ``auto`` (default) prefers local Open-Meteo OM files
    under ``om_root`` / ``TRAJECTORIES_OM_ROOT`` when available, else HTTP.
    """
    if api_base:
        config.set_api_base(api_base)
    if om_root is not None:
        config.set_om_root(om_root)
    if backend is not None:
        config.set_backend(backend)

    if model not in config.MODELS:
        raise ValueError(f"Unknown model: {model}")
    model_cfg = config.MODELS[model]
    backend_kind = config.resolve_backend(model)

    heights = list(heights) if heights is not None else list(config.DEFAULT_HEIGHTS)
    methods = list(methods) if methods is not None else ["height"]
    if not heights:
        raise ValueError("At least one height required")
    if not methods:
        raise ValueError("At least one method required")
    for m in methods:
        if m not in {x["key"] for x in config.METHODS}:
            raise ValueError(f"Unknown method: {m}")
    if height_ref not in ("agl", "amsl"):
        raise ValueError("height_ref must be 'agl' or 'amsl'")

    if isinstance(direction, str):
        direction_i = 1 if direction.lower() in ("forward", "fwd", "+1", "1") else -1
    else:
        direction_i = 1 if int(direction) >= 0 else -1

    duration = min(72, max(1, float(duration_h)))
    t0_ms = _parse_time(time)
    marker_interval_sec = float(marker_interval_min) * 60

    b = model_cfg["bbox"]
    if not (b["latMin"] <= lat <= b["latMax"] and b["lonMin"] <= lon <= b["lonMax"]):
        raise ValueError(f"Point outside {model_cfg['label']} domain")

    compare_mode = len(methods) > 1
    color_list = list(colors) if colors else list(config.SERIES_COLORS)
    height_colors: dict[float, str] = {}
    for i, h in enumerate(sorted(heights)):
        height_colors[h] = color_list[i % len(color_list)]

    w_prefix = None
    if "z3d" in methods:
        w_prefix = WindField.detect_w_variable(model, backend=backend_kind)
        if not w_prefix:
            raise RuntimeError("Model vertical velocity (w) not available")

    t_end = t0_ms + direction_i * duration * 3600e3
    max_h = max(heights)

    with WindField(model, w_var_prefix=w_prefix, backend=backend_kind) as wf:
        wf.init(lat, lon, max_h, t0_ms, t_end, methods, met_extras=met_extras)
        runs: list[dict] = []
        for height_m in heights:
            for method in methods:
                style = next(m for m in config.METHODS if m["key"] == method)
                color = style["color"] if compare_mode else height_colors[height_m]
                target, label = make_target(wf, lat, lon, height_m, height_ref, method, t0_ms)
                r = compute_trajectory(
                    wind_at=wf.wind_at,
                    lat0=lat,
                    lon0=lon,
                    target=target,
                    t0_ms=t0_ms,
                    duration_hours=duration,
                    direction=direction_i,
                    grid_meters=model_cfg["gridMeters"],
                    marker_interval_sec=marker_interval_sec,
                )
                runs.append({
                    "r": r,
                    "color": color,
                    "label": label,
                    "heightM": height_m,
                    "method": method,
                })

    return build_geojson(
        runs=runs,
        model_key=model,
        mode=height_ref,
        t0_ms=t0_ms,
        duration=duration,
        direction=direction_i,
    )
