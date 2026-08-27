/**
 * Import GPX / KML / KMZ / GeoJSON flight tracks → overlay drafts (line geometry only).
 * Uses @tmcw/togeojson for XML formats; GeoJSON via JSON.parse; KMZ via fflate unzip.
 */

/**
 * @typedef {{ lat: number, lon: number, z: number|null, t?: number }} OverlayCoord
 * @typedef {{ name: string, sourceName: string, coords: OverlayCoord[] }} OverlayDraft
 */

const FLIGHTPACK_START_RE =
  /Starting at time\s+(\d{2})_(\d{2})_(\d{4})\s+(\d{2})_(\d{2})_(\d{2})/i;
const FLIGHTPACK_PERIOD_RE = /Sampling period is\s+(\d+(?:\.\d+)?)\s+seconds/i;

/**
 * @param {Document} doc
 * @returns {string}
 */
function kmlDescriptionText(doc) {
  const documents = doc.getElementsByTagName("Document");
  const n = documents.length;
  for (let i = 0; i < n; i++) {
    const node = documents[i];
    const descs = node.getElementsByTagName("description");
    for (let j = 0; j < descs.length; j++) {
      const el = descs[j];
      const parent = el.parentNode;
      const raw = parent && (parent.localName || parent.nodeName || "");
      const parentName = String(raw).replace(/^.*:/, "").toLowerCase();
      if (parentName === "document") {
        return String(el.textContent || "").trim();
      }
    }
    if (descs.length) return String(descs[0].textContent || "").trim();
  }
  const all = doc.getElementsByTagName("description");
  return all.length ? String(all[0].textContent || "").trim() : "";
}

/**
 * @param {string} desc
 * @returns {{ day: number, month: number, year: number, hour: number, minute: number, second: number, periodSec: number }|null}
 */
function parseFlightPackClock(desc) {
  if (!/Ultramagic\s+FlightPack/i.test(desc)) return null;
  const start = desc.match(FLIGHTPACK_START_RE);
  const period = desc.match(FLIGHTPACK_PERIOD_RE);
  if (!start || !period) return null;
  const day = +start[1];
  const month = +start[2];
  const year = +start[3];
  const hour = +start[4];
  const minute = +start[5];
  const second = +start[6];
  const periodSec = +period[1];
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1000)) return null;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 60)) {
    return null;
  }
  if (!(periodSec > 0) || !Number.isFinite(periodSec)) return null;
  return { day, month, year, hour, minute, second, periodSec };
}

/**
 * Offset of `timeZone` from UTC at `utcMs` (local − UTC).
 * @param {number} utcMs
 * @param {string} timeZone
 */
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.create(null);
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  );
  return asUtc - utcMs;
}

/**
 * Wall clock in `timeZone` → epoch ms.
 * @param {{ year: number, month: number, day: number, hour: number, minute: number, second: number }} wall
 * @param {string} timeZone
 */
function wallTimeToUtcMs(wall, timeZone) {
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  let utc = wallAsUtc - tzOffsetMs(wallAsUtc, timeZone);
  utc = wallAsUtc - tzOffsetMs(utc, timeZone);
  return utc;
}

/**
 * @param {{ drafts: OverlayDraft[], warnings: string[] }} result
 * @param {Document} doc
 */
async function applyFlightPackTimes(result, doc) {
  const clock = parseFlightPackClock(kmlDescriptionText(doc));
  if (!clock) return;

  let first = null;
  for (const d of result.drafts) {
    if (d.coords?.length) {
      first = d.coords[0];
      break;
    }
  }
  if (!first) return;

  let timeZone;
  try {
    const mod = await import("tz-lookup");
    const tzlookup = mod.default || mod;
    timeZone = tzlookup(first.lat, first.lon);
  } catch (err) {
    result.warnings.push(`FlightPack-Zeitzone unbekannt: ${err.message || err}`);
    return;
  }
  if (!timeZone || typeof timeZone !== "string") {
    result.warnings.push("FlightPack-Zeitzone unbekannt.");
    return;
  }

  let startUtcMs;
  try {
    startUtcMs = wallTimeToUtcMs(clock, timeZone);
  } catch (err) {
    result.warnings.push(`FlightPack-Startzeit ungültig: ${err.message || err}`);
    return;
  }
  if (!Number.isFinite(startUtcMs)) {
    result.warnings.push("FlightPack-Startzeit ungültig.");
    return;
  }

  const step = clock.periodSec * 1000;
  for (const d of result.drafts) {
    if (d.coords.some((c) => c.t != null)) continue;
    for (let i = 0; i < d.coords.length; i++) {
      d.coords[i].t = startUtcMs + i * step;
    }
  }
}

/**
 * @param {unknown} v ISO string, epoch ms, or epoch seconds
 * @returns {number|null}
 */
function parseTimeMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.round(v * 1000) : v;
  }
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * togeojson: `coordTimes`; GeoJSON-T / others: `times` or `coordinateProperties.times`.
 * @param {Record<string, unknown>|null|undefined} props
 * @returns {unknown[]|undefined}
 */
function coordTimesFromProps(props) {
  if (!props || typeof props !== "object") return undefined;
  const cp = props.coordinateProperties;
  if (cp && typeof cp === "object") {
    const nested = /** @type {Record<string, unknown>} */ (cp).times;
    if (Array.isArray(nested)) return nested;
  }
  if (Array.isArray(props.coordTimes)) return props.coordTimes;
  if (Array.isArray(props.times)) return props.times;
  return undefined;
}

/**
 * @param {unknown[]|undefined} times
 * @param {number} partIndex
 * @param {boolean} multi
 * @returns {unknown[]|undefined}
 */
function timesForPart(times, partIndex, multi) {
  if (!Array.isArray(times)) return undefined;
  if (!multi) return times;
  const part = times[partIndex];
  return Array.isArray(part) ? part : undefined;
}

/**
 * @param {number[]} c GeoJSON position [lon, lat, ele?]
 * @returns {OverlayCoord|null}
 */
function posToCoord(c) {
  if (!Array.isArray(c) || c.length < 2) return null;
  const lon = +c[0];
  const lat = +c[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const z = c.length > 2 && Number.isFinite(+c[2]) ? +c[2] : null;
  return { lat, lon, z };
}

/**
 * @param {unknown} coords LineString coordinates
 * @param {unknown[]|undefined} [times]
 * @returns {OverlayCoord[]}
 */
export function lineCoords(coords, times) {
  if (!Array.isArray(coords)) return [];
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const p = posToCoord(coords[i]);
    if (!p) continue;
    const t = parseTimeMs(times?.[i]);
    if (t != null) p.t = t;
    out.push(p);
  }
  return out;
}

/**
 * @param {OverlayDraft[]} out
 * @param {string} name
 * @param {string} sourceName
 * @param {OverlayCoord[]} coords
 */
function pushLine(out, name, sourceName, coords) {
  if (coords.length < 2) return;
  out.push({ name, sourceName, coords });
}

/**
 * @param {GeoJSON.Geometry|null|undefined} geom
 * @param {string} name
 * @param {string} sourceName
 * @param {OverlayDraft[]} out
 * @param {unknown[]|undefined} [times]
 */
function collectGeometry(geom, name, sourceName, out, times) {
  if (!geom || !geom.type) return;
  if (geom.type === "LineString") {
    pushLine(out, name, sourceName, lineCoords(geom.coordinates, timesForPart(times, 0, false)));
  } else if (geom.type === "MultiLineString") {
    const parts = Array.isArray(geom.coordinates) ? geom.coordinates : [];
    parts.forEach((part, i) => {
      const label = parts.length > 1 ? `${name} (${i + 1})` : name;
      pushLine(out, label, sourceName, lineCoords(part, timesForPart(times, i, true)));
    });
  } else if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
    for (const g of geom.geometries) collectGeometry(g, name, sourceName, out);
  }
}

/**
 * @param {unknown} gj
 * @param {string} sourceName
 * @returns {{ drafts: OverlayDraft[], warnings: string[] }}
 */
export function overlaysFromGeoJSON(gj, sourceName) {
  const drafts = [];
  const warnings = [];
  if (!gj || typeof gj !== "object") {
    return { drafts, warnings: ["Kein gültiges GeoJSON."] };
  }
  const root = /** @type {Record<string, unknown>} */ (gj);
  if (root.type === "FeatureCollection" && Array.isArray(root.features)) {
    for (const f of root.features) {
      if (!f || typeof f !== "object") continue;
      const feat = /** @type {Record<string, unknown>} */ (f);
      const props = /** @type {Record<string, unknown>} */ (feat.properties || {});
      const name = String(props.name || props.Name || sourceName);
      collectGeometry(/** @type {any} */ (feat.geometry), name, sourceName, drafts, coordTimesFromProps(props));
    }
  } else if (root.type === "Feature") {
    const props = /** @type {Record<string, unknown>} */ (root.properties || {});
    const name = String(props.name || props.Name || sourceName);
    collectGeometry(/** @type {any} */ (root.geometry), name, sourceName, drafts, coordTimesFromProps(props));
  } else if (typeof root.type === "string") {
    collectGeometry(/** @type {any} */ (gj), sourceName, sourceName, drafts);
  } else {
    warnings.push("Unbekanntes GeoJSON-Objekt.");
  }
  if (!drafts.length) warnings.push("Keine Linienzüge (LineString) gefunden.");
  return { drafts, warnings };
}

/**
 * @param {string} xml
 * @returns {Promise<Document>}
 */
async function parseXml(xml) {
  if (typeof DOMParser !== "undefined") {
    return new DOMParser().parseFromString(xml, "text/xml");
  }
  const { DOMParser: XDOMParser } = await import("@xmldom/xmldom");
  return new XDOMParser().parseFromString(xml, "text/xml");
}

/**
 * KML-Text aus einem KMZ (ZIP) holen. Bevorzugt `doc.kml`, sonst erste `.kml`.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{ kmlText: string, kmlPath: string }>}
 */
export async function kmlFromKmz(buffer) {
  const { unzipSync, strFromU8 } = await import("fflate");
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let files;
  try {
    files = unzipSync(raw);
  } catch (err) {
    throw new Error(`KMZ konnte nicht entpackt werden: ${err.message || err}`);
  }
  const paths = Object.keys(files).filter((p) => /\.kml$/i.test(p) && !p.endsWith("/"));
  if (!paths.length) throw new Error("Keine .kml-Datei im KMZ.");
  const preferred = paths.find((p) => /(^|\/)doc\.kml$/i.test(p)) || paths[0];
  return { kmlText: strFromU8(files[preferred]), kmlPath: preferred };
}

/**
 * @param {string} text
 * @param {string} filename
 * @returns {Promise<{ drafts: OverlayDraft[], warnings: string[] }>}
 */
export async function parseOverlayFile(text, filename) {
  const sourceName = filename || "track";
  const lower = sourceName.toLowerCase();
  if (lower.endsWith(".kmz")) {
    return {
      drafts: [],
      warnings: ["KMZ bitte als Binärdatei laden (parseOverlayBytes)."],
    };
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) return { drafts: [], warnings: ["Datei ist leer."] };

  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[")
    || lower.endsWith(".geojson") || lower.endsWith(".json");
  const looksGpx = /<gpx[\s>]/i.test(trimmed) || lower.endsWith(".gpx");
  const looksKml = /<kml[\s>]/i.test(trimmed) || lower.endsWith(".kml");

  if (looksJson && !looksGpx && !looksKml) {
    try {
      return overlaysFromGeoJSON(JSON.parse(trimmed), sourceName);
    } catch (err) {
      return { drafts: [], warnings: [`GeoJSON-Parsefehler: ${err.message}`] };
    }
  }

  if (looksGpx || looksKml) {
    const { gpx, kml } = await import("@tmcw/togeojson");
    const doc = await parseXml(trimmed);
    const errNode = typeof doc.querySelector === "function"
      ? doc.querySelector("parsererror")
      : null;
    if (errNode) {
      return { drafts: [], warnings: ["XML konnte nicht gelesen werden."] };
    }
    try {
      const gj = looksGpx ? gpx(doc) : kml(doc);
      const result = overlaysFromGeoJSON(gj, sourceName);
      if (looksKml) await applyFlightPackTimes(result, doc);
      return result;
    } catch (err) {
      return { drafts: [], warnings: [`${looksGpx ? "GPX" : "KML"}-Konvertierung: ${err.message}`] };
    }
  }

  try {
    return overlaysFromGeoJSON(JSON.parse(trimmed), sourceName);
  } catch {
    /* fall through */
  }
  return { drafts: [], warnings: ["Format nicht erkannt (GPX, KML, KMZ oder GeoJSON)."] };
}

/**
 * Binäre oder textuelle Overlay-Datei (KMZ als ArrayBuffer).
 * @param {ArrayBuffer|Uint8Array|string} data
 * @param {string} filename
 */
export async function parseOverlayBytes(data, filename) {
  const sourceName = filename || "track";
  const lower = sourceName.toLowerCase();
  if (lower.endsWith(".kmz")) {
    try {
      const buf = typeof data === "string"
        ? new TextEncoder().encode(data)
        : data;
      const { kmlText } = await kmlFromKmz(buf);
      return parseOverlayFile(kmlText, sourceName.replace(/\.kmz$/i, ".kml"));
    } catch (err) {
      return { drafts: [], warnings: [err.message || String(err)] };
    }
  }
  if (typeof data === "string") return parseOverlayFile(data, filename);
  const text = new TextDecoder("utf-8").decode(
    data instanceof Uint8Array ? data : new Uint8Array(data),
  );
  return parseOverlayFile(text, filename);
}
