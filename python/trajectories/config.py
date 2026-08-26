"""Model definitions and defaults — port of src/config.js."""

from __future__ import annotations

import os
import warnings
from pathlib import Path

_DEFAULT_API = "https://open-meteo.mah.priv.at"
_DEFAULT_ICON_GLOBAL_API = "https://open-meteo-temp.mah.priv.at"
API_BASE = os.environ.get("TRAJECTORIES_API_BASE", _DEFAULT_API)

_DEFAULT_OM_CANDIDATE = Path("/open-meteo")


def _om_root_from_env() -> Path | None:
    """Resolve OM root from env / default path. Empty env disables local files."""
    if "TRAJECTORIES_OM_ROOT" in os.environ:
        raw = os.environ["TRAJECTORIES_OM_ROOT"].strip()
        if not raw:
            return None
        return Path(raw)
    if _DEFAULT_OM_CANDIDATE.is_dir():
        return _DEFAULT_OM_CANDIDATE
    return None


OM_ROOT: Path | None = _om_root_from_env()
BACKEND = os.environ.get("TRAJECTORIES_BACKEND", "auto").strip().lower() or "auto"

MODELS = {
    "icon_d2": {
        "apiModel": "icon_d2",
        "dataset": "dwd_icon_d2",
        "label": "ICON-D2 (~2,2 km)",
        "grid": 0.02,
        "gridMeters": 2200,
        "nLevels": 65,
        "forecast_horizon_h": 48,
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
        "forecast_horizon_h": 120,
        "bbox": {
            "latMin": 29.5,
            "latMax": 70.5,
            "lonMin": -23.5,
            "lonMax": 62.5,
        },
    },
    # HTTP on open-meteo-temp — mirror open-meteo/examples/wind_w_profile.py
    # (``/v1/dwd-icon``; W on half levels 1..nHalfLevels). preferHttp: do not
    # auto-pick a local dwd_icon tree if present.
    "icon_global": {
        "apiModel": "icon_global",
        "dataset": "dwd_icon",
        "apiBase": os.environ.get(
            "TRAJECTORIES_ICON_GLOBAL_API_BASE", _DEFAULT_ICON_GLOBAL_API
        ),
        "apiPath": "/v1/dwd-icon",
        "preferHttp": True,
        "label": "ICON Global (~28 km)",
        "grid": 0.25,
        "gridMeters": 28000,
        "nLevels": 120,
        "nHalfLevels": 121,
        "forecast_horizon_h": 180,
        "bbox": {
            "latMin": -90,
            "latMax": 90,
            "lonMin": -180,
            "lonMax": 179.75,
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


def forecast_horizon_h(model_key: str) -> int:
    """DWD/Open-Meteo forecast length in hours for a model."""
    if model_key not in MODELS:
        raise ValueError(f"Unknown model: {model_key}")
    return int(MODELS[model_key]["forecast_horizon_h"])


def max_times_points(model_key: str) -> int:
    """Max ``times=`` starts: 15-minute grid over the model horizon (4× hours)."""
    return 4 * forecast_horizon_h(model_key)


def max_times_points_for_models(model_keys: list[str] | tuple[str, ...]) -> int:
    """Cap for a multi-model request: shortest horizon among models."""
    if not model_keys:
        raise ValueError("At least one model required")
    return min(max_times_points(m) for m in model_keys)


def set_api_base(url: str | None) -> str:
    """Set or reset the Open-Meteo base URL. Returns the active base."""
    global API_BASE
    if url:
        API_BASE = url.rstrip("/")
    else:
        API_BASE = os.environ.get("TRAJECTORIES_API_BASE", _DEFAULT_API)
    return API_BASE


def model_api_base(model_key: str | dict) -> str:
    """Open-Meteo HTTP base for a model (optional per-model ``apiBase``)."""
    cfg = MODELS[model_key] if isinstance(model_key, str) else model_key
    base = cfg.get("apiBase") or API_BASE
    return str(base).rstrip("/")


def model_api_path(model_key: str | dict) -> str:
    """Forecast path (e.g. ``/v1/dwd-icon`` for ICON global; default ``/v1/forecast``)."""
    cfg = MODELS[model_key] if isinstance(model_key, str) else model_key
    p = str(cfg.get("apiPath") or "/v1/forecast")
    return p if p.startswith("/") else f"/{p}"


def model_forecast_url(model_key: str | dict) -> str:
    """``{apiBase}{apiPath}`` for HTTP forecast requests."""
    return f"{model_api_base(model_key)}{model_api_path(model_key)}"


def set_om_root(path: str | Path | None) -> Path | None:
    """Set or reset the local Open-Meteo data root. ``None`` re-reads env/default."""
    global OM_ROOT
    if path is None:
        OM_ROOT = _om_root_from_env()
    else:
        p = Path(path)
        OM_ROOT = p if str(path).strip() else None
    return OM_ROOT


def set_backend(backend: str | None) -> str:
    """Set backend mode: ``auto`` | ``om`` | ``http``. ``None`` re-reads env."""
    global BACKEND
    if backend is None:
        BACKEND = os.environ.get("TRAJECTORIES_BACKEND", "auto").strip().lower() or "auto"
    else:
        b = backend.strip().lower()
        if b not in ("auto", "om", "http"):
            raise ValueError("backend must be 'auto', 'om', or 'http'")
        BACKEND = b
    return BACKEND


def omfiles_available() -> bool:
    try:
        import omfiles  # noqa: F401
        from omfiles.meta import OmChunksMeta  # noqa: F401
        from omfiles.chunk_reader import OmChunkFileReader  # noqa: F401
    except ImportError:
        return False
    return True


def dataset_path(model_key: str) -> Path | None:
    """Return ``{OM_ROOT}/{dataset}`` if that directory exists."""
    if model_key not in MODELS:
        raise ValueError(f"Unknown model: {model_key}")
    if OM_ROOT is None:
        return None
    p = Path(OM_ROOT) / MODELS[model_key]["dataset"]
    return p if p.is_dir() else None


def resolve_backend(model_key: str, *, warn: bool = True) -> str:
    """
    Resolve ``om`` vs ``http`` for a model.

    ``auto``: prefer local OM when omfiles is installed and the dataset dir exists.
    ``om``: require local (raises if unavailable).
    ``http``: always HTTP.
    """
    mode = BACKEND if BACKEND in ("auto", "om", "http") else "auto"
    if mode == "http":
        return "http"
    if mode == "auto" and MODELS.get(model_key, {}).get("preferHttp"):
        return "http"

    has_omfiles = omfiles_available()
    ds = dataset_path(model_key)
    om_ok = has_omfiles and ds is not None

    if mode == "om":
        if not has_omfiles:
            raise RuntimeError(
                "backend=om requires the omfiles package "
                "(pip install 'trajectories[om]')"
            )
        if ds is None:
            root = OM_ROOT or "(unset)"
            ds_name = MODELS[model_key]["dataset"]
            raise RuntimeError(
                f"backend=om but dataset not found: {root}/{ds_name}"
            )
        return "om"

    # auto
    if om_ok:
        return "om"
    if warn and OM_ROOT is not None and not has_omfiles:
        warnings.warn(
            "TRAJECTORIES_OM_ROOT is set but omfiles is not installed; "
            "falling back to HTTP (pip install 'trajectories[om]')",
            stacklevel=2,
        )
    return "http"
