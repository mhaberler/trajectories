"""Unit tests for GLO-30 DEM (local GeoTIFF fixtures; no network)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
from rasterio.transform import from_origin

from trajectories.glo30 import (
    DiskCogCache,
    Glo30DEM,
    Glo30DEMError,
    reset_dem_for_tests,
    tile_stem,
    tile_sw_corner,
    tile_url,
)


def _write_deg_geotiff(path: Path, *, lat0: int, lon0: int, value: float = 123.0) -> bytes:
    """1° GeoTIFF with constant elevation; SW corner at (lat0, lon0)."""
    # 4x4 pixels covering [lon0, lon0+1] x [lat0, lat0+1]
    height = width = 4
    data = np.full((height, width), value, dtype=np.float32)
    transform = from_origin(lon0, lat0 + 1, 1.0 / width, 1.0 / height)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=transform,
        nodata=-32768.0,
    ) as ds:
        ds.write(data, 1)
    return path.read_bytes()


def test_tile_stem_naming():
    assert tile_sw_corner(47.8, 11.3) == (47, 11)
    assert tile_stem(47.8, 11.3) == "Copernicus_DSM_COG_10_N47_00_E011_00_DEM"
    assert tile_stem(-10.2, -3.5) == "Copernicus_DSM_COG_10_S11_00_W004_00_DEM"
    assert tile_stem(0.1, -0.1) == "Copernicus_DSM_COG_10_N00_00_W001_00_DEM"
    url = tile_url("https://copernicus-dem-30m.s3.amazonaws.com", tile_stem(47.8, 11.3))
    assert url.endswith(
        "/Copernicus_DSM_COG_10_N47_00_E011_00_DEM/"
        "Copernicus_DSM_COG_10_N47_00_E011_00_DEM.tif"
    )


def test_missing_tile_returns_zero(tmp_path: Path):
    reset_dem_for_tests()

    def fetch(_stem: str) -> bytes | None:
        return None

    dem = Glo30DEM(
        cache_dir=tmp_path / "cog",
        cache_max_bytes=10_000_000,
        fetch_bytes_fn=fetch,
    )
    assert dem.elevation_at(47.8, 11.3) == 0.0
    assert dem.disk.is_missing(tile_stem(47.8, 11.3))
    # second call uses .missing marker (disk hit path)
    assert dem.elevation_at(47.8, 11.3) == 0.0
    dem.close()
    reset_dem_for_tests()


def test_sample_line_from_cached_geotiff(tmp_path: Path):
    reset_dem_for_tests()
    stem = tile_stem(47.25, 11.25)
    tif = tmp_path / "src.tif"
    payload = _write_deg_geotiff(tif, lat0=47, lon0=11, value=456.0)
    calls: list[str] = []

    def fetch(s: str) -> bytes | None:
        calls.append(s)
        assert s == stem
        return payload

    dem = Glo30DEM(
        cache_dir=tmp_path / "cog",
        cache_max_bytes=10_000_000,
        fetch_bytes_fn=fetch,
    )
    samples = dem.sample_line(
        [
            {"lat": 47.25, "lon": 11.25, "t_sec": 0},
            {"lat": 47.75, "lon": 11.75, "t_sec": 300},
        ],
        interval_sec=15,
    )
    assert len(samples) >= 10
    assert len(calls) == 1
    assert dem.last_sample_stats is not None
    assert dem.last_sample_stats["unique_tiles"] == 1
    assert all(abs(s["z"] - 456.0) < 0.1 for s in samples)

    # warm: served from disk cache, no second fetch
    calls.clear()
    dem2 = Glo30DEM(
        cache_dir=tmp_path / "cog",
        cache_max_bytes=10_000_000,
        fetch_bytes_fn=fetch,
    )
    z = dem2.elevation_at(47.5, 11.5)
    assert z is not None and abs(z - 456.0) < 0.1
    assert calls == []
    dem.close()
    dem2.close()
    reset_dem_for_tests()


def test_fetch_non_missing_failure_raises(tmp_path: Path):
    reset_dem_for_tests()

    def fetch(_stem: str) -> bytes | None:
        raise RuntimeError("boom")

    dem = Glo30DEM(
        cache_dir=tmp_path / "cog",
        cache_max_bytes=10_000_000,
        fetch_bytes_fn=fetch,
    )
    with pytest.raises(Glo30DEMError):
        dem.elevation_at(47.8, 11.3)
    dem.close()
    reset_dem_for_tests()


def test_disk_cog_cache_lru(tmp_path: Path):
    cache = DiskCogCache(tmp_path / "c", max_bytes=2500)
    a = b"a" * 1000
    b = b"b" * 1000
    c = b"c" * 1000
    cache.put_file("tile_a", a)
    cache.put_file("tile_b", b)
    assert cache.get_path("tile_a") is not None
    cache.put_file("tile_c", c)  # should evict oldest (b if a was touched)
    assert cache.get_path("tile_a") is not None
    assert cache.get_path("tile_b") is None
    assert cache.get_path("tile_c") is not None


def test_concurrent_sample_line_no_crash(tmp_path: Path):
    """UI fires profile + xsec DEM in parallel; rasterio must not SIGSEGV."""
    import threading

    reset_dem_for_tests()
    stem = tile_stem(47.25, 11.25)
    payload = _write_deg_geotiff(tmp_path / "src.tif", lat0=47, lon0=11, value=200.0)

    dem = Glo30DEM(
        cache_dir=tmp_path / "cog",
        cache_max_bytes=10_000_000,
        fetch_bytes_fn=lambda s: payload if s == stem else None,
    )
    pts = [
        {"lat": 47.25, "lon": 11.25, "t_sec": 0},
        {"lat": 47.75, "lon": 11.75, "t_sec": 600},
    ]
    errors: list[BaseException] = []
    results: list[int] = []

    def worker() -> None:
        try:
            samples = dem.sample_line(pts, interval_sec=15)
            results.append(len(samples))
        except BaseException as exc:  # noqa: BLE001 — capture for main thread
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    dem.close()
    reset_dem_for_tests()
    assert not errors, errors
    assert len(results) == 8
    assert all(n >= 10 for n in results)
