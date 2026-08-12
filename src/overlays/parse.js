/**
 * Import GPX / KML / GeoJSON flight tracks → overlay drafts (line geometry only).
 * Uses @tmcw/togeojson for XML formats; GeoJSON via JSON.parse.
 */

/**
 * @typedef {{ lat: number, lon: number, z: number|null }} OverlayCoord
 * @typedef {{ name: string, sourceName: string, coords: OverlayCoord[] }} OverlayDraft
 */

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
 * @returns {OverlayCoord[]}
 */
export function lineCoords(coords) {
  if (!Array.isArray(coords)) return [];
  const out = [];
  for (const c of coords) {
    const p = posToCoord(c);
    if (p) out.push(p);
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
 */
function collectGeometry(geom, name, sourceName, out) {
  if (!geom || !geom.type) return;
  if (geom.type === "LineString") {
    pushLine(out, name, sourceName, lineCoords(geom.coordinates));
  } else if (geom.type === "MultiLineString") {
    const parts = Array.isArray(geom.coordinates) ? geom.coordinates : [];
    parts.forEach((part, i) => {
      const label = parts.length > 1 ? `${name} (${i + 1})` : name;
      pushLine(out, label, sourceName, lineCoords(part));
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
      collectGeometry(/** @type {any} */ (feat.geometry), name, sourceName, drafts);
    }
  } else if (root.type === "Feature") {
    const props = /** @type {Record<string, unknown>} */ (root.properties || {});
    const name = String(props.name || props.Name || sourceName);
    collectGeometry(/** @type {any} */ (root.geometry), name, sourceName, drafts);
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
 * @param {string} text
 * @param {string} filename
 * @returns {Promise<{ drafts: OverlayDraft[], warnings: string[] }>}
 */
export async function parseOverlayFile(text, filename) {
  const sourceName = filename || "track";
  const lower = sourceName.toLowerCase();
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

  // Fallback: try JSON then GPX sniff
  try {
    return overlaysFromGeoJSON(JSON.parse(trimmed), sourceName);
  } catch {
    /* fall through */
  }
  return { drafts: [], warnings: ["Format nicht erkannt (GPX, KML oder GeoJSON)."] };
}
