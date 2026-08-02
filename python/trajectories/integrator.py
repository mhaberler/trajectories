"""Petterssen trajectory integrator — port of src/integrator.js."""

from __future__ import annotations

import math
from typing import Any, Callable

R_EARTH = 6_371_000
DEG = 180 / math.pi

WindAt = Callable[[float, float, dict, float], dict]


def compute_trajectory(
    *,
    wind_at: WindAt,
    lat0: float,
    lon0: float,
    target: dict,
    t0_ms: float,
    duration_hours: float,
    direction: int = 1,
    grid_meters: float,
    marker_interval_sec: float = 3600,
    max_step_sec: float = 900,
    min_step_sec: float = 60,
) -> dict[str, Any]:
    interval_ms = marker_interval_sec * 1000
    is3d = target["type"] == "z3d"
    tgt = dict(target)
    lat, lon, t = lat0, lon0, t0_ms
    t_end = t0_ms + direction * duration_hours * 3600e3
    points: list[dict] = [{"lat": lat, "lon": lon, "tMs": t, "z": None}]
    markers: list[dict] = []
    status, reason = "ok", None

    while direction * (t_end - t) > 1:
        w0 = wind_at(lat, lon, tgt, t)
        if w0.get("error"):
            status, reason = "stopped", w0["error"]
            break
        if points[0]["z"] is None:
            points[0]["z"] = w0.get("zAmsl")

        speed = math.hypot(w0["u"], w0["v"])
        dt_sec = clamp((0.75 * grid_meters) / max(speed, 0.5), min_step_sec, max_step_sec)
        rel = t - t0_ms
        if direction > 0:
            next_mark = t0_ms + math.floor(rel / interval_ms + 1) * interval_ms
        else:
            next_mark = t0_ms + math.ceil(rel / interval_ms - 1) * interval_ms
        limit_ms = direction * min(direction * (t_end - t), direction * (next_mark - t))
        dt_sec = min(dt_sec, abs(limit_ms) / 1000)
        dt = direction * dt_sec

        lat1, lon1 = advect(lat, lon, w0["u"], w0["v"], dt)
        z1 = tgt["value"] + w0["w"] * dt if is3d else tgt["value"]
        w_last = w0
        failed = None
        for _ in range(5):
            tgt1 = {**tgt, "value": z1} if is3d else tgt
            w1 = wind_at(lat1, lon1, tgt1, t + dt * 1000)
            if w1.get("error"):
                failed = w1["error"]
                break
            w_last = w1
            lat_n, lon_n = advect(
                lat, lon,
                0.5 * (w0["u"] + w1["u"]),
                0.5 * (w0["v"] + w1["v"]),
                dt,
            )
            z_n = tgt["value"] + 0.5 * (w0["w"] + w1["w"]) * dt if is3d else tgt["value"]
            move = dist_meters(lat1, lon1, lat_n, lon_n) + abs(z_n - z1)
            lat1, lon1, z1 = lat_n, lon_n, z_n
            if move < 10:
                break
        if failed:
            status, reason = "stopped", failed
            break

        lat, lon, t = lat1, lon1, t + dt * 1000
        if is3d:
            tgt = {**tgt, "value": z1}
        points.append({"lat": lat, "lon": lon, "tMs": t, "z": w_last.get("zAmsl")})
        mrem = abs((t - t0_ms) % interval_ms)
        if mrem < 1 or interval_ms - mrem < 1:
            w = wind_at(lat, lon, tgt, t)
            if not w.get("error"):
                markers.append({
                    "lat": lat, "lon": lon, "tMs": t,
                    "u": w["u"], "v": w["v"],
                    "z": w.get("zAmsl"), "met": w.get("met"),
                })

    return {
        "points": points,
        "markers": markers,
        "status": status,
        "reason": reason,
        "target": tgt,
        "direction": direction,
    }


def advect(lat: float, lon: float, u: float, v: float, dt_sec: float) -> tuple[float, float]:
    lat_mid = (lat + (lat + (v * dt_sec / R_EARTH) * DEG)) / 2
    d_lat = (v * dt_sec / R_EARTH) * DEG
    d_lon = (u * dt_sec / (R_EARTH * math.cos(lat_mid / DEG))) * DEG
    return lat + d_lat, normalize_lon(lon + d_lon)


def dist_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dy = (lat2 - lat1) / DEG * R_EARTH
    dx = (lon2 - lon1) / DEG * R_EARTH * math.cos(((lat1 + lat2) / 2) / DEG)
    return math.hypot(dx, dy)


def normalize_lon(lon: float) -> float:
    return ((lon + 540) % 360) - 180


def clamp(x: float, a: float, b: float) -> float:
    return min(b, max(a, x))
