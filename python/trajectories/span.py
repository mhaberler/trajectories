"""Archive span for one ICON model: history start through the forecast end."""

from __future__ import annotations

import json
import math

from . import config


def first_finite_second(times_s, values) -> int | None:
    """First unix second whose sample is a finite number."""
    for t, v in zip(times_s, values):
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(fv):
            return int(t)
    return None


def assemble_span(
    *,
    model: str,
    history_start: int,
    run: int,
    data_end: int,
    horizon_h: int,
) -> dict:
    """Bounds the time bar can draw. Times are unix seconds."""
    run_s = int(run)
    end_s = int(data_end)
    hist = int(history_start)
    if hist > run_s:
        hist = run_s
    forecast_end = min(end_s, run_s + int(horizon_h) * 3600)
    if forecast_end < run_s:
        forecast_end = run_s
    return {
        "model": model,
        "history_start": hist,
        "run": run_s,
        "forecast_end": forecast_end,
        "data_end": end_s,
    }


def model_span(model_key: str) -> dict:
    """Read one model's span from the local OM dataset."""
    ds = config.dataset_path(model_key)
    if ds is None:
        raise RuntimeError(f"No OM dataset for {model_key}")
    meta = json.loads((ds / "static" / "meta.json").read_text())
    run = int(meta["last_run_initialisation_time"])
    data_end = int(meta["data_end_time"])
    from .om_backend import get_om_backend

    history = get_om_backend(model_key).first_finite_wind_unix()
    if history is None:
        raise RuntimeError(f"No wind in archive for {model_key}")
    return assemble_span(
        model=model_key,
        history_start=history,
        run=run,
        data_end=data_end,
        horizon_h=config.forecast_horizon_h(model_key),
    )
