"""Unit tests for Joerd Terrarium DEM (mocked tiles; no network)."""

from __future__ import annotations

import io
from pathlib import Path

import pytest

pytest.importorskip("PIL")

from PIL import Image

from trajectories.joerd import JoerdDEM, JoerdDEMError, reset_dem_for_tests
from trajectories.terrarium import terrarium_elevation


def _solid_tile(r: int, g: int, b: int, size: int = 256) -> bytes:
    img = Image.new("RGB", (size, size), (r, g, b))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_terrarium_formula():
    assert terrarium_elevation(128, 0, 0) == 0.0
    assert terrarium_elevation(128, 100, 0) == 100.0


def test_sample_line_unique_tile_once(tmp_path: Path):
    reset_dem_for_tests()
    tile = _solid_tile(128, 80, 0, size=256)
    calls: list[tuple[int, int, int]] = []

    def fetch(z: int, x: int, y: int) -> bytes | None:
        calls.append((z, x, y))
        return tile

    dem = JoerdDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        zoom=12,
        fetch_tile_fn=fetch,
    )
    pts = [
        {"lat": 47.8000, "lon": 11.3000, "t_sec": 0},
        {"lat": 47.8005, "lon": 11.3005, "t_sec": 300},
    ]
    samples = dem.sample_line(pts, interval_sec=15)
    assert len(samples) >= 10
    assert len(calls) == 1
    assert calls[0][0] == 12
    assert dem.last_sample_stats is not None
    assert dem.last_sample_stats["unique_tiles"] == 1
    assert all(abs(s["z"] - 80.0) < 0.1 for s in samples)
    dem.close()
    reset_dem_for_tests()


def test_fetch_failure_raises(tmp_path: Path):
    reset_dem_for_tests()

    def fetch(_z: int, _x: int, _y: int) -> bytes | None:
        return None

    dem = JoerdDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        zoom=12,
        fetch_tile_fn=fetch,
    )
    with pytest.raises(JoerdDEMError):
        dem.elevation_at(47.8, 11.3)
    dem.close()
    reset_dem_for_tests()


def test_fixed_zoom_only(tmp_path: Path):
    reset_dem_for_tests()
    zooms: list[int] = []

    def fetch(z: int, x: int, y: int) -> bytes | None:
        zooms.append(z)
        return _solid_tile(128, 50, 0)

    dem = JoerdDEM(
        cache_dir=tmp_path / "tiles",
        cache_max_bytes=10_000_000,
        zoom=12,
        fetch_tile_fn=fetch,
    )
    dem.sample_line(
        [
            {"lat": 47.8, "lon": 11.3, "t_sec": 0},
            {"lat": 48.0, "lon": 12.0, "t_sec": 3600},
        ],
        interval_sec=60,
    )
    assert zooms
    assert set(zooms) == {12}
    dem.close()
    reset_dem_for_tests()
