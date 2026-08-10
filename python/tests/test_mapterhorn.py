"""Unit tests for Mapterhorn DEM helpers (mocked tiles; no network)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

pytest.importorskip("PIL")
pytest.importorskip("pmtiles")

from PIL import Image
from pmtiles.reader import Reader
from pmtiles.tile import (
    Compression,
    Entry,
    TileType,
    serialize_directory,
    serialize_header,
    zxy_to_tileid,
)

from trajectories.mapterhorn import (
    CachedPmtilesReader,
    DiskTileCache,
    MapterhornDEM,
    elevation_from_rgba,
    reset_dem_for_tests,
    terrarium_elevation,
)


def _solid_tile(r: int, g: int, b: int, size: int = 8) -> bytes:
    img = Image.new("RGB", (size, size), (r, g, b))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_terrarium_elevation_formula():
    # sea-level-ish: R=128, G=0, B=0 → 0
    assert terrarium_elevation(128, 0, 0) == 0.0
    assert terrarium_elevation(128, 100, 0) == 100.0


def test_elevation_from_rgba_pixel():
    img = Image.new("RGBA", (4, 4), (128, 50, 0, 255))
    assert elevation_from_rgba(img, 1, 1) == 50.0


def test_disk_cache_get_put_and_evict(tmp_path: Path):
    cache = DiskTileCache(tmp_path, max_bytes=80)
    a = b"x" * 50
    b = b"y" * 50
    cache.put("planet", 12, 1, 1, a)
    assert cache.get("planet", 12, 1, 1) == a
    cache.put("planet", 12, 1, 2, b)
    # Eviction should keep total near max; at least one tile remains.
    total = cache.total_bytes()
    assert total <= 80
    assert cache.get("planet", 12, 1, 1) is not None or cache.get("planet", 12, 1, 2) is not None


def test_sample_line_with_mocked_tiles(tmp_path: Path):
    reset_dem_for_tests()
    # Constant elev ~100 m (R=128, G=100) — PNG so RGB is exact.
    tile = _solid_tile(128, 100, 0, size=16)

    def fetch(_archive: str, _z: int, _x: int, _y: int) -> bytes | None:
        return tile

    dem = MapterhornDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        fetch_tile_fn=fetch,
    )
    dem._init_done = True
    dem._tile_size = 16
    dem._planet_max_zoom = 12

    elev = dem.elevation_at(47.8, 11.3)
    assert elev is not None
    assert abs(elev - 100.0) < 0.1

    pts = [
        {"lat": 47.8, "lon": 11.3, "t_sec": 0},
        {"lat": 47.81, "lon": 11.31, "t_sec": 120},
    ]
    samples = dem.sample_line(pts, interval_sec=60)
    # 0, 60, 120 → 3 samples
    assert len(samples) == 3
    assert samples[0]["t_sec"] == 0
    assert samples[-1]["t_sec"] == 120
    assert all(abs(s["z"] - 100.0) < 0.1 for s in samples)
    dem.close()
    reset_dem_for_tests()


def test_sample_line_fetches_unique_tiles_once(tmp_path: Path):
    """Many samples in one tile → one underlying fetch_tile_fn call."""
    reset_dem_for_tests()
    tile = _solid_tile(128, 80, 0, size=16)
    calls: list[tuple[str, int, int, int]] = []

    def fetch(archive: str, z: int, x: int, y: int) -> bytes | None:
        calls.append((archive, z, x, y))
        return tile

    dem = MapterhornDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        fetch_tile_fn=fetch,
    )
    dem._init_done = True
    dem._tile_size = 16
    dem._planet_max_zoom = 12
    # Stick to planet zoom so all samples share one coarse tile.
    dem._sticky_zoom = 12

    # ~100 m track — well inside one z12 tile.
    pts = [
        {"lat": 47.8000, "lon": 11.3000, "t_sec": 0},
        {"lat": 47.8005, "lon": 11.3005, "t_sec": 300},
    ]
    samples = dem.sample_line(pts, interval_sec=15)
    assert len(samples) >= 10
    assert len(calls) == 1
    assert dem.last_sample_stats is not None
    assert dem.last_sample_stats["unique_tiles"] == 1
    assert dem.last_sample_stats["samples"] == len(samples)
    dem.close()
    reset_dem_for_tests()


def test_sticky_zoom_skips_higher_misses(tmp_path: Path):
    reset_dem_for_tests()
    tile = _solid_tile(128, 90, 0, size=16)
    zooms: list[int] = []

    def fetch(_archive: str, z: int, _x: int, _y: int) -> bytes | None:
        zooms.append(z)
        # Only planet-level tiles exist.
        if z > 12:
            return None
        return tile

    dem = MapterhornDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        fetch_tile_fn=fetch,
    )
    dem._init_done = True
    dem._tile_size = 16
    dem._planet_max_zoom = 12

    assert dem.elevation_at(47.8, 11.3) is not None
    assert dem._sticky_zoom == 12
    first = list(zooms)
    assert max(first) >= 13  # cold path probed above planet zoom
    zooms.clear()

    # Different z12 tile so fetch runs again; sticky must skip z>12.
    assert dem.elevation_at(47.8, 12.0) is not None
    assert zooms == [12]
    dem.close()
    reset_dem_for_tests()


def _minimal_pmtiles_bytes(tile_payload: bytes, z: int = 0, x: int = 0, y: int = 0) -> bytes:
    """Build a tiny in-memory PMTiles v3 archive with one tile."""
    tile_id = zxy_to_tileid(z, x, y)
    entries = [Entry(tile_id=tile_id, offset=0, length=len(tile_payload), run_length=1)]
    root_dir = serialize_directory(entries)
    # header leaves room; layout: header(127) + root + tile data
    root_offset = 127
    tile_data_offset = root_offset + len(root_dir)
    header = {
        "version": 3,
        "root_offset": root_offset,
        "root_length": len(root_dir),
        "metadata_offset": tile_data_offset + len(tile_payload),
        "metadata_length": 0,
        "leaf_directory_offset": 0,
        "leaf_directory_length": 0,
        "tile_data_offset": tile_data_offset,
        "tile_data_length": len(tile_payload),
        "addressed_tiles_count": 1,
        "tile_entries_count": 1,
        "tile_contents_count": 1,
        "clustered": True,
        "internal_compression": Compression.NONE,
        "tile_compression": Compression.NONE,
        "tile_type": TileType.UNKNOWN,
        "min_zoom": z,
        "max_zoom": z,
        "min_lon_e7": -1800000000,
        "min_lat_e7": -850511287,
        "max_lon_e7": 1800000000,
        "max_lat_e7": 850511287,
        "center_zoom": z,
        "center_lon_e7": 0,
        "center_lat_e7": 0,
    }
    hdr = serialize_header(header)
    assert len(hdr) == 127
    return hdr + root_dir + tile_payload


def test_cached_reader_reuses_header_and_directory():
    payload = b"tile-bytes-here!!"
    blob = _minimal_pmtiles_bytes(payload, z=0, x=0, y=0)
    calls: list[tuple[int, int]] = []

    def get_bytes(offset: int, length: int) -> bytes:
        calls.append((offset, length))
        return blob[offset : offset + length]

    cached = CachedPmtilesReader(get_bytes)
    assert cached.get(0, 0, 0) == payload
    after_first = len(calls)
    assert after_first >= 2  # header + directory (+ tile)
    assert cached.get(0, 0, 0) == payload
    after_second = len(calls)
    # Second get: only tile body Range — header/dir served from cache.
    assert after_second == after_first + 1
    assert calls[-1] == (cached.header()["tile_data_offset"], len(payload))

    # Stock Reader re-fetches header every get.
    naive_calls: list[tuple[int, int]] = []

    def naive_get(offset: int, length: int) -> bytes:
        naive_calls.append((offset, length))
        return blob[offset : offset + length]

    naive = Reader(naive_get)
    naive.get(0, 0, 0)
    n1 = len(naive_calls)
    naive.get(0, 0, 0)
    n2 = len(naive_calls)
    assert n2 - n1 >= 2  # at least header + something again
    assert (n2 - n1) > (after_second - after_first)
