"""Terrarium DEM encoding helpers (Joerd / Mapterhorn)."""

from __future__ import annotations

import io
import math

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "Pillow is required for Terrarium DEM decode. "
        'Install with: pip install -e "python/[api]"'
    ) from exc


def tile_xy(lat: float, lon: float, z: int) -> tuple[int, int]:
    lat_rad = math.radians(lat)
    n = 2**z
    x = int(math.floor(((lon + 180.0) / 360.0) * n))
    y = int(math.floor((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n))
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def pixel_in_tile(lat: float, lon: float, z: int, size: int) -> tuple[int, int]:
    lat_rad = math.radians(lat)
    map_size = size * (2**z)
    px = int(math.floor(((lon + 180.0) / 360.0) * map_size) % size)
    py = int(math.floor((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * map_size) % size)
    return px, py


def terrarium_elevation(r: int, g: int, b: int) -> float:
    return r * 256.0 + g + b / 256.0 - 32768.0


def decode_terrarium_tile(tile_bytes: bytes) -> Image.Image:
    """Decode a Terrarium WEBP/PNG tile to RGBA."""
    img = Image.open(io.BytesIO(tile_bytes))
    return img.convert("RGBA")


def elevation_from_rgba(img: Image.Image, px: int, py: int) -> float:
    w, h = img.size
    cx = max(0, min(px, w - 1))
    cy = max(0, min(py, h - 1))
    r, g, b, _a = img.getpixel((cx, cy))
    return terrarium_elevation(int(r), int(g), int(b))
