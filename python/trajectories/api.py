"""FastAPI HTTP API for ICON wind trajectories (Open-Meteo-shaped query params)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config
from .compute import compute_trajectories

MODELS = Literal["icon_d2", "icon_eu"]
VERTICAL = Literal["height", "pressure", "theta", "z3d"]
DIRECTION = Literal["forward", "backward"]
BACKEND = Literal["auto", "om", "http"]
TIMEFORMAT = Literal["iso8601", "unixtime"]
FORMAT = Literal["geojson"]

app = FastAPI(
    title="Trajectories API",
    description=(
        "Petterssen ICON wind trajectories over Open-Meteo fields. "
        "Query parameters follow Open-Meteo naming; successful responses are "
        "GeoJSON FeatureCollections (SimpleStyle)."
    ),
    version="0.1.0",
    openapi_tags=[
        {"name": "trajectory", "description": "Compute wind trajectories"},
        {"name": "meta", "description": "Health and service metadata"},
    ],
)


def _om_error(status: int, reason: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": True, "reason": reason},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request, exc: RequestValidationError):
    parts = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "query")
        msg = err.get("msg", "invalid")
        parts.append(f"{loc}: {msg}" if loc else msg)
    return _om_error(400, "; ".join(parts) or "Invalid request")


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and detail.get("reason"):
        reason = str(detail["reason"])
    else:
        reason = str(detail)
    return _om_error(exc.status_code, reason)


@app.get("/health", tags=["meta"])
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "api_base": config.API_BASE,
        "om_root": str(config.OM_ROOT) if config.OM_ROOT else None,
        "backend": config.BACKEND,
        "models": sorted(config.MODELS),
    }


def _parse_csv_floats(raw: str | None, *, name: str) -> list[float] | None:
    if raw is None or not str(raw).strip():
        return None
    out: list[float] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except ValueError as exc:
            raise ValueError(f"Invalid {name} value: {part!r}") from exc
    return out or None


def _parse_csv_methods(raw: str | None) -> list[str] | None:
    if raw is None or not str(raw).strip():
        return None
    allowed = {m["key"] for m in config.METHODS}
    out: list[str] = []
    for part in str(raw).split(","):
        part = part.strip()
        if not part:
            continue
        if part not in allowed:
            raise ValueError(
                f"Invalid vertical_motion: {part!r} "
                f"(allowed: {', '.join(sorted(allowed))})"
            )
        out.append(part)
    return out or None


def _resolve_time(time: str | None, timeformat: str) -> str | float:
    if time is None or not str(time).strip():
        raise ValueError("Parameter time is required")
    raw = str(time).strip()
    if timeformat == "unixtime":
        try:
            return float(raw)
        except ValueError as exc:
            raise ValueError(f"Invalid unix time: {raw!r}") from exc
    # iso8601 — normalize; compute_trajectories accepts ISO strings
    try:
        s = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except ValueError as exc:
        raise ValueError(f"Invalid ISO8601 time: {raw!r}") from exc


@app.get(
    "/v1/trajectory",
    tags=["trajectory"],
    summary="Compute wind trajectories",
    response_description="GeoJSON FeatureCollection",
    responses={
        200: {
            "description": "GeoJSON FeatureCollection with LineString tracks and Point markers",
            "content": {
                "application/json": {
                    "example": {
                        "type": "FeatureCollection",
                        "features": [],
                    }
                }
            },
        },
        400: {
            "description": "Open-Meteo-style error",
            "content": {
                "application/json": {
                    "example": {"error": True, "reason": "Unknown model: foo"}
                }
            },
        },
    },
)
def trajectory(
    latitude: float = Query(..., description="WGS84 latitude (°)", ge=-90, le=90),
    longitude: float = Query(..., description="WGS84 longitude (°)", ge=-180, le=180),
    models: MODELS = Query(
        "icon_eu",
        description="Open-Meteo model id (single model in v1)",
    ),
    time: str = Query(
        ...,
        description="Start time: ISO-8601 (default) or unix seconds when timeformat=unixtime",
    ),
    timeformat: TIMEFORMAT = Query(
        "iso8601",
        description="How to interpret `time` (Open-Meteo-style)",
    ),
    forecast_hours: float = Query(
        12,
        ge=1,
        le=72,
        description="Trajectory duration in hours (1–72)",
    ),
    height_agl: str | None = Query(
        None,
        description="Comma-separated start heights in metres AGL (default 500,1500,3000)",
        examples=["500,1500,3000"],
    ),
    height_amsl: str | None = Query(
        None,
        description="Comma-separated start heights in metres AMSL (mutually exclusive with height_agl)",
    ),
    vertical_motion: str | None = Query(
        "height",
        description="Comma-separated methods: height,pressure,theta,z3d",
        examples=["height"],
    ),
    direction: DIRECTION = Query("forward"),
    marker_interval: float = Query(
        60,
        ge=1,
        description="Marker interval in minutes",
    ),
    met_extras: bool = Query(
        False,
        description="Include T/Td/RH/p on marker points",
    ),
    backend: BACKEND | None = Query(
        None,
        description="Wind data source override (default: server auto/om/http config)",
    ),
    format: FORMAT = Query(
        "geojson",
        description="Response format (only geojson in v1)",
    ),
) -> dict[str, Any]:
    if format != "geojson":
        return _om_error(400, f"Unsupported format: {format}")

    if height_agl and height_amsl:
        return _om_error(400, "Specify only one of height_agl or height_amsl")

    try:
        t0 = _resolve_time(time, timeformat)
        if height_amsl:
            heights = _parse_csv_floats(height_amsl, name="height_amsl")
            height_ref = "amsl"
        else:
            heights = _parse_csv_floats(height_agl, name="height_agl")
            height_ref = "agl"
        methods = _parse_csv_methods(vertical_motion)
    except ValueError as exc:
        return _om_error(400, str(exc))

    try:
        return compute_trajectories(
            lat=latitude,
            lon=longitude,
            time=t0,
            model=models,
            duration_h=forecast_hours,
            heights=heights,
            methods=methods,
            height_ref=height_ref,
            direction=direction,
            marker_interval_min=marker_interval,
            met_extras=met_extras,
            backend=backend,
        )
    except ValueError as exc:
        return _om_error(400, str(exc))
    except RuntimeError as exc:
        return _om_error(500, str(exc))
    except Exception as exc:  # noqa: BLE001 — surface as OM error
        return _om_error(500, f"Internal error: {exc}")
