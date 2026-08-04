/**
 * Browser-side Mapterhorn DEM lookup (Terrarium-encoded PMTiles).
 *
 * Routing (same as Montgolfiere MapterhornDEMLookup):
 *   z ≤ 12 → planet.pmtiles
 *   z > 12 → 6-{rx}-{ry}.pmtiles  (rx = x>>(z-6), ry = y>>(z-6))
 * Try z=15 … fall back to planet maxZoom (12).
 *
 * FUTURE: dense along-track sampling could move to the API
 * (e.g. terrain_hires_m on GeoJSON) so clients share cache and skip
 * browser tile I/O — do not remove this module until then.
 */

import { PMTiles } from "pmtiles";

const BASE_URL = "https://download.mapterhorn.com";
const PLANET_MAX_ZOOM = 12;
const MAX_ZOOM_TRY = 15;
const DEFAULT_TILE_SIZE = 512;
const TILE_CACHE_MAX = 64;

/** @type {PMTiles | null} */
let planet = null;
/** @type {Map<string, PMTiles>} */
const regional = new Map();
/** @type {Map<string, ArrayBuffer>} */
const tileCache = new Map();
/** @type {Map<string, number>} */
const regionalMaxZoom = new Map();
/** @type {Promise<void> | null} */
let initPromise = null;
let planetMaxZoom = PLANET_MAX_ZOOM;
let tileSize = DEFAULT_TILE_SIZE;

function getPlanet() {
  if (!planet) planet = new PMTiles(`${BASE_URL}/planet.pmtiles`);
  return planet;
}

async function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const p = getPlanet();
    try {
      const header = await p.getHeader();
      planetMaxZoom = header.maxZoom || PLANET_MAX_ZOOM;
      // Probe a mid tile for size; fall back to 512 (Mapterhorn default).
      const z = Math.min(planetMaxZoom, Math.max(header.minZoom || 0, 8));
      const n = 2 ** z;
      const tr = await p.getZxy(z, Math.floor(n / 2), Math.floor(n / 2));
      if (tr?.data) {
        const bmp = await createImageBitmap(new Blob([tr.data]));
        tileSize = bmp.width || DEFAULT_TILE_SIZE;
        bmp.close();
      }
    } catch {
      planetMaxZoom = PLANET_MAX_ZOOM;
      tileSize = DEFAULT_TILE_SIZE;
    }
  })();
  return initPromise;
}

function regionalName(x, y, z) {
  const rx = x >> (z - 6);
  const ry = y >> (z - 6);
  return `6-${rx}-${ry}`;
}

function pmtilesFor(x, y, z) {
  if (z <= planetMaxZoom) return getPlanet();
  const name = regionalName(x, y, z);
  let inst = regional.get(name);
  if (!inst) {
    inst = new PMTiles(`${BASE_URL}/${name}.pmtiles`);
    regional.set(name, inst);
  }
  return inst;
}

function cachePut(key, data) {
  if (tileCache.size >= TILE_CACHE_MAX) {
    const first = tileCache.keys().next().value;
    tileCache.delete(first);
  }
  tileCache.set(key, data);
}

async function fetchTile(x, y, z) {
  if (z > planetMaxZoom) {
    const name = regionalName(x, y, z);
    const known = regionalMaxZoom.get(name);
    if (known !== undefined && z > known) return null;
  }
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  try {
    const pm = pmtilesFor(x, y, z);
    const tr = await pm.getZxy(z, x, y);
    const data = tr?.data || null;
    if (!data) {
      if (z > planetMaxZoom) {
        const name = regionalName(x, y, z);
        const prev = regionalMaxZoom.get(name);
        if (prev === undefined || z - 1 < prev) regionalMaxZoom.set(name, z - 1);
      }
      return null;
    }
    cachePut(key, data);
    return data;
  } catch {
    if (z > planetMaxZoom) {
      const name = regionalName(x, y, z);
      const prev = regionalMaxZoom.get(name);
      if (prev === undefined || z - 1 < prev) regionalMaxZoom.set(name, z - 1);
    }
    return null;
  }
}

function tileXY(lat, lon, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

function pixelInTile(lat, lon, z, size) {
  const latRad = (lat * Math.PI) / 180;
  const mapSize = size * 2 ** z;
  const px = Math.floor(((lon + 180) / 360) * mapSize) % size;
  const py = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * mapSize) % size;
  return [px, py];
}

/** Terrarium: R*256 + G + B/256 - 32768 */
async function decodeTerrarium(tileData, px, py) {
  const bmp = await createImageBitmap(new Blob([tileData]));
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0);
  const cx = Math.max(0, Math.min(px, canvas.width - 1));
  const cy = Math.max(0, Math.min(py, canvas.height - 1));
  const [r, g, b] = ctx.getImageData(cx, cy, 1, 1).data;
  bmp.close();
  return r * 256 + g + b / 256 - 32768;
}

/**
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<number|null>} elevation m (Terrarium / AMSL-ish)
 */
export async function getElevation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  await ensureInit();
  for (let z = MAX_ZOOM_TRY; z >= planetMaxZoom; z--) {
    const [x, y] = tileXY(lat, lon, z);
    const data = await fetchTile(x, y, z);
    if (!data) continue;
    const [px, py] = pixelInTile(lat, lon, z, tileSize);
    try {
      const elev = await decodeTerrarium(data, px, py);
      if (elev != null && Number.isFinite(elev)) return elev;
    } catch {
      /* try lower zoom */
    }
  }
  return null;
}

/**
 * Interpolate lat/lon on a track at relative tSec from start.
 * @param {{ lat: number, lon: number, tMs: number }[]} points
 * @param {number} tSec
 */
export function pointAtTrackTime(points, tSec) {
  if (!points?.length) return null;
  const t0 = points[0].tMs;
  const tMs = t0 + tSec * 1000;
  if (tMs <= points[0].tMs) return { lat: points[0].lat, lon: points[0].lon, tSec: 0 };
  const last = points[points.length - 1];
  if (tMs >= last.tMs) {
    return { lat: last.lat, lon: last.lon, tSec: (last.tMs - t0) / 1000 };
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (tMs <= b.tMs) {
      const u = (tMs - a.tMs) / Math.max(1, b.tMs - a.tMs);
      return {
        lat: a.lat + u * (b.lat - a.lat),
        lon: a.lon + u * (b.lon - a.lon),
        tSec,
      };
    }
  }
  return { lat: last.lat, lon: last.lon, tSec: (last.tMs - t0) / 1000 };
}

/**
 * Sample Mapterhorn elevation along a track at a fixed time interval.
 * @param {{ lat: number, lon: number, tMs: number }[]} points
 * @param {{ intervalSec?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ tSec: number, z: number }[]>}
 */
export async function sampleTrackTerrain(points, opts = {}) {
  const intervalSec = Math.max(15, +(opts.intervalSec ?? 60) || 60);
  const signal = opts.signal;
  if (!points || points.length < 2) return [];
  await ensureInit();
  const t0 = points[0].tMs;
  const tEnd = (points[points.length - 1].tMs - t0) / 1000;
  /** @type {number[]} */
  const times = [0];
  for (let t = intervalSec; t < tEnd - 1e-6; t += intervalSec) times.push(t);
  if (tEnd > 0) times.push(tEnd);

  /** @type {{ tSec: number, z: number }[]} */
  const out = [];
  for (const tSec of times) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const pos = pointAtTrackTime(points, tSec);
    if (!pos) continue;
    const z = await getElevation(pos.lat, pos.lon);
    if (z != null && Number.isFinite(z)) out.push({ tSec, z });
  }
  return out;
}

/** Cache key for a track + interval. */
export function trackSampleKey(points, intervalSec) {
  if (!points?.length) return "";
  const a = points[0];
  const b = points[points.length - 1];
  return [
    intervalSec,
    points.length,
    a.tMs, b.tMs,
    a.lat.toFixed(4), a.lon.toFixed(4),
    b.lat.toFixed(4), b.lon.toFixed(4),
  ].join("|");
}
