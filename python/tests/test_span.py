"""Span bounds: pure assembly, plus the HTTP route with a mocked dataset."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from trajectories.span import assemble_span, first_finite_second

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient

from trajectories.api import app

client = TestClient(app)


def test_first_finite_skips_nulls():
    assert first_finite_second([10, 11, 12], [None, float("nan"), 1.5]) == 12
    assert first_finite_second([10], [None]) is None


def test_assemble_clips_forecast_to_data_end():
    row = assemble_span(
        model="icon_d2",
        history_start=1_000,
        run=10_000,
        data_end=10_000 + 49 * 3600,
        horizon_h=48,
    )
    assert row["history_start"] == 1_000
    assert row["run"] == 10_000
    assert row["forecast_end"] == 10_000 + 48 * 3600
    assert row["data_end"] == 10_000 + 49 * 3600


def test_assemble_keeps_forecast_inside_a_shorter_file():
    row = assemble_span(
        model="icon_eu",
        history_start=50_000,
        run=10_000,
        data_end=10_000 + 10 * 3600,
        horizon_h=120,
    )
    assert row["history_start"] == 10_000
    assert row["forecast_end"] == 10_000 + 10 * 3600


@patch(
    "trajectories.api.model_span",
    return_value={
        "model": "icon_d2",
        "history_start": 1_700_000_000,
        "run": 1_790_272_800,
        "forecast_end": 1_790_445_600,
        "data_end": 1_790_449_200,
    },
)
def test_span_route(_mock):
    r = client.get("/v1/span", params={"models": "icon_d2"})
    assert r.status_code == 200
    body = r.json()
    assert body["models"][0]["model"] == "icon_d2"
    assert body["models"][0]["history_start"] == 1_700_000_000
    assert body["models"][0]["forecast_end"] == 1_790_445_600


def test_span_unknown_model():
    r = client.get("/v1/span", params={"models": "icon_foo"})
    assert r.status_code == 400
    assert r.json()["error"] is True
