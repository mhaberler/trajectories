"""Mapterhorn DEM lookup via PMTiles (Terrarium WEBP) with on-disk tile cache.

Mirrors browser routing in ``src/dem/mapterhorn.js``:
  z ≤ 12 → planet.pmtiles
  z > 12 → 6-{rx}-{ry}.pmtiles  (rx = x>>(z-6), ry = y>>(z-6))
  try sticky/max zoom … fall back to planet maxZoom (12).
"""

from __future__ import annotations

import gzip
import io
import logging
import math
import os
import threading
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

import httpx
from pmtiles.tile import (
    Compression,
    deserialize_directory,
    deserialize_header,
    find_tile,
    zxy_to_tileid,
)

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "Pillow is required for Mapterhorn DEM decode. "
        'Install with: pip install -e "python/[api]"'
    ) from exc

BASE_URL = os.environ.get(
    "TRAJECTORIES_MAPTERHORN_BASE", "https://download.mapterhorn.com"
).rstrip("/")
PLANET_MAX_ZOOM = 12
MAX_ZOOM_TRY = 15
DEFAULT_TILE_SIZE = 512
DECODE_LRU_MAX = 128
MIN_INTERVAL_SEC = 15
MAX_LINE_POINTS = 5000
MAX_SAMPLES = 2000
# Cap concurrent PMTiles Range GETs so elevation/line cannot stampede httpx.
FETCH_CONCURRENCY = 4
# Keep Range GETs short — download.mapterhorn.com can stall and pin workers.
HTTP_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
# Line sampling: planet zoom is enough for Querschnitt/Flugprofil terrain.
LINE_MAX_ZOOM = PLANET_MAX_ZOOM
DEBUG = os.environ.get("TRAJECTORIES_MAPTERHORN_DEBUG", "").strip() not in ("", "0", "false")

_log = logging.getLogger(__name__)

_DEFAULT_CACHE = Path("/var/cache/trajectories/mapterhorn")
_DEFAULT_CACHE_MAX = 5 * 1024 * 1024 * 1024  # 5 GiB


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return Path(raw).expanduser()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


CACHE_DIR = _env_path("TRAJECTORIES_MAPTERHORN_CACHE", _DEFAULT_CACHE)
CACHE_MAX_BYTES = _env_int("TRAJECTORIES_MAPTERHORN_CACHE_MAX_BYTES", _DEFAULT_CACHE_MAX)


def tile_xy(lat: float, lon: float, z: int) -> tuple[int, int]:
    lat_rad = math.radians(lat)
    n = 2**z
    x = int(math.floor(((lon + 180.0) / 360.0) * n))
    y = int(math.floor((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n))
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def pixel_in_tile(lat: float, lon: float, z: int, size: int) -> tuple[int, int]:
    lat_rad = math.radians(lat)
    map_size = size * (2**z)
    px = int(math.floor(((lon + 180.0) / 360.0) * map_size) % size)
    py = int(math.floor((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * map_size) % size)
    return px, py


def regional_name(x: int, y: int, z: int) -> str:
    rx = x >> (z - 6)
    ry = y >> (z - 6)
    return f"6-{rx}-{ry}"


def archive_for(z: int, x: int, y: int, planet_max_zoom: int = PLANET_MAX_ZOOM) -> str:
    if z <= planet_max_zoom:
        return "planet"
    return regional_name(x, y, z)


def terrarium_elevation(r: int, g: int, b: int) -> float:
    return r * 256.0 + g + b / 256.0 - 32768.0


def decode_terrarium_tile(tile_bytes: bytes) -> Image.Image:
    """Decode a Terrarium WEBP/PNG tile to RGBA."""
    img = Image.open(io.BytesIO(tile_bytes))
    return img.convert("RGBA")


def elevation_from_rgba(img: Image.Image, px: int, py: int) -> float:
    w, h = img.size
    cx = max(0, min(px, w - 1))
    cy = max(0, min(py, h - 1))
    r, g, b, _a = img.getpixel((cx, cy))
    return terrarium_elevation(int(r), int(g), int(b))


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
                "http_bytes": self.http_bytes,
                "http_ms": round(self.http_ms, 2),
                "zoom_tries": self.zoom_tries,
                "zoom_misses": self.zoom_misses,
            }


class DiskTileCache:
    """On-disk LRU of raw tile bytes, capped by total size.

    Size accounting is in-memory (``_lru`` path→size). Eviction never
    ``rglob``s the tree on the request path — a full scan only runs once at
    construction to seed the index for a pre-existing cache directory.
    """

    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()
        self._lru: OrderedDict[str, int] = OrderedDict()  # path -> size
        self._total = 0
        self.root.mkdir(parents=True, exist_ok=True)
        self._reindex()

    def _path(self, archive: str, z: int, x: int, y: int) -> Path:
        safe = archive.replace("..", "_").replace("/", "_")
        return self.root / safe / str(z) / str(x) / f"{y}.tile"

    def _reindex(self) -> None:
        """One-time scan at startup (not on the hot put/get path)."""
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
        files.sort(key=lambda t: t[0])  # oldest first → LRU order
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


class _HttpRangeSource:
    """PMTiles get_bytes via HTTP Range requests (connection reuse)."""

    def __init__(self, url: str, client: httpx.Client, stats: DemStats | None = None):
        self.url = url
        self.client = client
        self.stats = stats

    def __call__(self, offset: int, length: int) -> bytes:
        end = offset + length - 1
        t0 = time.perf_counter()
        r = self.client.get(
            self.url,
            headers={"Range": f"bytes={offset}-{end}"},
        )
        r.raise_for_status()
        data = r.content
        if self.stats is not None:
            self.stats.add(
                http_ranges=1,
                http_bytes=len(data),
                http_ms=(time.perf_counter() - t0) * 1000.0,
            )
        return data


class CachedPmtilesReader:
    """PMTiles reader that caches header and directory entries per archive.

    Unlike stock ``pmtiles.reader.Reader``, ``header()`` and each directory
    blob are fetched at most once per reader lifetime.
    """

    def __init__(self, get_bytes: Callable[[int, int], bytes]):
        self.get_bytes = get_bytes
        self._header: dict[str, Any] | None = None
        self._header_lock = threading.Lock()
        self._dir_cache: dict[tuple[int, int], list] = {}
        self._dir_lock = threading.Lock()

    def header(self) -> dict[str, Any]:
        with self._header_lock:
            if self._header is None:
                self._header = deserialize_header(self.get_bytes(0, 127))
            return self._header

    def _directory(self, offset: int, length: int) -> list:
        key = (offset, length)
        with self._dir_lock:
            hit = self._dir_cache.get(key)
            if hit is not None:
                return hit
        directory = deserialize_directory(self.get_bytes(offset, length))
        with self._dir_lock:
            self._dir_cache[key] = directory
            return directory

    def get(self, z: int, x: int, y: int) -> bytes | None:
        tile_id = zxy_to_tileid(z, x, y)
        header = self.header()
        dir_offset = header["root_offset"]
        dir_length = header["root_length"]
        for _depth in range(0, 4):
            directory = self._directory(dir_offset, dir_length)
            result = find_tile(directory, tile_id)
            if not result:
                return None
            if result.run_length == 0:
                dir_offset = header["leaf_directory_offset"] + result.offset
                dir_length = result.length
                continue
            return self.get_bytes(
                header["tile_data_offset"] + result.offset, result.length
            )
        return None


class MapterhornDEM:
    """Process-wide DEM sampler with disk + decode caches."""

    def __init__(
        self,
        *,
        cache_dir: Path | None = None,
        cache_max_bytes: int | None = None,
        base_url: str | None = None,
        client: httpx.Client | None = None,
        fetch_tile_fn: Callable[[str, int, int, int], bytes | None] | None = None,
    ):
        self.base_url = (base_url or BASE_URL).rstrip("/")
        self.disk = DiskTileCache(
            cache_dir if cache_dir is not None else CACHE_DIR,
            cache_max_bytes if cache_max_bytes is not None else CACHE_MAX_BYTES,
        )
        self._owns_client = client is None
        self._client = client or httpx.Client(
            timeout=HTTP_TIMEOUT,
            trust_env=False,
            headers={"User-Agent": "trajectories-mapterhorn/0.1"},
        )
        self.stats = DemStats()
        self.last_sample_stats: dict[str, int | float] | None = None
        self._readers: dict[str, CachedPmtilesReader] = {}
        self._readers_lock = threading.Lock()
        self._decode_lru: OrderedDict[str, Image.Image] = OrderedDict()
        self._decode_lock = threading.Lock()
        self._regional_max_zoom: dict[str, int] = {}
        self._sticky_zoom: int | None = None
        self._sticky_lock = threading.Lock()
        self._planet_max_zoom = PLANET_MAX_ZOOM
        self._tile_size = DEFAULT_TILE_SIZE
        self._init_done = False
        self._init_probing = False
        self._init_lock = threading.Lock()
        self._init_event = threading.Event()
        self._fetch_sem = threading.Semaphore(FETCH_CONCURRENCY)
        self._fetch_tile_fn = fetch_tile_fn  # test hook: (archive,z,x,y)->bytes|None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _ensure_init(self) -> None:
        if self._init_done:
            return
        with self._init_lock:
            if self._init_done:
                return
            if self._fetch_tile_fn is not None:
                self._init_done = True
                self._init_event.set()
                return
            # One thread probes over the network; others wait on the event.
            i_am_prober = not self._init_probing
            if i_am_prober:
                self._init_probing = True

        if not i_am_prober:
            self._init_event.wait(timeout=60.0)
            return

        planet_max = PLANET_MAX_ZOOM
        tile_size = DEFAULT_TILE_SIZE
        try:
            reader = self._reader("planet")
            header = reader.header()
            planet_max = int(header.get("max_zoom") or PLANET_MAX_ZOOM)
            z = min(planet_max, max(int(header.get("min_zoom") or 0), 8))
            n = 2**z
            with self._fetch_sem:
                data = reader.get(z, n // 2, n // 2)
            if data:
                data = self._maybe_decompress(header, data)
                img = decode_terrarium_tile(data)
                tile_size = img.width or DEFAULT_TILE_SIZE
        except Exception:
            planet_max = PLANET_MAX_ZOOM
            tile_size = DEFAULT_TILE_SIZE
        with self._init_lock:
            self._planet_max_zoom = planet_max
            self._tile_size = tile_size
            self._init_done = True
            self._init_probing = False
            self._init_event.set()

    def _reader(self, archive: str) -> CachedPmtilesReader:
        with self._readers_lock:
            hit = self._readers.get(archive)
            if hit is not None:
                return hit
            url = f"{self.base_url}/{archive}.pmtiles"
            src = _HttpRangeSource(url, self._client, self.stats)
            reader = CachedPmtilesReader(src)
            self._readers[archive] = reader
            return reader

    @staticmethod
    def _maybe_decompress(header: dict[str, Any], data: bytes) -> bytes:
        comp = header.get("tile_compression")
        if comp == Compression.GZIP:
            return gzip.decompress(data)
        return data

    def fetch_tile(self, archive: str, z: int, x: int, y: int) -> bytes | None:
        cached = self.disk.get(archive, z, x, y)
        if cached is not None:
            self.stats.add(disk_hits=1)
            return cached
        self.stats.add(disk_misses=1)
        if self._fetch_tile_fn is not None:
            data = self._fetch_tile_fn(archive, z, x, y)
            if data:
                self.disk.put(archive, z, x, y, data)
            return data
        try:
            reader = self._reader(archive)
            header = reader.header()
            with self._fetch_sem:
                data = reader.get(z, x, y)
            if not data:
                return None
            data = self._maybe_decompress(header, data)
            self.disk.put(archive, z, x, y, data)
            return data
        except Exception:
            return None

    def _decoded(self, archive: str, z: int, x: int, y: int) -> Image.Image | None:
        key = f"{archive}/{z}/{x}/{y}"
        with self._decode_lock:
            if key in self._decode_lru:
                self._decode_lru.move_to_end(key)
                self.stats.add(decode_hits=1)
                return self._decode_lru[key]
        self.stats.add(decode_misses=1)
        data = self.fetch_tile(archive, z, x, y)
        if not data:
            return None
        try:
            img = decode_terrarium_tile(data)
        except Exception:
            return None
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

    def _start_zoom(self) -> int:
        with self._sticky_lock:
            sticky = self._sticky_zoom
        if sticky is not None:
            return max(self._planet_max_zoom, min(MAX_ZOOM_TRY, sticky))
        return MAX_ZOOM_TRY

    def _note_zoom_hit(self, z: int) -> None:
        with self._sticky_lock:
            self._sticky_zoom = z

    def _note_regional_miss(self, archive: str, z: int, planet_z: int) -> None:
        if z <= planet_z:
            return
        prev = self._regional_max_zoom.get(archive)
        if prev is None or z - 1 < prev:
            self._regional_max_zoom[archive] = z - 1

    def _zoom_allowed(self, archive: str, z: int, planet_z: int) -> bool:
        if z <= planet_z:
            return True
        known = self._regional_max_zoom.get(archive)
        if known is not None and z > known:
            return False
        return True

    def elevation_at(self, lat: float, lon: float) -> float | None:
        if not math.isfinite(lat) or not math.isfinite(lon):
            return None
        if abs(lat) > 90 or abs(lon) > 180:
            return None
        self._ensure_init()
        planet_z = self._planet_max_zoom
        start_z = self._start_zoom()
        for z in range(start_z, planet_z - 1, -1):
            self.stats.add(zoom_tries=1)
            x, y = tile_xy(lat, lon, z)
            archive = archive_for(z, x, y, planet_z)
            if not self._zoom_allowed(archive, z, planet_z):
                self.stats.add(zoom_misses=1)
                continue
            img = self._decoded(archive, z, x, y)
            if img is None:
                self.stats.add(zoom_misses=1)
                self._note_regional_miss(archive, z, planet_z)
                continue
            size = img.width or self._tile_size
            px, py = pixel_in_tile(lat, lon, z, size)
            try:
                elev = elevation_from_rgba(img, px, py)
            except Exception:
                self.stats.add(zoom_misses=1)
                continue
            if math.isfinite(elev):
                self._note_zoom_hit(z)
                return float(elev)
        # Sticky zoom may be below a higher tile that exists; try above once.
        if start_z < MAX_ZOOM_TRY:
            for z in range(MAX_ZOOM_TRY, start_z, -1):
                self.stats.add(zoom_tries=1)
                x, y = tile_xy(lat, lon, z)
                archive = archive_for(z, x, y, planet_z)
                if not self._zoom_allowed(archive, z, planet_z):
                    self.stats.add(zoom_misses=1)
                    continue
                img = self._decoded(archive, z, x, y)
                if img is None:
                    self.stats.add(zoom_misses=1)
                    self._note_regional_miss(archive, z, planet_z)
                    continue
                size = img.width or self._tile_size
                px, py = pixel_in_tile(lat, lon, z, size)
                try:
                    elev = elevation_from_rgba(img, px, py)
                except Exception:
                    self.stats.add(zoom_misses=1)
                    continue
                if math.isfinite(elev):
                    self._note_zoom_hit(z)
                    return float(elev)
        return None

    def _prefetch_tiles(self, keys: list[tuple[str, int, int, int]]) -> None:
        """Warm disk cache for unique tiles (concurrent HTTP), then decode."""
        if not keys:
            return

        def _fetch(key: tuple[str, int, int, int]) -> None:
            archive, z, x, y = key
            self.fetch_tile(archive, z, x, y)

        if len(keys) == 1 or self._fetch_tile_fn is not None:
            for key in keys:
                _fetch(key)
        else:
            with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as pool:
                futs = [pool.submit(_fetch, k) for k in keys]
                for fut in as_completed(futs):
                    try:
                        fut.result()
                    except Exception:
                        continue
        for archive, z, x, y in keys:
            self._decoded(archive, z, x, y)

    def sample_line(
        self,
        points: list[dict[str, float]],
        interval_sec: float,
    ) -> list[dict[str, float]]:
        """Time-uniform samples along a timed polyline (like browser sampleTrackTerrain)."""
        if not points or len(points) < 2:
            return []
        self._ensure_init()
        self.stats.reset()
        interval = max(MIN_INTERVAL_SEC, float(interval_sec or 60))
        pts = []
        for p in points[:MAX_LINE_POINTS]:
            lat = float(p.get("lat", float("nan")))
            lon = float(p.get("lon", float("nan")))
            t = float(p.get("t_sec", p.get("tSec", float("nan"))))
            if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(t)):
                continue
            pts.append({"lat": lat, "lon": lon, "t_sec": t})
        if len(pts) < 2:
            return []
        pts.sort(key=lambda q: q["t_sec"])
        t0 = pts[0]["t_sec"]
        t_end = pts[-1]["t_sec"] - t0
        if t_end < 0:
            return []

        times = [0.0]
        t = interval
        while t < t_end - 1e-6:
            times.append(t)
            t += interval
            if len(times) >= MAX_SAMPLES - 1:
                break
        if t_end > 0:
            times.append(t_end)
        times = times[:MAX_SAMPLES]

        pending: list[dict[str, float]] = []
        for t_sec in times:
            pos = _point_at_track_time(pts, t_sec, t0)
            if pos is None:
                continue
            pending.append(
                {
                    "t_sec": float(t_sec),
                    "lat": float(pos["lat"]),
                    "lon": float(pos["lon"]),
                }
            )

        planet_z = self._planet_max_zoom
        # Prefer sticky zoom when already learned, else planet (not z=15).
        # High-zoom regional tiles multiply unique HTTP Ranges along a track.
        with self._sticky_lock:
            sticky = self._sticky_zoom
        line_max = min(LINE_MAX_ZOOM, MAX_ZOOM_TRY)
        if sticky is not None:
            start_z = max(planet_z, min(line_max, sticky))
        else:
            start_z = planet_z
        zoom_order = list(range(start_z, planet_z - 1, -1))

        out: dict[int, dict[str, float]] = {}
        remaining = list(enumerate(pending))
        seen_tiles: set[tuple[str, int, int, int]] = set()

        for z in zoom_order:
            if not remaining:
                break
            groups: dict[tuple[str, int, int, int], list[tuple[int, dict[str, float]]]] = (
                defaultdict(list)
            )
            next_remaining: list[tuple[int, dict[str, float]]] = []
            for idx, sample in remaining:
                self.stats.add(zoom_tries=1)
                x, y = tile_xy(sample["lat"], sample["lon"], z)
                archive = archive_for(z, x, y, planet_z)
                if not self._zoom_allowed(archive, z, planet_z):
                    self.stats.add(zoom_misses=1)
                    next_remaining.append((idx, sample))
                    continue
                groups[(archive, z, x, y)].append((idx, sample))

            keys = list(groups.keys())
            for k in keys:
                seen_tiles.add(k)
            self._prefetch_tiles(keys)

            for key, items in groups.items():
                archive, zz, x, y = key
                img = self._decoded(archive, zz, x, y)
                if img is None:
                    self.stats.add(zoom_misses=len(items))
                    self._note_regional_miss(archive, zz, planet_z)
                    next_remaining.extend(items)
                    continue
                size = img.width or self._tile_size
                self._note_zoom_hit(zz)
                for idx, sample in items:
                    px, py = pixel_in_tile(sample["lat"], sample["lon"], zz, size)
                    try:
                        elev = elevation_from_rgba(img, px, py)
                    except Exception:
                        self.stats.add(zoom_misses=1)
                        next_remaining.append((idx, sample))
                        continue
                    if not math.isfinite(elev):
                        self.stats.add(zoom_misses=1)
                        next_remaining.append((idx, sample))
                        continue
                    out[idx] = {
                        "t_sec": sample["t_sec"],
                        "lat": sample["lat"],
                        "lon": sample["lon"],
                        "z": float(elev),
                    }
            remaining = next_remaining

        samples = [out[i] for i in sorted(out)]
        self.stats.add(samples=len(samples), unique_tiles=len(seen_tiles))
        self.last_sample_stats = self.stats.as_dict()
        if DEBUG:
            _log.info("mapterhorn sample_line %s", self.last_sample_stats)
        return samples


def _point_at_track_time(
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


_dem_lock = threading.Lock()
_dem: MapterhornDEM | None = None


def get_dem() -> MapterhornDEM:
    global _dem
    with _dem_lock:
        if _dem is None:
            _dem = MapterhornDEM()
        return _dem


def reset_dem_for_tests() -> None:
    """Close and drop the process singleton (tests only)."""
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
