"""Unit tests for Mapterhorn DEM helpers (mocked tiles; no network)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

pytest.importorskip("PIL")
pytest.importorskip("pmtiles")

from PIL import Image

from trajectories.mapterhorn import (
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
