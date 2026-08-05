"""Mapterhorn DEM lookup via PMTiles (Terrarium WEBP) with on-disk tile cache.

Mirrors browser routing in ``src/dem/mapterhorn.js``:
  z ≤ 12 → planet.pmtiles
  z > 12 → 6-{rx}-{ry}.pmtiles  (rx = x>>(z-6), ry = y>>(z-6))
  try z=15 … fall back to planet maxZoom (12).
"""

from __future__ import annotations

import gzip
import io
import math
import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import httpx
from pmtiles.reader import Reader
from pmtiles.tile import Compression

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
DECODE_LRU_MAX = 32
MIN_INTERVAL_SEC = 15
MAX_LINE_POINTS = 5000
MAX_SAMPLES = 2000

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


class DiskTileCache:
    """On-disk LRU of raw tile bytes, capped by total size."""

    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, archive: str, z: int, x: int, y: int) -> Path:
        safe = archive.replace("..", "_").replace("/", "_")
        return self.root / safe / str(z) / str(x) / f"{y}.tile"

    def get(self, archive: str, z: int, x: int, y: int) -> bytes | None:
        path = self._path(archive, z, x, y)
        with self._lock:
            if not path.is_file():
                return None
            try:
                data = path.read_bytes()
                os.utime(path, None)
                return data
            except OSError:
                return None

    def put(self, archive: str, z: int, x: int, y: int, data: bytes) -> None:
        if self.max_bytes <= 0 or not data:
            return
        path = self._path(archive, z, x, y)
        with self._lock:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(data)
                tmp.replace(path)
            except OSError:
                return
            self._evict_locked()

    def total_bytes(self) -> int:
        total = 0
        try:
            for p in self.root.rglob("*.tile"):
                try:
                    total += p.stat().st_size
                except OSError:
                    continue
        except OSError:
            return 0
        return total

    def _evict_locked(self) -> None:
        if self.max_bytes <= 0:
            return
        files: list[tuple[float, int, Path]] = []
        total = 0
        try:
            for p in self.root.rglob("*.tile"):
                try:
                    st = p.stat()
                except OSError:
                    continue
                files.append((st.st_atime, st.st_size, p))
                total += st.st_size
        except OSError:
            return
        if total <= self.max_bytes:
            return
        files.sort(key=lambda t: t[0])  # oldest atime first
        for _atime, size, path in files:
            if total <= self.max_bytes:
                break
            try:
                path.unlink(missing_ok=True)
                total -= size
            except OSError:
                continue


class _HttpRangeSource:
    """PMTiles get_bytes via HTTP Range requests (connection reuse)."""

    def __init__(self, url: str, client: httpx.Client):
        self.url = url
        self.client = client

    def __call__(self, offset: int, length: int) -> bytes:
        end = offset + length - 1
        r = self.client.get(
            self.url,
            headers={"Range": f"bytes={offset}-{end}"},
        )
        r.raise_for_status()
        return r.content


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
            timeout=httpx.Timeout(60.0, connect=15.0),
            trust_env=False,
            headers={"User-Agent": "trajectories-mapterhorn/0.1"},
        )
        self._readers: dict[str, Reader] = {}
        self._readers_lock = threading.Lock()
        self._decode_lru: OrderedDict[str, Image.Image] = OrderedDict()
        self._decode_lock = threading.Lock()
        self._regional_max_zoom: dict[str, int] = {}
        self._planet_max_zoom = PLANET_MAX_ZOOM
        self._tile_size = DEFAULT_TILE_SIZE
        self._init_done = False
        self._init_lock = threading.Lock()
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
                return
            try:
                reader = self._reader("planet")
                header = reader.header()
                self._planet_max_zoom = int(header.get("max_zoom") or PLANET_MAX_ZOOM)
                # Probe a mid-tile for size when available.
                z = min(self._planet_max_zoom, max(int(header.get("min_zoom") or 0), 8))
                n = 2**z
                data = reader.get(z, n // 2, n // 2)
                if data:
                    data = self._maybe_decompress(header, data)
                    img = decode_terrarium_tile(data)
                    self._tile_size = img.width or DEFAULT_TILE_SIZE
            except Exception:
                self._planet_max_zoom = PLANET_MAX_ZOOM
                self._tile_size = DEFAULT_TILE_SIZE
            self._init_done = True

    def _reader(self, archive: str) -> Reader:
        with self._readers_lock:
            hit = self._readers.get(archive)
            if hit is not None:
                return hit
            url = f"{self.base_url}/{archive}.pmtiles"
            src = _HttpRangeSource(url, self._client)
            reader = Reader(src)
            self._readers[archive] = reader
            return reader

    @staticmethod
    def _maybe_decompress(header: dict[str, Any], data: bytes) -> bytes:
        comp = header.get("tile_compression")
        if comp == Compression.GZIP:
            return gzip.decompress(data)
        return data

    def fetch_tile(self, archive: str, z: int, x: int, y: int) -> bytes | None:
        if self._fetch_tile_fn is not None:
            return self._fetch_tile_fn(archive, z, x, y)
        cached = self.disk.get(archive, z, x, y)
        if cached is not None:
            return cached
        try:
            reader = self._reader(archive)
            header = reader.header()
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
                return self._decode_lru[key]
        data = self.fetch_tile(archive, z, x, y)
        if not data:
            return None
        try:
            img = decode_terrarium_tile(data)
        except Exception:
            return None
        with self._decode_lock:
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
        self._ensure_init()
        planet_z = self._planet_max_zoom
        for z in range(MAX_ZOOM_TRY, planet_z - 1, -1):
            x, y = tile_xy(lat, lon, z)
            archive = archive_for(z, x, y, planet_z)
            if z > planet_z:
                known = self._regional_max_zoom.get(archive)
                if known is not None and z > known:
                    continue
            img = self._decoded(archive, z, x, y)
            if img is None:
                if z > planet_z:
                    prev = self._regional_max_zoom.get(archive)
                    if prev is None or z - 1 < prev:
                        self._regional_max_zoom[archive] = z - 1
                continue
            size = img.width or self._tile_size
            px, py = pixel_in_tile(lat, lon, z, size)
            try:
                elev = elevation_from_rgba(img, px, py)
            except Exception:
                continue
            if math.isfinite(elev):
                return float(elev)
        return None

    def sample_line(
        self,
        points: list[dict[str, float]],
        interval_sec: float,
    ) -> list[dict[str, float]]:
        """Time-uniform samples along a timed polyline (like browser sampleTrackTerrain)."""
        if not points or len(points) < 2:
            return []
        self._ensure_init()
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

        # Resolve positions first, then elevate (tile grouping via decode LRU).
        samples: list[dict[str, float]] = []
        for t_sec in times:
            pos = _point_at_track_time(pts, t_sec, t0)
            if pos is None:
                continue
            z = self.elevation_at(pos["lat"], pos["lon"])
            if z is None or not math.isfinite(z):
                continue
            samples.append(
                {
                    "t_sec": float(t_sec),
                    "lat": float(pos["lat"]),
                    "lon": float(pos["lon"]),
                    "z": float(z),
                }
            )
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
