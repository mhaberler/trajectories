"""AWS Terrain Tiles (Joerd) DEM via Terrarium PNG + on-disk tile cache.

Fixed zoom (default 12). URL shape:
  {base}/terrarium/{z}/{x}/{y}.png
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

import httpx

from .dem_common import (
    DemStats,
    DiskTileCache,
    build_sample_times,
    env_flag,
    env_int,
    env_path,
    point_at_track_time,
)
from .terrarium import (
    decode_terrarium_tile,
    elevation_from_rgba,
    pixel_in_tile,
    tile_xy,
)

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "Pillow is required for Joerd DEM decode. "
        'Install with: pip install -e "python/[api]"'
    ) from exc

BASE_URL = os.environ.get(
    "TRAJECTORIES_JOERD_BASE", "https://s3.amazonaws.com/elevation-tiles-prod"
).rstrip("/")
ZOOM = env_int("TRAJECTORIES_JOERD_ZOOM", 12)
TILE_SIZE = 256
DECODE_LRU_MAX = 128
MIN_INTERVAL_SEC = 15
MAX_LINE_POINTS = 5000
MAX_SAMPLES = 2000
FETCH_CONCURRENCY = 4
HTTP_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
DEBUG = env_flag("TRAJECTORIES_JOERD_DEBUG") or env_flag("TRAJECTORIES_DEM_DEBUG")
ARCHIVE = "terrarium"

_log = logging.getLogger(__name__)
_DEFAULT_CACHE = Path("/var/cache/trajectories/joerd")
_DEFAULT_CACHE_MAX = 5 * 1024 * 1024 * 1024

CACHE_DIR = env_path("TRAJECTORIES_JOERD_CACHE", _DEFAULT_CACHE)
CACHE_MAX_BYTES = env_int("TRAJECTORIES_JOERD_CACHE_MAX_BYTES", _DEFAULT_CACHE_MAX)


class JoerdDEMError(RuntimeError):
    """Raised when Joerd HTTP/decode fails (no silent fallback)."""


class JoerdDEM:
    """Process-wide Joerd Terrarium sampler with disk + decode caches."""

    def __init__(
        self,
        *,
        cache_dir: Path | None = None,
        cache_max_bytes: int | None = None,
        base_url: str | None = None,
        zoom: int | None = None,
        client: httpx.Client | None = None,
        fetch_tile_fn: Callable[[int, int, int], bytes | None] | None = None,
    ):
        self.base_url = (base_url or BASE_URL).rstrip("/")
        self.zoom = int(ZOOM if zoom is None else zoom)
        if not (0 <= self.zoom <= 15):
            raise ValueError(f"Joerd zoom must be 0..15, got {self.zoom}")
        self.disk = DiskTileCache(
            cache_dir if cache_dir is not None else CACHE_DIR,
            cache_max_bytes if cache_max_bytes is not None else CACHE_MAX_BYTES,
        )
        self._owns_client = client is None
        self._client = client or httpx.Client(
            timeout=HTTP_TIMEOUT,
            trust_env=False,
            headers={"User-Agent": "trajectories-joerd/0.1"},
        )
        self.stats = DemStats()
        self.last_sample_stats: dict[str, int | float] | None = None
        self._decode_lru: OrderedDict[str, Image.Image] = OrderedDict()
        self._decode_lock = threading.Lock()
        self._fetch_sem = threading.Semaphore(FETCH_CONCURRENCY)
        self._fetch_tile_fn = fetch_tile_fn

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _tile_url(self, z: int, x: int, y: int) -> str:
        return f"{self.base_url}/terrarium/{z}/{x}/{y}.png"

    def fetch_tile(self, z: int, x: int, y: int) -> bytes:
        cached = self.disk.get(ARCHIVE, z, x, y)
        if cached is not None:
            self.stats.add(disk_hits=1)
            return cached
        self.stats.add(disk_misses=1)
        if self._fetch_tile_fn is not None:
            data = self._fetch_tile_fn(z, x, y)
            if not data:
                raise JoerdDEMError(f"Joerd tile missing {z}/{x}/{y}")
            self.disk.put(ARCHIVE, z, x, y, data)
            return data
        url = self._tile_url(z, x, y)
        t0 = time.perf_counter()
        try:
            with self._fetch_sem:
                r = self._client.get(url)
            self.stats.add(
                http_gets=1,
                http_bytes=len(r.content),
                http_ms=(time.perf_counter() - t0) * 1000.0,
            )
            if r.status_code != 200:
                raise JoerdDEMError(
                    f"Joerd HTTP {r.status_code} for {z}/{x}/{y}"
                )
            data = r.content
        except JoerdDEMError:
            raise
        except Exception as exc:
            raise JoerdDEMError(f"Joerd fetch failed {z}/{x}/{y}: {exc}") from exc
        if not data:
            raise JoerdDEMError(f"Joerd empty tile {z}/{x}/{y}")
        self.disk.put(ARCHIVE, z, x, y, data)
        return data

    def _decoded(self, z: int, x: int, y: int) -> Image.Image:
        key = f"{ARCHIVE}/{z}/{x}/{y}"
        with self._decode_lock:
            if key in self._decode_lru:
                self._decode_lru.move_to_end(key)
                self.stats.add(decode_hits=1)
                return self._decode_lru[key]
        self.stats.add(decode_misses=1)
        data = self.fetch_tile(z, x, y)
        try:
            img = decode_terrarium_tile(data)
        except Exception as exc:
            raise JoerdDEMError(f"Joerd decode failed {z}/{x}/{y}: {exc}") from exc
        with self._decode_lock:
            existing = self._decode_lru.get(key)
            if existing is not None:
                self._decode_lru.move_to_end(key)
                return existing
            self._decode_lru[key] = img
            self._decode_lru.move_to_end(key)
            while len(self._decode_lru) > DECODE_LRU_MAX:
                self._decode_lru.popitem(last=False)
        return img

    def elevation_at(self, lat: float, lon: float) -> float | None:
        if not math.isfinite(lat) or not math.isfinite(lon):
            return None
        if abs(lat) > 90 or abs(lon) > 180:
            return None
        z = self.zoom
        x, y = tile_xy(lat, lon, z)
        self.stats.add(zoom_tries=1)
        img = self._decoded(z, x, y)
        px, py = pixel_in_tile(lat, lon, z, img.width or TILE_SIZE)
        elev = elevation_from_rgba(img, px, py)
        if math.isfinite(elev):
            return float(elev)
        return None

    def _prefetch_tiles(self, keys: list[tuple[int, int, int]]) -> None:
        if not keys:
            return

        def _fetch(key: tuple[int, int, int]) -> None:
            z, x, y = key
            self.fetch_tile(z, x, y)

        if len(keys) == 1 or self._fetch_tile_fn is not None:
            for key in keys:
                _fetch(key)
        else:
            with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as pool:
                futs = [pool.submit(_fetch, k) for k in keys]
                for fut in as_completed(futs):
                    fut.result()
        for z, x, y in keys:
            self._decoded(z, x, y)

    def sample_line(
        self,
        points: list[dict[str, float]],
        interval_sec: float,
    ) -> list[dict[str, float]]:
        if not points or len(points) < 2:
            return []
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
        z = self.zoom

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

        groups: dict[tuple[int, int, int], list[tuple[int, dict[str, float]]]] = (
            defaultdict(list)
        )
        for idx, sample in enumerate(pending):
            self.stats.add(zoom_tries=1)
            x, y = tile_xy(sample["lat"], sample["lon"], z)
            groups[(z, x, y)].append((idx, sample))

        keys = list(groups.keys())
        self._prefetch_tiles(keys)

        out: dict[int, dict[str, float]] = {}
        for key, items in groups.items():
            zz, x, y = key
            img = self._decoded(zz, x, y)
            size = img.width or TILE_SIZE
            for idx, sample in items:
                px, py = pixel_in_tile(sample["lat"], sample["lon"], zz, size)
                elev = elevation_from_rgba(img, px, py)
                if not math.isfinite(elev):
                    continue
                out[idx] = {
                    "t_sec": sample["t_sec"],
                    "lat": sample["lat"],
                    "lon": sample["lon"],
                    "z": float(elev),
                }

        samples = [out[i] for i in sorted(out)]
        self.stats.add(samples=len(samples), unique_tiles=len(keys))
        self.last_sample_stats = self.stats.as_dict()
        if DEBUG:
            _log.info("joerd sample_line %s", self.last_sample_stats)
        return samples


_dem_lock = threading.Lock()
_dem: JoerdDEM | None = None


def get_dem() -> JoerdDEM:
    global _dem
    with _dem_lock:
        if _dem is None:
            _dem = JoerdDEM()
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
