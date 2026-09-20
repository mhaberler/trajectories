/**
 * Overlay track sampling: speed / heading at a vertex, nearest point in map pixels.
 */

const R_M = 6371000;
const CARDINALS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];

function toRad(d) {
  return (d * Math.PI) / 180;
}

function toDeg(r) {
  return (r * 180) / Math.PI;
}

export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function speedKmh(a, b) {
  if (a == null || b == null || a.t == null || b.t == null) return null;
  const dt = (b.t - a.t) / 1000;
  if (!(dt > 0)) return null;
  return (haversineM(a, b) / dt) * 3.6;
}

/** Geographic heading degrees [0, 360), a → b. */
export function bearingDeg(a, b) {
  if (a == null || b == null) return null;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
    - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (x === 0 && y === 0) return null;
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function cardinalFromDeg(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  const i = Math.round(deg / 45) % 8;
  return CARDINALS[i];
}

function segmentEnds(coords, i) {
  if (!coords?.length) return { a: null, b: null };
  if (i < coords.length - 1) return { a: coords[i], b: coords[i + 1] };
  if (i > 0) return { a: coords[i - 1], b: coords[i] };
  return { a: coords[i], b: coords[i] };
}

/**
 * @param {{ lat: number, lon: number, z?: number|null, t?: number }[]} coords
 * @param {number} i
 */
export function metricsAt(coords, i) {
  if (!coords?.length || i < 0 || i >= coords.length) return null;
  const c = coords[i];
  const { a, b } = segmentEnds(coords, i);
  const heading = bearingDeg(a, b);
  return {
    lat: c.lat,
    lon: c.lon,
    z: c.z != null && Number.isFinite(c.z) ? c.z : null,
    t: c.t != null && Number.isFinite(c.t) ? c.t : null,
    speedKmh: speedKmh(a, b),
    headingDeg: heading,
    cardinal: cardinalFromDeg(heading),
  };
}

function clickLatLon(latlng) {
  if (!latlng) return null;
  const lat = +latlng.lat;
  const lon = +(latlng.lng ?? latlng.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Nearest vertex among visible tracks, in container pixels.
 * `map` must implement `latLngToContainerPoint({ lat, lng })` → `{ x, y }`.
 *
 * @param {{ visible?: boolean, coords: { lat: number, lon: number }[] }[]} tracks
 * @param {{ lat: number, lng?: number, lon?: number }} latlng
 * @param {{ latLngToContainerPoint: Function }} map
 * @param {number} maxPx
 * @returns {{ track: object, index: number, distPx: number } | null}
 */
export function nearestTrackPoint(tracks, latlng, map, maxPx = 32) {
  const click = clickLatLon(latlng);
  if (!click || !map || typeof map.latLngToContainerPoint !== "function") return null;
  const origin = map.latLngToContainerPoint({ lat: click.lat, lng: click.lon });
  if (!origin) return null;
  const cap = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : 32;
  let best = null;
  for (const track of tracks || []) {
    if (track.visible === false) continue;
    const coords = track.coords;
    if (!coords?.length) continue;
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const p = map.latLngToContainerPoint({ lat: c.lat, lng: c.lon });
      if (!p) continue;
      const distPx = Math.hypot(p.x - origin.x, p.y - origin.y);
      if (distPx > cap) continue;
      if (!best || distPx < best.distPx) best = { track, index: i, distPx };
    }
  }
  return best;
}
