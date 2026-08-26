/**
 * Import GPX / KML / KMZ / GeoJSON flight tracks → overlay drafts (line geometry only).
 * Uses @tmcw/togeojson for XML formats; GeoJSON via JSON.parse; KMZ via fflate unzip.
 */

/**
 * @typedef {{ lat: number, lon: number, z: number|null, t?: number }} OverlayCoord
 * @typedef {{ name: string, sourceName: string, coords: OverlayCoord[] }} OverlayDraft
 */

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
      return overlaysFromGeoJSON(gj, sourceName);
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
