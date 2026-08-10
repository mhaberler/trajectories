"""Unit tests for OM slab pad/bands and in-slab vs point-fetch paths."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from trajectories.om_backend import (
    BAND_HIGH_M,
    BAND_LOW_M,
    OmSlab,
    clear_om_backend_cache,
    height_band_ceiling_m,
    spatial_pad_deg,
)


def test_height_band_ceiling():
    assert height_band_ceiling_m(500) == BAND_LOW_M
    assert height_band_ceiling_m(2000) == BAND_LOW_M
    assert height_band_ceiling_m(2000.1) == BAND_HIGH_M
    assert height_band_ceiling_m(3000) == BAND_HIGH_M


def test_spatial_pad_clamped():
    dlat, dlon = spatial_pad_deg(47.0, 2.0)
    assert dlat > 0 and dlon > 0
    # 40 km/h * 2 h = 80 km half-extent → ~0.72°
    assert 0.5 < dlat < 1.0


def test_request_from_slab_hit_and_miss():
    pytest.importorskip("omfiles")
    from trajectories.om_backend import OmBackend

    clear_om_backend_cache()
    # Minimal fake slab around a known index
    times = [1.0e9, 1.0e9 + 3600]
    hsurf = np.array([[400.0]], dtype=np.float64)
    hhl = np.zeros((1, 1, 66), dtype=np.float64)
    hhl[0, 0, :] = np.linspace(20000, 400, 66)
    u = np.array([[[1.0, 2.0]]], dtype=np.float64)  # [ny,nx,nt]
    slab = OmSlab(
        x0=10,
        x1=10,
        y0=20,
        y1=20,
        times_unix=times,
        hsurf=hsurf,
        hhl=hhl,
        fields={"wind_u_component_level65": u},
    )

    backend = MagicMock(spec=OmBackend)
    backend._xy = MagicMock()

    class XY:
        def __init__(self, x, y):
            self.x, self.y = x, y

    # Hit
    backend._xy.side_effect = lambda lat, lon: XY(10, 20)
    from trajectories.om_backend import OmBackend as Real

    hit = Real.request_from_slab(
        backend,
        slab,
        [[47.0, 15.0]],
        ["wind_u_component_level65", "height_agl_level65"],
        with_meta=True,
    )
    assert hit is not None
    assert hit[0]["wind_u_component_level65"] == [1.0, 2.0]
    assert hit[0]["__elevation"] == 400.0
    assert "height_agl_level65" in hit[0]

    # Miss
    backend._xy.side_effect = lambda lat, lon: XY(99, 99)
    miss = Real.request_from_slab(
        backend,
        slab,
        [[47.0, 15.0]],
        ["wind_u_component_level65"],
        with_meta=True,
    )
    assert miss is None


def test_om_request_prefers_slab_without_point_readers():
    pytest.importorskip("omfiles")
    from trajectories import config
    from trajectories.om_backend import OmBackend, get_om_backend

    if config.dataset_path("icon_d2") is None:
        pytest.skip("ICON D2 OM dataset not available")

    clear_om_backend_cache()
    om = get_om_backend("icon_d2")
    times = [1.0e9, 1.0e9 + 3600]
    # Build a tiny real-index slab using actual grid point near Stubenberg
    xy = om._xy(47.23, 15.82)
    hsurf = np.array([[float(om.elevation_at(47.23, 15.82))]])
    with om._OmFileReader(str(om.dataset / "static" / "hhl.om")) as reader:
        hhl_col = np.asarray(reader[xy.y, xy.x, :], dtype=np.float64)
    hhl = hhl_col.reshape(1, 1, -1)
    u = np.zeros((1, 1, 2), dtype=np.float64)
    u[0, 0, :] = [0.5, 0.6]
    slab = OmSlab(
        x0=xy.x,
        x1=xy.x,
        y0=xy.y,
        y1=xy.y,
        times_unix=times,
        hsurf=hsurf,
        hhl=hhl,
        fields={"wind_u_component_level65": u},
    )

    with patch.object(om, "_OmChunkFileReader") as mock_reader:
        out = om.request(
            [[47.23, 15.82]],
            ["wind_u_component_level65"],
            "2026-08-02",
            "2026-08-02",
            with_meta=True,
            slab=slab,
        )
        mock_reader.assert_not_called()
    assert out[0]["wind_u_component_level65"] == [0.5, 0.6]


def test_request_partial_slab_only_slow_fetches_outliers():
    """One out-of-slab point must not force the whole batch onto point IO."""
    pytest.importorskip("omfiles")
    from trajectories.om_backend import OmBackend

    clear_om_backend_cache()
    times = [1.0e9, 1.0e9 + 3600]
    hsurf = np.array([[400.0]], dtype=np.float64)
    hhl = np.zeros((1, 1, 66), dtype=np.float64)
    hhl[0, 0, :] = np.linspace(20000, 400, 66)
    u = np.array([[[1.0, 2.0]]], dtype=np.float64)
    slab = OmSlab(
        x0=10,
        x1=10,
        y0=20,
        y1=20,
        times_unix=times,
        hsurf=hsurf,
        hhl=hhl,
        fields={"wind_u_component_level65": u},
    )

    class XY:
        def __init__(self, x, y):
            self.x, self.y = x, y

    backend = MagicMock(spec=OmBackend)
    backend._xy = MagicMock(
        side_effect=lambda lat, lon: XY(10, 20) if lat < 50 else XY(99, 99)
    )

    from trajectories.om_backend import OmBackend as Real

    # Bind real methods we need onto a thin instance stand-in.
    om = MagicMock()
    om._xy = backend._xy
    om.request_from_slab = lambda *a, **k: Real.request_from_slab(om, *a, **k)
    slow_calls: list[list[list[float]]] = []

    def slow(coords, vars_, start_date, end_date, *, with_meta=False):
        slow_calls.append(coords)
        return [
            {
                "wind_u_component_level65": [9.0, 9.0],
                "__times": times,
                "__elevation": 1.0,
            }
            for _ in coords
        ]

    om._request_points = slow
    om.request = lambda *a, **k: Real.request(om, *a, **k)

    out = Real.request(
        om,
        [[47.0, 15.0], [60.0, 15.0]],
        ["wind_u_component_level65"],
        "2026-08-02",
        "2026-08-02",
        with_meta=True,
        slab=slab,
    )
    assert len(out) == 2
    assert out[0]["wind_u_component_level65"] == [1.0, 2.0]
    assert out[1]["wind_u_component_level65"] == [9.0, 9.0]
    assert slow_calls == [[[60.0, 15.0]]]


def test_chunk_times_cached_and_matches_meta():
    pytest.importorskip("omfiles")
    from trajectories import config
    from trajectories.om_backend import get_om_backend

    if config.dataset_path("icon_eu") is None and config.dataset_path("icon_d2") is None:
        pytest.skip("no local OM dataset")
    model = "icon_eu" if config.dataset_path("icon_eu") else "icon_d2"
    clear_om_backend_cache()
    om = get_om_backend(model)
    a = om._chunk_times(0)
    b = om._chunk_times(0)
    assert a is b
    ref = om.meta.get_chunk_time_range(0)
    assert len(a) == len(ref)
    assert a[0] == ref[0]
    assert a[-1] == ref[-1]
