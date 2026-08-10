"""DEM facade backend selection."""

from __future__ import annotations

import importlib

import pytest


def test_default_backend_is_glo30(monkeypatch):
    monkeypatch.delenv("TRAJECTORIES_DEM_BACKEND", raising=False)
    import trajectories.dem as dem

    importlib.reload(dem)
    assert dem.backend_name() == "glo30"
    dem.reset_backend_for_tests()


def test_backend_mapterhorn(monkeypatch):
    monkeypatch.setenv("TRAJECTORIES_DEM_BACKEND", "mapterhorn")
    import trajectories.dem as dem

    importlib.reload(dem)
    assert dem.backend_name() == "mapterhorn"
    dem.reset_backend_for_tests()
    monkeypatch.delenv("TRAJECTORIES_DEM_BACKEND", raising=False)
    importlib.reload(dem)


def test_backend_joerd(monkeypatch):
    monkeypatch.setenv("TRAJECTORIES_DEM_BACKEND", "joerd")
    import trajectories.dem as dem

    importlib.reload(dem)
    assert dem.backend_name() == "joerd"
    dem.reset_backend_for_tests()
    monkeypatch.delenv("TRAJECTORIES_DEM_BACKEND", raising=False)
    importlib.reload(dem)


def test_backend_glo30(monkeypatch):
    monkeypatch.setenv("TRAJECTORIES_DEM_BACKEND", "glo30")
    import trajectories.dem as dem

    importlib.reload(dem)
    assert dem.backend_name() == "glo30"
    dem.reset_backend_for_tests()
    monkeypatch.delenv("TRAJECTORIES_DEM_BACKEND", raising=False)
    importlib.reload(dem)


def test_invalid_backend_falls_back_to_glo30(monkeypatch):
    monkeypatch.setenv("TRAJECTORIES_DEM_BACKEND", "nope")
    import trajectories.dem as dem

    importlib.reload(dem)
    assert dem.backend_name() == "glo30"
    dem.reset_backend_for_tests()
    monkeypatch.delenv("TRAJECTORIES_DEM_BACKEND", raising=False)
    importlib.reload(dem)
