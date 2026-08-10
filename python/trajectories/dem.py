"""DEM facade: select Joerd (default), Mapterhorn, or GLO-30 via env."""

from __future__ import annotations

import os
import threading
from typing import Any

from .dem_common import env_flag

BACKEND = os.environ.get("TRAJECTORIES_DEM_BACKEND", "joerd").strip().lower() or "joerd"
if BACKEND not in ("joerd", "mapterhorn", "glo30"):
    BACKEND = "joerd"

# Shared contract (identical in joerd / mapterhorn / glo30).
MIN_INTERVAL_SEC = 15
MAX_LINE_POINTS = 5000

DEBUG = env_flag("TRAJECTORIES_DEM_DEBUG") or (
    env_flag("TRAJECTORIES_JOERD_DEBUG")
    if BACKEND == "joerd"
    else env_flag("TRAJECTORIES_MAPTERHORN_DEBUG")
    if BACKEND == "mapterhorn"
    else env_flag("TRAJECTORIES_GLO30_DEBUG")
)

_mod_lock = threading.Lock()
_mod: Any = None


def backend_name() -> str:
    return BACKEND


def _module() -> Any:
    global _mod
    with _mod_lock:
        if _mod is not None:
            return _mod
        if BACKEND == "mapterhorn":
            from . import mapterhorn as mod
        elif BACKEND == "glo30":
            from . import glo30 as mod
        else:
            from . import joerd as mod
        _mod = mod
        return mod


def reset_backend_for_tests() -> None:
    """Drop facade module binding and backend singleton (tests)."""
    global _mod
    with _mod_lock:
        if _mod is not None:
            try:
                _mod.reset_dem_for_tests()
            except Exception:
                pass
            _mod = None


def get_dem() -> Any:
    return _module().get_dem()


def elevation_at(lat: float, lon: float) -> float | None:
    return _module().elevation_at(lat, lon)


def sample_line(
    points: list[dict[str, float]], interval_sec: float
) -> list[dict[str, float]]:
    return _module().sample_line(points, interval_sec)
