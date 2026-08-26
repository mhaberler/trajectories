"""Orchestration: WindField + integrator + GeoJSON — library entry point."""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Sequence

from . import config
from .geojson_export import build_geojson
from .integrator import compute_trajectory
from .windfield import WindField

TRACK_WORKERS = 8


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


def parse_flight_profile(
    times: Sequence[float],
    heights: Sequence[float],
) -> list[tuple[float, float]]:
    """Validate and zip profile_time (s) + profile_height (m AGL)."""
    if len(times) != len(heights):
        raise ValueError("profile_time and profile_height must have the same length")
    if len(times) < 2:
        raise ValueError("flight profile requires at least 2 waypoints")
    out: list[tuple[float, float]] = []
    prev_t: float | None = None
    for t, h in zip(times, heights, strict=True):
        if not math.isfinite(t) or not math.isfinite(h):
            raise ValueError("profile waypoints must be finite numbers")
        if t < 0:
            raise ValueError("profile_time values must be >= 0")
        if h < 0:
            raise ValueError("profile_height values must be >= 0")
        if prev_t is not None and t <= prev_t:
            raise ValueError("profile_time must be strictly increasing")
        prev_t = t
        out.append((float(t), float(h)))
    return out


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
    time: str | datetime | float | int | None = None,
    times: Sequence[str | datetime | float | int] | None = None,
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
    height_profile: Sequence[tuple[float, float]] | None = None,
    marker_interval_climbing_min: float = 10,
    clearance_m: float = 0.0,
) -> dict[str, Any]:
    """
    Compute trajectories and return a GeoJSON FeatureCollection dict.

    ``methods`` may list several vertical modes; ``heights`` several start heights.
    All combinations are run into one FeatureCollection.

    Pass exactly one of ``time`` (single start) or ``times`` (launch-window batch).
    Multiple starts share one WindField init spanning the full time range.

    When ``height_profile`` is set (list of ``(t_sec, h_agl)``), a single kinematic
    AGL track is computed; ``heights`` / multi-method are not used. Profile is
    incompatible with ``times`` (multi-start).

    Data source: ``backend`` ``auto`` (default) prefers local Open-Meteo OM files
    under ``om_root`` / ``TRAJECTORIES_OM_ROOT`` when available, else HTTP.
    """
    if api_base:
        config.set_api_base(api_base)
    if om_root is not None:
        config.set_om_root(om_root)
    if backend is not None:
        config.set_backend(backend)

    has_time = time is not None and not (
        isinstance(time, str) and not str(time).strip()
    )
    has_times = times is not None and len(list(times)) > 0
    if has_time == has_times:
        raise ValueError("Specify exactly one of time or times")

    if has_times:
        t0_list_ms = sorted({_parse_time(t) for t in times})  # type: ignore[arg-type]
        if not t0_list_ms:
            raise ValueError("times must contain at least one start")
    else:
        t0_list_ms = [_parse_time(time)]  # type: ignore[arg-type]

    if model not in config.MODELS:
        raise ValueError(f"Unknown model: {model}")
    cap = config.max_times_points(model)
    if has_times and len(t0_list_ms) > cap:
        raise ValueError(f"times accepts at most {cap} starts")
    model_cfg = config.MODELS[model]
    backend_kind = config.resolve_backend(model)
    horizon_h = config.forecast_horizon_h(model)
    if float(duration_h) > horizon_h:
        raise ValueError(
            f"forecast_hours must be <= {horizon_h} for {model}"
        )

    profile: list[tuple[float, float]] | None = None
    if height_profile is not None:
        if len(t0_list_ms) > 1:
            raise ValueError("flight profile is incompatible with multiple times")
        profile = parse_flight_profile(
            [p[0] for p in height_profile],
            [p[1] for p in height_profile],
        )

    if profile is not None:
        methods = ["height"]
        height_ref = "agl"
        h0 = profile[0][1]
        heights = [h0]
        t_last_h = profile[-1][0] / 3600.0
        duration = min(max(0.0, float(duration_h)), t_last_h)
        if duration <= 0:
            raise ValueError("flight profile duration must be > 0")
    else:
        heights = list(heights) if heights is not None else list(config.DEFAULT_HEIGHTS)
        methods = list(methods) if methods is not None else ["height"]
        if not heights:
            raise ValueError("At least one height required")
        if not methods:
            raise ValueError("At least one method required")
        duration = max(1, float(duration_h))

    for m in methods:
        if m not in {x["key"] for x in config.METHODS}:
            raise ValueError(f"Unknown method: {m}")
    if profile is not None and methods != ["height"]:
        raise ValueError("flight profile only supports vertical_motion=height")
    if height_ref not in ("agl", "amsl"):
        raise ValueError("height_ref must be 'agl' or 'amsl'")

    if isinstance(direction, str):
        direction_i = 1 if direction.lower() in ("forward", "fwd", "+1", "1") else -1
    else:
        direction_i = 1 if int(direction) >= 0 else -1

    marker_interval_sec = float(marker_interval_min) * 60
    marker_climb_sec = float(marker_interval_climbing_min) * 60

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

    t_min = min(t0_list_ms)
    t_max = max(t0_list_ms)
    # Span covers earliest start through latest start + duration (either direction).
    t_span_a = t_min + direction_i * duration * 3600e3
    t_span_b = t_max + direction_i * duration * 3600e3
    t_init_lo = min(t_min, t_max, t_span_a, t_span_b)
    t_init_hi = max(t_min, t_max, t_span_a, t_span_b)

    max_h = max(heights)
    if profile is not None:
        max_h = max(max_h, max(h for _, h in profile))

    all_features: list[dict] = []

    with WindField(model, w_var_prefix=w_prefix, backend=backend_kind) as wf:
        wf.init(lat, lon, max_h, t_init_lo, t_init_hi, methods, met_extras=met_extras)

        for t0_ms in t0_list_ms:
            jobs: list[tuple[float, str, str, dict, str]] = []
            for height_m in heights:
                for method in methods:
                    style = next(m for m in config.METHODS if m["key"] == method)
                    color = style["color"] if compare_mode else height_colors[height_m]
                    if profile is not None:
                        target = {"type": "height", "mode": "agl", "value": height_m}
                        label = f"Profil {_fmt_height(height_m)} AGL"
                    else:
                        target, label = make_target(
                            wf, lat, lon, height_m, height_ref, method, t0_ms
                        )
                    jobs.append((height_m, method, color, target, label))

            def _run_one(
                job: tuple[float, str, str, dict, str], *, _t0: float = t0_ms
            ) -> dict:
                height_m, method, color, target, label = job
                r = compute_trajectory(
                    wind_at=wf.wind_at,
                    lat0=lat,
                    lon0=lon,
                    target=target,
                    t0_ms=_t0,
                    duration_hours=duration,
                    direction=direction_i,
                    grid_meters=model_cfg["gridMeters"],
                    marker_interval_sec=marker_interval_sec,
                    height_profile=profile,
                    marker_interval_climb_sec=marker_climb_sec if profile else None,
                    clearance_m=float(clearance_m) if profile else 0.0,
                    elevation_at=wf.elevation_at if profile else None,
                )
                return {
                    "r": r,
                    "color": color,
                    "label": label,
                    "heightM": height_m,
                    "method": method,
                }

            runs: list[dict] = []
            if len(jobs) == 1:
                runs.append(_run_one(jobs[0]))
            else:
                workers = min(TRACK_WORKERS, len(jobs))
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futs = {pool.submit(_run_one, j): i for i, j in enumerate(jobs)}
                    ordered: list[dict | None] = [None] * len(jobs)
                    for fut in as_completed(futs):
                        ordered[futs[fut]] = fut.result()
                    runs = [r for r in ordered if r is not None]

            for run in runs:
                pts = run["r"]["points"]
                terrain: list[float | None] = []
                for p in pts:
                    e = wf.elevation_at(p["lat"], p["lon"])
                    terrain.append(
                        float(e) if e is not None and math.isfinite(e) else None
                    )
                run["terrain"] = terrain

            gj = build_geojson(
                runs=runs,
                model_key=model,
                mode=height_ref,
                t0_ms=t0_ms,
                duration=duration,
                direction=direction_i,
            )
            all_features.extend(gj.get("features") or [])

    return {"type": "FeatureCollection", "features": all_features}


def _iso_ms(t_ms: float) -> str:
    return (
        datetime.fromtimestamp(t_ms / 1000.0, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _pack_point_wind_model(
    model: str,
    sample: dict[str, Any],
    terrain: float | None,
) -> dict[str, Any]:
    u = float(sample["u"])
    v = float(sample["v"])
    spd_ms = math.hypot(u, v)
    direction_deg = (math.atan2(-u, -v) * 180 / math.pi + 360) % 360
    w_raw = sample.get("w")
    w_ms = float(w_raw) if w_raw is not None and math.isfinite(float(w_raw)) else None
    z_amsl = sample.get("zAmsl")
    return {
        "model": model,
        "wind_u_ms": round(u, 3),
        "wind_v_ms": round(v, 3),
        "wind_w_ms": round(w_ms, 4) if w_ms is not None else None,
        "wind_speed_ms": round(spd_ms, 3),
        "wind_speed_kmh": round(spd_ms * 3.6, 1),
        "wind_direction_deg": round(direction_deg),
        "z_amsl_m": round(float(z_amsl)) if z_amsl is not None and math.isfinite(z_amsl) else None,
        "terrain_m": round(terrain) if terrain is not None else None,
    }


def _sample_point_wind_one(
    *,
    model: str,
    lat: float,
    lon: float,
    t0_list_ms: Sequence[float],
    height_m: float,
    height_ref: str,
    backend_kind: str,
) -> list[dict[str, Any]]:
    """Sample one model at each start time with a single WindField.init.

    Raises ValueError/RuntimeError on domain or setup failure. Per-time
    ``wind_at`` errors become ``{model, error, reason}`` rows.
    """
    if model not in config.MODELS:
        raise ValueError(f"Unknown model: {model}")
    model_cfg = config.MODELS[model]
    b = model_cfg["bbox"]
    if not (b["latMin"] <= lat <= b["latMax"] and b["lonMin"] <= lon <= b["lonMax"]):
        raise ValueError(f"Point outside {model_cfg['label']} domain")

    w_prefix = WindField.detect_w_variable(model, backend=backend_kind)
    target = {"type": "height", "mode": height_ref, "value": height_m}
    t_lo = min(t0_list_ms)
    t_hi = max(t0_list_ms)

    rows: list[dict[str, Any]] = []
    with WindField(model, w_var_prefix=w_prefix, backend=backend_kind) as wf:
        wf.init(
            lat,
            lon,
            height_m,
            t_lo,
            t_hi,
            "height",
            met_extras=False,
            include_w=bool(w_prefix),
        )
        elev = wf.elevation_at(lat, lon)
        terrain = float(elev) if elev is not None and math.isfinite(elev) else None
        for t0_ms in t0_list_ms:
            sample = wf.wind_at(lat, lon, target, t0_ms)
            if sample.get("error"):
                rows.append({"model": model, "error": True, "reason": str(sample["error"])})
                continue
            rows.append(_pack_point_wind_model(model, sample, terrain))
    return rows


def compute_point_wind(
    *,
    lat: float,
    lon: float,
    time: str | datetime | float | int | None = None,
    times: Sequence[str | datetime | float | int] | None = None,
    models: str | Sequence[str] = "icon_eu",
    height_m: float,
    height_ref: str = "agl",
    api_base: str | None = None,
    om_root: str | None = None,
    backend: str | None = None,
) -> dict[str, Any]:
    """
    Sample horizontal (+ optional vertical) wind at one lat/lon/height.

    Pass exactly one of ``time`` (single sample) or ``times`` (launch-window
    batch; at most 4× the shortest model forecast horizon). Multiple starts
    share one WindField init spanning the full time range.

    ``models`` may be a single id or a sequence / CSV-split list. Per-model
    failures become ``{model, error, reason}`` entries when at least one model
    succeeds at least once; if all fail, raises ValueError with a combined reason.
    """
    if api_base:
        config.set_api_base(api_base)
    if om_root is not None:
        config.set_om_root(om_root)
    if backend is not None:
        config.set_backend(backend)

    if height_ref not in ("agl", "amsl"):
        raise ValueError("height_ref must be 'agl' or 'amsl'")
    if not math.isfinite(height_m) or height_m < 0:
        raise ValueError("height_m must be a non-negative finite number")

    if isinstance(models, str):
        model_list = [p.strip() for p in models.split(",") if p.strip()]
    else:
        model_list = [str(m).strip() for m in models if str(m).strip()]
    if not model_list:
        raise ValueError("At least one model required")

    has_time = time is not None and not (
        isinstance(time, str) and not str(time).strip()
    )
    has_times = times is not None and len(list(times)) > 0
    if has_time == has_times:
        raise ValueError("Specify exactly one of time or times")

    if has_times:
        t0_list_ms = sorted({_parse_time(t) for t in times})  # type: ignore[arg-type]
        cap = config.max_times_points_for_models(model_list)
        if len(t0_list_ms) > cap:
            raise ValueError(f"times accepts at most {cap} starts")
        if not t0_list_ms:
            raise ValueError("times must contain at least one start")
        batch = True
    else:
        t0_list_ms = [_parse_time(time)]  # type: ignore[arg-type]
        batch = False

    # [model_index][time_index]
    per_model: list[list[dict[str, Any]]] = []
    errors: list[str] = []

    for model in model_list:
        try:
            backend_kind = config.resolve_backend(model)
            per_model.append(
                _sample_point_wind_one(
                    model=model,
                    lat=lat,
                    lon=lon,
                    t0_list_ms=t0_list_ms,
                    height_m=float(height_m),
                    height_ref=height_ref,
                    backend_kind=backend_kind,
                )
            )
        except (ValueError, RuntimeError) as exc:
            reason = str(exc)
            errors.append(f"{model}: {reason}")
            fail = {"model": model, "error": True, "reason": reason}
            per_model.append([fail] * len(t0_list_ms))
        except Exception as exc:  # noqa: BLE001
            reason = f"Internal error: {exc}"
            errors.append(f"{model}: {reason}")
            fail = {"model": model, "error": True, "reason": reason}
            per_model.append([fail] * len(t0_list_ms))

    samples: list[dict[str, Any]] = []
    ok = 0
    for i, t0_ms in enumerate(t0_list_ms):
        entries = [per_model[m][i] for m in range(len(model_list))]
        if any(not e.get("error") for e in entries):
            ok += 1
        else:
            for e in entries:
                if e.get("error"):
                    errors.append(f"{e.get('model')}: {e.get('reason')}")
        samples.append({"time": _iso_ms(t0_ms), "models": entries})

    if ok == 0:
        # Dedupe while preserving order (setup failures are repeated per time).
        seen: set[str] = set()
        uniq: list[str] = []
        for msg in errors:
            if msg not in seen:
                seen.add(msg)
                uniq.append(msg)
        raise ValueError("; ".join(uniq) if uniq else "No wind sample")

    base = {
        "latitude": lat,
        "longitude": lon,
        "height_reference": height_ref,
        "height_m": float(height_m),
    }
    if batch:
        return {
            **base,
            "times": [s["time"] for s in samples],
            "samples": samples,
        }
    return {**base, "time": samples[0]["time"], "models": samples[0]["models"]}
