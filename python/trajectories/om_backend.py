"""Local Open-Meteo `.om` chunk reader (omfiles) for WindField."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

from . import config


def _require_omfiles():
    try:
        from omfiles import OmFileReader
        from omfiles.chunk_reader import OmChunkFileReader
        from omfiles.meta import OmChunksMeta
    except ImportError as exc:
        raise RuntimeError(
            "omfiles is required for the local backend "
            "(pip install 'trajectories[om]')"
        ) from exc
    return OmFileReader, OmChunkFileReader, OmChunksMeta


class OmBackend:
    """Point fetches from a rolling Open-Meteo timeseries tree."""

    def __init__(self, model_key: str, root: Path | None = None):
        OmFileReader, OmChunkFileReader, OmChunksMeta = _require_omfiles()
        self._OmFileReader = OmFileReader
        self._OmChunkFileReader = OmChunkFileReader

        if model_key not in config.MODELS:
            raise ValueError(f"Unbekanntes Modell: {model_key}")
        self.model_key = model_key
        self.model = config.MODELS[model_key]
        ds = Path(root) if root is not None else config.dataset_path(model_key)
        if ds is None or not ds.is_dir():
            raise RuntimeError(f"OM dataset not found for {model_key}")
        self.dataset = ds

        meta_path = self.dataset / "static" / "meta.json"
        self.meta = OmChunksMeta.from_metajson_string(meta_path.read_text())
        self.ny, self.nx = self._discover_shape()
        self.grid = self.meta.get_grid((self.ny, self.nx))

        import fsspec

        self.fs = fsspec.filesystem("file")
        self._xy_cache: dict[tuple[float, float], Any] = {}

    def _discover_shape(self) -> tuple[int, int]:
        level = self.model["nLevels"]
        var_dir = self.dataset / f"wind_u_component_level{level}"
        chunks = sorted(var_dir.glob("chunk_*.om"))
        if not chunks:
            raise RuntimeError(f"No OM chunks under {var_dir}")
        with self._OmFileReader(str(chunks[0])) as reader:
            ny, nx, _nt = reader.shape
        return int(ny), int(nx)

    def has_w(self) -> bool:
        level = self.model["nLevels"] - 5
        return (self.dataset / f"wind_w_level{level}").is_dir()

    def _xy(self, lat: float, lon: float):
        key = (round(lat, 5), round(lon, 5))
        hit = self._xy_cache.get(key)
        if hit is not None:
            return hit
        xy = self.grid.find_point_xy(lat, lon)
        self._xy_cache[key] = xy
        return xy

    def elevation_at(self, lat: float, lon: float) -> float:
        xy = self._xy(lat, lon)
        with self._OmFileReader(str(self.dataset / "static" / "HSURF.om")) as reader:
            return float(np.asarray(reader[xy.y, xy.x]))

    def height_agl_profile(self, lat: float, lon: float) -> dict[int, float]:
        """Model-level AGL heights (level 1 = TOA … nLevels ≈ 10 m)."""
        xy = self._xy(lat, lon)
        with self._OmFileReader(str(self.dataset / "static" / "HSURF.om")) as reader:
            hsurf = float(np.asarray(reader[xy.y, xy.x]))
        with self._OmFileReader(str(self.dataset / "static" / "hhl.om")) as reader:
            hhl = np.asarray(reader[xy.y, xy.x, :], dtype=np.float64)
        n = self.model["nLevels"]
        out: dict[int, float] = {}
        for level in range(1, n + 1):
            # half-levels: index level-1 and level; full-level mid-point
            out[level] = float(0.5 * (hhl[level - 1] + hhl[level]) - hsurf)
        return out

    def request(
        self,
        coords: list[list[float]],
        vars_: list[str],
        start_date: str,
        end_date: str,
        *,
        with_meta: bool = False,
    ) -> list[dict]:
        t0 = np.datetime64(f"{start_date}T00:00")
        # inclusive end-of-day for end_date (HTTP end_date is calendar day)
        t1 = np.datetime64(f"{end_date}T23:00")

        file_vars = [v for v in vars_ if not v.startswith("height_agl_level")]
        height_levels = [
            int(v.removeprefix("height_agl_level"))
            for v in vars_
            if v.startswith("height_agl_level")
        ]

        # One reader per variable; then sample each coordinate.
        series: dict[str, list[np.ndarray]] = {v: [] for v in file_vars}
        times_unix: list[float] | None = None

        for var in file_vars:
            var_dir = self.dataset / var
            if not var_dir.is_dir():
                raise RuntimeError(f"OM variable missing: {var_dir}")
            reader = self._OmChunkFileReader(
                self.meta, self.fs, str(var_dir), t0, t1
            )
            for lat, lon in coords:
                xy = self._xy(lat, lon)
                times, vals = reader.load_data((xy.x, xy.y))
                if times_unix is None:
                    times_unix = [_dt64_to_unix(t) for t in times]
                series[var].append(np.asarray(vals, dtype=np.float64))

        assert times_unix is not None or not file_vars
        if times_unix is None:
            # height-only probe: synthesize hourly stubs from date range
            times_unix = _hourly_unix(start_date, end_date)

        T = len(times_unix)
        out_list: list[dict] = []
        for i, (lat, lon) in enumerate(coords):
            elev = self.elevation_at(lat, lon)
            row: dict[str, Any] = {}
            for var in file_vars:
                arr = series[var][i]
                # NaN → None to match HTTP nulls for to_array
                row[var] = [None if not np.isfinite(v) else float(v) for v in arr]
            if height_levels:
                profile = self.height_agl_profile(lat, lon)
                for level in height_levels:
                    h = profile[level]
                    row[f"height_agl_level{level}"] = [h] * T
            if with_meta:
                row["__times"] = times_unix
                row["__elevation"] = elev
            out_list.append(row)
        return out_list

    def units_for(self, vars_: list[str]) -> dict[str, str]:
        """Unit metadata so WindField.store_point applies the right scales."""
        units: dict[str, str] = {}
        for v in vars_:
            if v.startswith("wind_u_component_") or v.startswith("wind_v_component_"):
                units[v] = "m/s"
            elif v.startswith("wind_w_"):
                units[v] = "m/s"
            elif v.startswith("temperature_"):
                units[v] = "°C"
            elif v.startswith("pressure_"):
                units[v] = "hPa"
            elif v.startswith("specific_humidity_"):
                units[v] = "g/kg"
            elif v.startswith("height_agl_"):
                units[v] = "m"
        return units


def _dt64_to_unix(t: np.datetime64) -> float:
    # ns → seconds
    return float(t.astype("datetime64[s]").astype(np.int64))


def _hourly_unix(start_date: str, end_date: str) -> list[float]:
    t0 = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
    t1 = datetime.fromisoformat(end_date).replace(
        hour=23, minute=0, second=0, tzinfo=timezone.utc
    )
    out: list[float] = []
    t = t0.timestamp()
    end = t1.timestamp()
    while t <= end:
        out.append(t)
        t += 3600
    return out
