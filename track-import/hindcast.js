/**
 * Point wind for the track-import pin: three ICON models at one lat/lon/AMSL/time.
 */

import { TRAJECTORY_API } from "../src/config.js";
import { cardinalFromDeg } from "../src/overlays/sample.js";

const MODELS = [
  ["icon_d2", "D2"],
  ["icon_eu", "EU"],
  ["icon_global", "Global"],
];

const cache = new Map();

export function windCacheKey(c) {
  return `${(+c.lat).toFixed(5)},${(+c.lon).toFixed(5)},${Math.round(c.z)},${Math.round(c.t)}`;
}

export function canSampleWind(c) {
  return !!c
    && Number.isFinite(+c.lat)
    && Number.isFinite(+c.lon)
    && c.z != null && Number.isFinite(+c.z) && +c.z >= 0
    && c.t != null && Number.isFinite(+c.t);
}

/** Meteorological "from" degrees, shown as the direction the wind blows toward. */
export function towardDeg(fromDeg) {
  if (fromDeg == null || !Number.isFinite(+fromDeg)) return null;
  return ((+fromDeg + 180) % 360 + 360) % 360;
}

function modelParts(sample) {
  if (!sample || sample.error) return null;
  const spd = +sample.wind_speed_kmh;
  const toward = towardDeg(sample.wind_direction_deg);
  if (!Number.isFinite(spd) || toward == null) return null;
  const card = cardinalFromDeg(toward);
  return {
    spd,
    toward,
    spdText: `${spd.toFixed(1)} km/h`,
    dirText: `${Math.round(toward)}°${card ? ` ${card}` : ""}`,
  };
}

function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function closestIds(rows, value, read) {
  if (value == null || !Number.isFinite(+value)) return new Set();
  let best = Infinity;
  const ids = [];
  for (const row of rows) {
    const delta = read(row);
    if (delta < best - 1e-9) {
      best = delta;
      ids.length = 0;
      ids.push(row.id);
    } else if (Math.abs(delta - best) <= 1e-9) {
      ids.push(row.id);
    }
  }
  return new Set(ids);
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
}

/**
 * @param {object[]|"loading"|null} models
 * @param {{ speedKmh?: number|null, headingDeg?: number|null }} [flight]
 * @returns {string}
 */
export function modelRowsHtml(models, flight) {
  const byId = new Map();
  if (Array.isArray(models)) {
    for (const m of models) if (m?.model) byId.set(m.model, m);
  }
  if (models === "loading") {
    return MODELS.map(([, label]) => `<div><span>${label}</span><b>…</b></div>`).join("");
  }
  if (!Array.isArray(models)) return "";
  const rows = [];
  for (const [id, label] of MODELS) {
    const parts = modelParts(byId.get(id));
    if (!parts) continue;
    rows.push({ id, label, ...parts });
  }
  const closeSpd = closestIds(rows, flight?.speedKmh, (row) => Math.abs(row.spd - flight.speedKmh));
  const closeDir = closestIds(rows, flight?.headingDeg, (row) => angDiff(row.toward, flight.headingDeg));
  return rows.map((row) => {
    const spd = closeSpd.has(row.id) ? `<span class="hud-close">${esc(row.spdText)}</span>` : esc(row.spdText);
    const dir = closeDir.has(row.id) ? `<span class="hud-close">${esc(row.dirText)}</span>` : esc(row.dirText);
    return `<div><span>${row.label}</span><b>${spd} · ${dir}</b></div>`;
  }).join("");
}

/**
 * @param {{ lat: number, lon: number, z: number, t: number }} c
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchPointWind(c, fetchImpl = fetch) {
  const key = windCacheKey(c);
  if (cache.has(key)) return cache.get(key);
  const params = new URLSearchParams({
    latitude: String(c.lat),
    longitude: String(c.lon),
    models: MODELS.map(([id]) => id).join(","),
    time: new Date(c.t).toISOString(),
    height_amsl: String(c.z),
  });
  const resp = await fetchImpl(`${TRAJECTORY_API}/v1/wind?${params}`);
  const body = await resp.json().catch(() => null);
  if (!resp.ok || !body || body.error || !Array.isArray(body.models)) {
    throw new Error(body?.reason || `Wind ${resp.status}`);
  }
  cache.set(key, body.models);
  return body.models;
}
