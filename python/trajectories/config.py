"""Model definitions and defaults — port of src/config.js."""

from __future__ import annotations

import os

_DEFAULT_API = "https://open-meteo.mah.priv.at"
API_BASE = os.environ.get("TRAJECTORIES_API_BASE", _DEFAULT_API)

MODELS = {
    "icon_d2": {
        "apiModel": "icon_d2",
        "dataset": "dwd_icon_d2",
        "label": "ICON-D2 (~2,2 km)",
        "grid": 0.02,
        "gridMeters": 2200,
        "nLevels": 65,
        "bbox": {
            "latMin": 43.18,
            "latMax": 58.08,
            "lonMin": -3.94,
            "lonMax": 20.34,
        },
    },
    "icon_eu": {
        "apiModel": "icon_eu",
        "dataset": "dwd_icon_eu",
        "label": "ICON-EU (~6,5 km)",
        "grid": 0.0625,
        "gridMeters": 6500,
        "nLevels": 74,
        "bbox": {
            "latMin": 29.5,
            "latMax": 70.5,
            "lonMin": -23.5,
            "lonMax": 62.5,
        },
    },
}

SERIES_COLORS = [
    "#2a78d6",
    "#008300",
    "#e87ba4",
    "#eda100",
    "#1baf7a",
    "#eb6834",
    "#4a3aa7",
    "#e34948",
]

DEFAULT_HEIGHTS = [500, 1500, 3000]
HEIGHT_MIN = 10
HEIGHT_MAX = 10000
MARKER_INTERVALS = [10, 30, 60, 180, 360]

METHODS = [
    {"key": "height", "label": "konstante Höhe", "color": "#2a78d6", "dash": None},
    {"key": "pressure", "label": "isobar", "color": "#008300", "dash": "8 6"},
    {"key": "theta", "label": "isentrop", "color": "#e87ba4", "dash": "12 4 3 4"},
    {"key": "z3d", "label": "Modell-w (3D)", "color": "#eda100", "dash": "2 6"},
]


def set_api_base(url: str | None) -> str:
    """Set or reset the Open-Meteo base URL. Returns the active base."""
    global API_BASE
    if url:
        API_BASE = url.rstrip("/")
    else:
        API_BASE = os.environ.get("TRAJECTORIES_API_BASE", _DEFAULT_API)
    return API_BASE
