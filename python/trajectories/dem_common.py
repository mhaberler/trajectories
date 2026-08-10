"""Shared DEM cache / stats / track sampling helpers."""

from __future__ import annotations

import math
import os
import threading
from collections import OrderedDict
from pathlib import Path


def env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return Path(raw).expanduser()


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip() not in ("", "0", "false")


class DemStats:
    """Thread-safe counters for one DEM instance (reset around sample_line)."""

    __slots__ = (
        "_lock",
        "samples",
        "unique_tiles",
        "disk_hits",
        "disk_misses",
        "decode_hits",
        "decode_misses",
        "http_ranges",
        "http_bytes",
        "http_ms",
        "http_gets",
        "zoom_tries",
        "zoom_misses",
    )

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.samples = 0
            self.unique_tiles = 0
            self.disk_hits = 0
            self.disk_misses = 0
            self.decode_hits = 0
            self.decode_misses = 0
            self.http_ranges = 0
            self.http_bytes = 0
            self.http_ms = 0.0
            self.http_gets = 0
            self.zoom_tries = 0
            self.zoom_misses = 0

    def add(self, **kwargs: int | float) -> None:
        with self._lock:
            for key, val in kwargs.items():
                setattr(self, key, getattr(self, key) + val)

    def as_dict(self) -> dict[str, int | float]:
        with self._lock:
            return {
                "samples": self.samples,
                "unique_tiles": self.unique_tiles,
                "disk_hits": self.disk_hits,
                "disk_misses": self.disk_misses,
                "decode_hits": self.decode_hits,
                "decode_misses": self.decode_misses,
                "http_ranges": self.http_ranges,
                "http_gets": self.http_gets,
                "http_bytes": self.http_bytes,
                "http_ms": round(self.http_ms, 2),
                "zoom_tries": self.zoom_tries,
                "zoom_misses": self.zoom_misses,
            }


class DiskTileCache:
    """On-disk LRU of raw tile bytes, capped by total size."""

    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()
        self._lru: OrderedDict[str, int] = OrderedDict()
        self._total = 0
        self.root.mkdir(parents=True, exist_ok=True)
        self._reindex()

    def _path(self, archive: str, z: int, x: int, y: int) -> Path:
        safe = archive.replace("..", "_").replace("/", "_")
        return self.root / safe / str(z) / str(x) / f"{y}.tile"

    def _reindex(self) -> None:
        total = 0
        lru: OrderedDict[str, int] = OrderedDict()
        files: list[tuple[float, str, int]] = []
        try:
            for p in self.root.rglob("*.tile"):
                try:
                    st = p.stat()
                except OSError:
                    continue
                files.append((st.st_atime, str(p), int(st.st_size)))
        except OSError:
            files = []
        files.sort(key=lambda t: t[0])
        for _atime, key, size in files:
            lru[key] = size
            total += size
        self._lru = lru
        self._total = total

    def get(self, archive: str, z: int, x: int, y: int) -> bytes | None:
        path = self._path(archive, z, x, y)
        key = str(path)
        with self._lock:
            if key not in self._lru:
                return None
            self._lru.move_to_end(key)
        try:
            data = path.read_bytes()
            try:
                os.utime(path, None)
            except OSError:
                pass
            return data
        except OSError:
            with self._lock:
                size = self._lru.pop(key, 0)
                self._total = max(0, self._total - size)
            return None

    def put(self, archive: str, z: int, x: int, y: int, data: bytes) -> None:
        if self.max_bytes <= 0 or not data:
            return
        path = self._path(archive, z, x, y)
        key = str(path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
        except OSError:
            return
        size = len(data)
        to_unlink: list[str] = []
        with self._lock:
            old = self._lru.pop(key, None)
            if old is not None:
                self._total = max(0, self._total - old)
            self._lru[key] = size
            self._total += size
            self._lru.move_to_end(key)
            while self._total > self.max_bytes and self._lru:
                old_k, old_sz = self._lru.popitem(last=False)
                self._total = max(0, self._total - old_sz)
                if old_k != key:
                    to_unlink.append(old_k)
        for old_k in to_unlink:
            try:
                Path(old_k).unlink(missing_ok=True)
            except OSError:
                continue

    def total_bytes(self) -> int:
        with self._lock:
            return self._total


def point_at_track_time(
    points: list[dict[str, float]], t_sec: float, t0: float
) -> dict[str, float] | None:
    """Interpolate lat/lon at relative t_sec from first point's absolute t_sec."""
    if not points:
        return None
    t_abs = t0 + t_sec
    if t_abs <= points[0]["t_sec"]:
        return {"lat": points[0]["lat"], "lon": points[0]["lon"]}
    last = points[-1]
    if t_abs >= last["t_sec"]:
        return {"lat": last["lat"], "lon": last["lon"]}
    for i in range(1, len(points)):
        a = points[i - 1]
        b = points[i]
        if t_abs <= b["t_sec"]:
            dt = max(1e-9, b["t_sec"] - a["t_sec"])
            u = (t_abs - a["t_sec"]) / dt
            return {
                "lat": a["lat"] + u * (b["lat"] - a["lat"]),
                "lon": a["lon"] + u * (b["lon"] - a["lon"]),
            }
    return {"lat": last["lat"], "lon": last["lon"]}


def build_sample_times(
    points: list[dict[str, float]],
    interval_sec: float,
    *,
    min_interval: float,
    max_line_points: int,
    max_samples: int,
) -> tuple[list[dict[str, float]], list[float]] | None:
    """Normalize track points and build relative sample times. None if unusable."""
    interval = max(min_interval, float(interval_sec or 60))
    pts: list[dict[str, float]] = []
    for p in points[:max_line_points]:
        lat = float(p.get("lat", float("nan")))
        lon = float(p.get("lon", float("nan")))
        t = float(p.get("t_sec", p.get("tSec", float("nan"))))
        if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(t)):
            continue
        pts.append({"lat": lat, "lon": lon, "t_sec": t})
    if len(pts) < 2:
        return None
    pts.sort(key=lambda q: q["t_sec"])
    t0 = pts[0]["t_sec"]
    t_end = pts[-1]["t_sec"] - t0
    if t_end < 0:
        return None
    times = [0.0]
    t = interval
    while t < t_end - 1e-6:
        times.append(t)
        t += interval
        if len(times) >= max_samples - 1:
            break
    if t_end > 0:
        times.append(t_end)
    return pts, times[:max_samples]
