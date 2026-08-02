"""FastAPI /v1/trajectory unit tests (mocked compute; no network)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from trajectories.api import app

client = TestClient(app)

TINY_GJ = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[15.82, 47.23, 500], [15.83, 47.24, 500]],
            },
            "properties": {"start_height_m": 500, "vertical_motion": "height"},
        }
    ],
}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "icon_d2" in body["models"]


def test_trajectory_validation_bad_model():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_global",
            "time": "2026-08-02T11:00:00Z",
        },
    )
    assert r.status_code == 400
    body = r.json()
    assert body.get("error") is True
    assert "reason" in body


def test_trajectory_both_height_refs():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "height_agl": "500",
            "height_amsl": "1000",
        },
    )
    assert r.status_code == 400
    assert r.json()["error"] is True


def test_trajectory_bad_vertical_motion():
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "vertical_motion": "banana",
        },
    )
    assert r.status_code == 400
    assert "vertical_motion" in r.json()["reason"]


@patch("trajectories.api.compute_trajectories", return_value=TINY_GJ)
def test_trajectory_happy_path(mock_compute):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
            "forecast_hours": 2,
            "height_agl": "500,1500",
            "vertical_motion": "height",
            "backend": "http",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1
    mock_compute.assert_called_once()
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["lat"] == 47.23
    assert kwargs["lon"] == 15.82
    assert kwargs["model"] == "icon_d2"
    assert kwargs["duration_h"] == 2
    assert kwargs["heights"] == [500.0, 1500.0]
    assert kwargs["methods"] == ["height"]
    assert kwargs["height_ref"] == "agl"
    assert kwargs["backend"] == "http"


@patch("trajectories.api.compute_trajectories", return_value=TINY_GJ)
def test_trajectory_unixtime(mock_compute):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_eu",
            "time": "1754132400",
            "timeformat": "unixtime",
            "height_amsl": "1500",
        },
    )
    assert r.status_code == 200
    kwargs = mock_compute.call_args.kwargs
    assert kwargs["time"] == 1754132400.0
    assert kwargs["height_ref"] == "amsl"
    assert kwargs["heights"] == [1500.0]


@patch("trajectories.api.compute_trajectories", side_effect=ValueError("Point outside domain"))
def test_trajectory_compute_value_error(_mock):
    r = client.get(
        "/v1/trajectory",
        params={
            "latitude": 47.23,
            "longitude": 15.82,
            "models": "icon_d2",
            "time": "2026-08-02T11:00:00Z",
        },
    )
    assert r.status_code == 400
    assert "outside" in r.json()["reason"]
