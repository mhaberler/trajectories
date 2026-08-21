/* global L */

const PHOTON = "https://photon.komoot.io";
const HISTORY_KEY = "trajektorien.geocodeHistory";
const HISTORY_MAX = 5;

/** OSM-Werte, die selbst ein Ort sind (nicht Straße/Haus). */
const LOCALITY_OSM = new Set([
  "city", "town", "village", "hamlet", "municipality", "suburb", "neighbourhood",
  "locality", "county", "state", "district",
]);

function featureLabel(props) {
  const name = props.name || props.street || props.city || "Ort";
  const crumbs = [props.city, props.county, props.state, props.country]
    .filter(Boolean)
    .filter((c, i, a) => a.indexOf(c) === i && c !== name);
  return { name, sub: crumbs.join(", ") };
}

/**
 * Ortsname für Dateinamen: Stadt/Gemeinde/Dorf, nicht Straße.
 * Photon liefert bei Reverse oft `name=Flurgasse` plus `city=Lieboch`.
 */
export function localityName(props) {
  const p = props || {};
  const cityish = p.city || p.town || p.village || p.municipality
    || p.district || p.county;
  if (cityish) return String(cityish);
  const kind = String(p.osm_value || p.type || "");
  if (p.name && LOCALITY_OSM.has(kind)) return String(p.name);
  // Kein Straßenname als Ort
  if (p.name && kind !== "street" && kind !== "highway" && kind !== "house"
      && !p.street) {
    return String(p.name);
  }
  return cityish ? String(cityish) : null;
}

function textEl(tag, text, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  n.textContent = text;
  return n;
}

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((h) => Number.isFinite(h?.lat) && Number.isFinite(h?.lon) && h?.name)
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch { /* quota / private mode */ }
}

/** @param {{ lat: number, lon: number, name: string, sub?: string, placeName?: string }} entry */
function pushHistory(entry) {
  const key = `${entry.lat.toFixed(4)},${entry.lon.toFixed(4)}`;
  const next = [
    entry,
    ...loadHistory().filter((h) => `${h.lat.toFixed(4)},${h.lon.toFixed(4)}` !== key),
  ].slice(0, HISTORY_MAX);
  saveHistory(next);
}

/** History row → GeoJSON-like feature for the shared picker. */
function historyAsFeature(h) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [h.lon, h.lat] },
    properties: {
      name: h.name,
      city: h.sub || undefined,
      _placeName: h.placeName || h.name,
      _fromHistory: true,
    },
  };
}

async function photonSearch(q) {
  const url = `${PHOTON}/api/?${new URLSearchParams({ q, limit: "5", lang: "de" })}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.features) ? data.features : [];
}

export async function photonReverse(lat, lon) {
  const url = `${PHOTON}/reverse?${new URLSearchParams({
    lat: String(lat), lon: String(lon), limit: "1", lang: "de",
  })}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const data = await resp.json();
  const f = data.features?.[0];
  if (!f) return null;
  const { name, sub } = featureLabel(f.properties || {});
  return sub ? `${name} — ${sub}` : name;
}

/** Kurzer Ortsname für Dateinamen (Stadt/Gemeinde, nicht Straße). */
export async function reversePlaceName(lat, lon) {
  const url = `${PHOTON}/reverse?${new URLSearchParams({
    lat: String(lat), lon: String(lon), limit: "1", lang: "de",
  })}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const data = await resp.json();
  const f = data.features?.[0];
  if (!f) return null;
  return localityName(f.properties || {}) || null;
}

/**
 * @param {{ map: L.Map, setStart: (lat: number, lon: number, opts?: { placeName?: string|null }) => void, debounce: Function, el: (id: string) => HTMLElement }} opts
 */
export function initGeocode({ map, setStart, debounce, el }) {
  const input = el("geocode");
  const list = el("geocode-results");
  if (!input || !list) return;

  let hits = [];
  let active = -1;
  /** @type {"search" | "history"} */
  let mode = "search";

  function hide() {
    list.hidden = true;
    list.innerHTML = "";
    hits = [];
    active = -1;
    mode = "search";
  }

  function showHistory() {
    const hist = loadHistory();
    if (!hist.length) {
      hide();
      return;
    }
    mode = "history";
    hits = hist.map(historyAsFeature);
    active = hits.length ? 0 : -1;
    render();
  }

  function render() {
    list.innerHTML = "";
    if (!hits.length) {
      list.hidden = true;
      return;
    }
    if (mode === "history") {
      const head = document.createElement("li");
      head.className = "geo-history-head";
      head.textContent = "Zuletzt gesucht";
      head.setAttribute("aria-hidden", "true");
      list.appendChild(head);
    }
    hits.forEach((f, i) => {
      const props = f.properties || {};
      const { name, sub } = featureLabel(props);
      const li = document.createElement("li");
      li.dataset.i = String(i);
      li.setAttribute("role", "option");
      if (i === active) li.classList.add("active");
      if (props._fromHistory) li.classList.add("geo-history");
      li.appendChild(document.createTextNode(name));
      if (sub) li.appendChild(textEl("span", sub, "geo-sub"));
      li.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus; avoid blur-before-click
        pick(i);
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function pick(i) {
    const f = hits[i];
    if (!f?.geometry?.coordinates) return;
    const [lon, lat] = f.geometry.coordinates;
    const props = f.properties || {};
    const { name, sub } = featureLabel(props);
    input.value = sub ? `${name}, ${sub}` : name;
    const place = props._placeName || localityName(props) || name;
    pushHistory({
      lat, lon, name, sub: sub || "", placeName: place,
    });
    hide();
    setStart(lat, lon, { placeName: place });
    map.setView([lat, lon], Math.max(map.getZoom(), 11));
  }

  const runSearch = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      if (document.activeElement === input) showHistory();
      else hide();
      return;
    }
    mode = "search";
    try {
      hits = await photonSearch(q);
      active = hits.length ? 0 : -1;
      render();
    } catch {
      hide();
    }
  }, 300);

  input.addEventListener("input", runSearch);
  input.addEventListener("focus", () => {
    const q = input.value.trim();
    if (q.length < 2) showHistory();
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !hits.length) {
      if (e.key === "Escape") hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % hits.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + hits.length) % hits.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    }
  });
  input.addEventListener("blur", () => {
    // Delay so mousedown on a result can fire first.
    setTimeout(hide, 150);
  });

  map.on("contextmenu", async (e) => {
    L.DomEvent.preventDefault(e.originalEvent);
    const { lat, lng: lon } = e.latlng;
    const popup = L.popup({ maxWidth: 280 }).setLatLng(e.latlng)
      .setContent(textEl("div", "Suche Ort …"))
      .openOn(map);
    try {
      const label = await photonReverse(lat, lon);
      popup.setContent(textEl("div", label || "Kein Ort gefunden"));
    } catch {
      popup.setContent(textEl("div", "Geocoding fehlgeschlagen"));
    }
  });
}
