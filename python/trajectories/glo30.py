"""Copernicus GLO-30 Public DEM via COG + on-demand 1° disk cache.

Upstream (AWS Open Data, no auth):
  {base}/Copernicus_DSM_COG_10_{N|S}xx_00_{E|W}xxx_00_DEM/
       Copernicus_DSM_COG_10_..._DEM.tif

Missing/ocean tiles (HTTP 404) → elevation 0 m.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections import OrderedDict, defaultdict
from pathlib import Path
from typing import Callable

import httpx

from .dem_common import (
    DemStats,
    build_sample_times,
    env_flag,
    env_int,
    env_path,
    point_at_track_time,
)

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import Window
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "rasterio is required for GLO-30 DEM. "
        'Install with: pip install -e "python/[api]" '
        "(system GDAL required)."
    ) from exc

BASE_URL = os.environ.get(
    "TRAJECTORIES_GLO30_BASE",
    "https://copernicus-dem-30m.s3.amazonaws.com",
).rstrip("/")
MIN_INTERVAL_SEC = 15
MAX_LINE_POINTS = 5000
MAX_SAMPLES = 2000
FETCH_CONCURRENCY = 4
HTTP_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
DEBUG = env_flag("TRAJECTORIES_GLO30_DEBUG") or env_flag("TRAJECTORIES_DEM_DEBUG")

_log = logging.getLogger(__name__)
_DEFAULT_CACHE = Path("/var/cache/trajectories/glo30")
_DEFAULT_CACHE_MAX = 5 * 1024 * 1024 * 1024

CACHE_DIR = env_path("TRAJECTORIES_GLO30_CACHE", _DEFAULT_CACHE)
CACHE_MAX_BYTES = env_int("TRAJECTORIES_GLO30_CACHE_MAX_BYTES", _DEFAULT_CACHE_MAX)


class Glo30DEMError(RuntimeError):
    """Raised when GLO-30 HTTP/IO fails (no silent fallback to other backends)."""


def tile_sw_corner(lat: float, lon: float) -> tuple[int, int]:
    """SW corner integer degrees of the 1° cell containing (lat, lon)."""
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise ValueError("lat/lon must be finite")
    if abs(lat) > 90 or abs(lon) > 180:
        raise ValueError("lat/lon out of range")
    lat_i = int(math.floor(lat))
    lon_i = int(math.floor(lon))
    # lon=180 maps into the last western-edge cell of the antimeridian wrap
    if lon_i == 180:
        lon_i = 179
    if lat_i == 90:
        lat_i = 89
    return lat_i, lon_i


def tile_stem(lat: float, lon: float) -> str:
    """GLO-30 object stem for the 1° cell containing (lat, lon)."""
    lat_i, lon_i = tile_sw_corner(lat, lon)
    ns = "N" if lat_i >= 0 else "S"
    ew = "E" if lon_i >= 0 else "W"
    return (
        f"Copernicus_DSM_COG_10_{ns}{abs(lat_i):02d}_00_"
        f"{ew}{abs(lon_i):03d}_00_DEM"
    )


def tile_url(base_url: str, stem: str) -> str:
    base = base_url.rstrip("/")
    return f"{base}/{stem}/{stem}.tif"


class DiskCogCache:
    """On-disk LRU of whole 1° GeoTIFF files (+ `.missing` markers), capped by bytes."""

    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()
        self._lru: OrderedDict[str, int] = OrderedDict()
        self._total = 0
        self.root.mkdir(parents=True, exist_ok=True)
        self._reindex()

    def _tif_path(self, stem: str) -> Path:
        safe = stem.replace("..", "_").replace("/", "_")
        return self.root / f"{safe}.tif"

    def _missing_path(self, stem: str) -> Path:
        return self._tif_path(stem).with_suffix(".missing")

    def _reindex(self) -> None:
        total = 0
        lru: OrderedDict[str, int] = OrderedDict()
        files: list[tuple[float, str, int]] = []
        try:
            for p in self.root.glob("*.tif"):
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

    def is_missing(self, stem: str) -> bool:
        return self._missing_path(stem).is_file()

    def mark_missing(self, stem: str) -> None:
        path = self._missing_path(stem)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("404\n", encoding="utf-8")
        except OSError:
            pass

    def get_path(self, stem: str) -> Path | None:
        path = self._tif_path(stem)
        key = str(path)
        with self._lock:
            if key not in self._lru and not path.is_file():
                return None
            if key in self._lru:
                self._lru.move_to_end(key)
        if not path.is_file():
            with self._lock:
                size = self._lru.pop(key, 0)
                self._total = max(0, self._total - size)
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return path

    def put_file(self, stem: str, data: bytes) -> Path | None:
        if self.max_bytes <= 0 or not data:
            return None
        path = self._tif_path(stem)
        key = str(path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tif.tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            miss = self._missing_path(stem)
            miss.unlink(missing_ok=True)
        except OSError:
            return None
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
        return path

    def total_bytes(self) -> int:
        with self._lock:
            return self._total


class Glo30DEM:
    """Process-wide GLO-30 sampler with on-demand 1° COG disk cache."""

    def __init__(
        self,
        *,
        cache_dir: Path | None = None,
        cache_max_bytes: int | None = None,
        base_url: str | None = None,
        client: httpx.Client | None = None,
        fetch_bytes_fn: Callable[[str], bytes | None] | None = None,
    ):
        """fetch_bytes_fn(stem) -> tif bytes, None for missing/404 (tests)."""
        self.base_url = (base_url or BASE_URL).rstrip("/")
        self.disk = DiskCogCache(
            cache_dir if cache_dir is not None else CACHE_DIR,
            cache_max_bytes if cache_max_bytes is not None else CACHE_MAX_BYTES,
        )
        self._owns_client = client is None
        self._client = client or httpx.Client(
            timeout=HTTP_TIMEOUT,
            trust_env=False,
            headers={"User-Agent": "trajectories-glo30/0.1"},
            follow_redirects=True,
        )
        self.stats = DemStats()
        self.last_sample_stats: dict[str, int | float] | None = None
        self._fetch_sem = threading.Semaphore(FETCH_CONCURRENCY)
        self._fetch_bytes_fn = fetch_bytes_fn
        # GDAL/rasterio is not safe across threads. Serialize whole DEM ops
        # (UI fires profile + cross-section /elevation/line in parallel).
        self._op_lock = threading.RLock()
        self._ensure_locks: dict[str, threading.Lock] = {}
        self._ensure_locks_guard = threading.Lock()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _stem_lock(self, stem: str) -> threading.Lock:
        with self._ensure_locks_guard:
            lock = self._ensure_locks.get(stem)
            if lock is None:
                lock = threading.Lock()
                self._ensure_locks[stem] = lock
            return lock

    def _vsicurl_path(self, stem: str) -> str:
        url = tile_url(self.base_url, stem)
        return f"/vsicurl/{url}"

    def _download_stem(self, stem: str) -> Path | None:
        """Fetch full 1° COG into cache. None means missing (ocean / not public)."""
        if self.disk.is_missing(stem):
            self.stats.add(disk_hits=1)
            return None
        cached = self.disk.get_path(stem)
        if cached is not None:
            self.stats.add(disk_hits=1)
            return cached
        self.stats.add(disk_misses=1)

        if self._fetch_bytes_fn is not None:
            try:
                data = self._fetch_bytes_fn(stem)
            except Glo30DEMError:
                raise
            except Exception as exc:
                raise Glo30DEMError(f"GLO-30 fetch failed {stem}: {exc}") from exc
            if data is None:
                self.disk.mark_missing(stem)
                return None
            path = self.disk.put_file(stem, data)
            if path is None:
                raise Glo30DEMError(f"GLO-30 cache write failed for {stem}")
            return path

        url = tile_url(self.base_url, stem)
        t0 = time.perf_counter()
        try:
            with self._fetch_sem:
                r = self._client.get(url)
            self.stats.add(
                http_gets=1,
                http_bytes=len(r.content),
                http_ms=(time.perf_counter() - t0) * 1000.0,
            )
            if r.status_code == 404:
                self.disk.mark_missing(stem)
                return None
            if r.status_code != 200:
                raise Glo30DEMError(f"GLO-30 HTTP {r.status_code} for {stem}")
            data = r.content
        except Glo30DEMError:
            raise
        except Exception as exc:
            raise Glo30DEMError(f"GLO-30 fetch failed {stem}: {exc}") from exc
        if not data:
            raise Glo30DEMError(f"GLO-30 empty object {stem}")
        path = self.disk.put_file(stem, data)
        if path is None:
            # cache disabled: fall back to vsicurl for this process only
            return None
        return path

    def ensure_tile(self, stem: str) -> Path | None:
        """Return local path, or None if tile is known-missing (use elev 0)."""
        with self._stem_lock(stem):
            return self._download_stem(stem)

    def _open_path(self, stem: str) -> str | None:
        """Local path or /vsicurl/ URI; None if missing/ocean."""
        path = self.ensure_tile(stem)
        if path is not None:
            return str(path)
        if self.disk.is_missing(stem):
            return None
        return self._vsicurl_path(stem)

    def _sample_xy(
        self, ds: rasterio.DatasetReader, lon: float, lat: float
    ) -> float | None:
        try:
            row, col = ds.index(lon, lat)
        except Exception:
            return None
        if row < 0 or col < 0 or row >= ds.height or col >= ds.width:
            return None
        try:
            data = ds.read(
                1,
                window=Window(col, row, 1, 1),
                resampling=Resampling.nearest,
            )
        except Exception as exc:
            raise Glo30DEMError(f"GLO-30 read failed: {exc}") from exc
        if data.size == 0:
            return None
        val = float(data[0, 0])
        nodata = ds.nodata
        if nodata is not None and (
            val == nodata
            or (
                isinstance(nodata, float)
                and math.isnan(nodata)
                and math.isnan(val)
            )
        ):
            return 0.0
        if not math.isfinite(val):
            return 0.0
        return val

    def _sample_stem(
        self, stem: str, items: list[tuple[int, dict[str, float]]]
    ) -> dict[int, dict[str, float]]:
        """Open one COG and sample all points (caller must hold `_op_lock`)."""

        def _zeros() -> dict[int, dict[str, float]]:
            z: dict[int, dict[str, float]] = {}
            for idx, sample in items:
                z[idx] = {
                    "t_sec": sample["t_sec"],
                    "lat": sample["lat"],
                    "lon": sample["lon"],
                    "z": 0.0,
                }
            return z

        def _open_and_read(src: str) -> dict[int, dict[str, float]]:
            try:
                ds = rasterio.open(src)
            except rasterio.errors.RasterioIOError as exc:
                msg = str(exc).lower()
                if "404" in msg or "not found" in msg or "does not exist" in msg:
                    self.disk.mark_missing(stem)
                    self.stats.add(zoom_misses=len(items))
                    return _zeros()
                raise Glo30DEMError(f"GLO-30 open failed {stem}: {exc}") from exc
            except Exception as exc:
                raise Glo30DEMError(f"GLO-30 open failed {stem}: {exc}") from exc
            local: dict[int, dict[str, float]] = {}
            try:
                for idx, sample in items:
                    try:
                        elev = self._sample_xy(ds, sample["lon"], sample["lat"])
                    except Glo30DEMError:
                        elev = None
                    if elev is None:
                        elev = 0.0
                    local[idx] = {
                        "t_sec": sample["t_sec"],
                        "lat": sample["lat"],
                        "lon": sample["lon"],
                        "z": float(elev),
                    }
            finally:
                try:
                    ds.close()
                except Exception:
                    pass
            return local

        src = self._open_path(stem)
        if src is None:
            self.stats.add(zoom_misses=len(items))
            return _zeros()
        self.stats.add(decode_misses=1)
        try:
            return _open_and_read(src)
        except Glo30DEMError as exc:
            path = self.disk.get_path(stem)
            if path is None:
                raise
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            # Force re-download on retry.
            src2 = self._open_path(stem)
            if src2 is None:
                self.stats.add(zoom_misses=len(items))
                return _zeros()
            try:
                return _open_and_read(src2)
            except Glo30DEMError:
                _log.warning("GLO-30 giving up on %s after retry: %s", stem, exc)
                self.stats.add(zoom_misses=len(items))
                return _zeros()

    def elevation_at(self, lat: float, lon: float) -> float | None:
        if not math.isfinite(lat) or not math.isfinite(lon):
            return None
        if abs(lat) > 90 or abs(lon) > 180:
            return None
        if lon == -180:
            lon = -180.0
        elif lon > 180 or lon < -180:
            lon = ((lon + 180) % 360) - 180
        stem = tile_stem(lat, lon)
        with self._op_lock:
            self.stats.add(zoom_tries=1)
            src = self._open_path(stem)
            if src is None:
                self.stats.add(zoom_misses=1)
                return 0.0
            self.stats.add(decode_misses=1)
            try:
                with rasterio.open(src) as ds:
                    elev = self._sample_xy(ds, lon, lat)
            except rasterio.errors.RasterioIOError as exc:
                msg = str(exc).lower()
                if "404" in msg or "not found" in msg or "does not exist" in msg:
                    self.disk.mark_missing(stem)
                    self.stats.add(zoom_misses=1)
                    return 0.0
                raise Glo30DEMError(f"GLO-30 open failed {stem}: {exc}") from exc
            except Glo30DEMError:
                raise
            except Exception as exc:
                raise Glo30DEMError(f"GLO-30 open failed {stem}: {exc}") from exc
            if elev is None:
                return 0.0
            return elev

    def _prefetch_stems(self, stems: list[str]) -> None:
        if not stems:
            return

        def _one(stem: str) -> None:
            self.ensure_tile(stem)

        # Keep downloads sequential under `_op_lock` callers — avoid concurrent
        # httpx + any accidental GDAL interaction from vsicurl fallbacks.
        for stem in stems:
            _one(stem)

    def sample_line(
        self,
        points: list[dict[str, float]],
        interval_sec: float,
    ) -> list[dict[str, float]]:
        if not points or len(points) < 2:
            return []
        with self._op_lock:
            self.stats.reset()
            built = build_sample_times(
                points,
                interval_sec,
                min_interval=MIN_INTERVAL_SEC,
                max_line_points=MAX_LINE_POINTS,
                max_samples=MAX_SAMPLES,
            )
            if built is None:
                return []
            pts, times = built
            t0 = pts[0]["t_sec"]

            pending: list[dict[str, float]] = []
            for t_sec in times:
                pos = point_at_track_time(pts, t_sec, t0)
                if pos is None:
                    continue
                pending.append(
                    {
                        "t_sec": float(t_sec),
                        "lat": float(pos["lat"]),
                        "lon": float(pos["lon"]),
                    }
                )

            groups: dict[str, list[tuple[int, dict[str, float]]]] = defaultdict(list)
            for idx, sample in enumerate(pending):
                self.stats.add(zoom_tries=1)
                stem = tile_stem(sample["lat"], sample["lon"])
                groups[stem].append((idx, sample))

            stems = list(groups.keys())
            self._prefetch_stems(stems)

            out: dict[int, dict[str, float]] = {}
            for stem, items in groups.items():
                out.update(self._sample_stem(stem, items))

            samples = [out[i] for i in sorted(out)]
            self.stats.add(samples=len(samples), unique_tiles=len(stems))
            self.last_sample_stats = self.stats.as_dict()
            if DEBUG:
                _log.info("glo30 sample_line %s", self.last_sample_stats)
            return samples


_dem_lock = threading.Lock()
_dem: Glo30DEM | None = None


def get_dem() -> Glo30DEM:
    global _dem
    with _dem_lock:
        if _dem is None:
            _dem = Glo30DEM()
        return _dem


def reset_dem_for_tests() -> None:
    global _dem
    with _dem_lock:
        if _dem is not None:
            _dem.close()
            _dem = None


def elevation_at(lat: float, lon: float) -> float | None:
    return get_dem().elevation_at(lat, lon)


def sample_line(
    points: list[dict[str, float]], interval_sec: float
) -> list[dict[str, float]]:
    return get_dem().sample_line(points, interval_sec)
