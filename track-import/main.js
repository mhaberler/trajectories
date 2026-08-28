import { parseOverlayBytes } from "@overlays";
import { mountColormapSelect, colorStops } from "./colormapSelect.js";
import { mountScalePill, niceTicks } from "./scalePill.js";

const STORAGE_KEY = "track-import:v1";
const DEFAULTS = {
  mode: "speed",
  colormap: "viridis",
  cmapReverse: false,
  maxSpeed: 80,
  maxAlt: 4000,
  fixedColor: "#c45c26",
  legendOrient: "horizontal",
};

const FALLBACK = "#888888";

/** @type {typeof DEFAULTS} */
const settings = loadSettings();

/** @type {{ id: string, name: string, sourceName: string, visible: boolean, coords: { lat: number, lon: number, z: number|null, t?: number }[] }[]} */
const tracks = [];
let idSeq = 0;

const map = L.map("map", { center: [50.5, 10.5], zoom: 6 });
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: ["a", "b", "c"],
  }),
  "OpenTopoMap": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    subdomains: ["a", "b", "c"],
    attribution: "© OpenStreetMap contributors, SRTM | © <a href=\"https://opentopomap.org\">OpenTopoMap</a> (CC-BY-SA)",
  }),
  "Esri Satellit (hybrid)": L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
    }),
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      pane: "overlayPane",
      zIndex: 2,
    }),
  ], {
    attribution: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community",
  }),
};
baseLayers["OpenStreetMap"].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);

const trackLayer = L.layerGroup().addTo(map);

const el = (id) => document.getElementById(id);

const cmap = mountColormapSelect(el("colormap-host"), {
  name: settings.colormap,
  reverse: settings.cmapReverse,
  domain: currentDomain(),
  onChange(name) {
    settings.colormap = name;
    persist();
    syncUi();
    redraw();
  },
});

const ScalePillControl = L.Control.extend({
  onAdd() {
    const div = L.DomUtil.create("div", "leaflet-control scale-pill-ctl");
    this._host = div;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
  },
});
const mapPillCtl = new ScalePillControl({ position: "bottomright" }).addTo(map);
const mapPill = mountScalePill(mapPillCtl._host, { compact: false });

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const s = JSON.parse(raw);
    return {
      mode: ["speed", "altitude", "fixed"].includes(s.mode) ? s.mode : DEFAULTS.mode,
      colormap: typeof s.colormap === "string" ? s.colormap : DEFAULTS.colormap,
      cmapReverse: s.cmapReverse === true,
      maxSpeed: Number.isFinite(+s.maxSpeed) && +s.maxSpeed > 0 ? +s.maxSpeed : DEFAULTS.maxSpeed,
      maxAlt: Number.isFinite(+s.maxAlt) && +s.maxAlt > 0 ? +s.maxAlt : DEFAULTS.maxAlt,
      fixedColor: typeof s.fixedColor === "string" ? s.fixedColor : DEFAULTS.fixedColor,
      legendOrient: s.legendOrient === "vertical" ? "vertical" : DEFAULTS.legendOrient,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

function currentDomain() {
  const max = settings.mode === "altitude" ? settings.maxAlt : settings.maxSpeed;
  return [0, max];
}

function currentMax() {
  return settings.mode === "altitude" ? settings.maxAlt : settings.maxSpeed;
}

/** Pill domain: km for altitude, km/h for speed. Coloring still uses metres. */
function scaleDisplay() {
  const max = currentMax();
  if (settings.mode === "altitude") {
    const maxKm = max / 1000;
    return { unit: "km", max: maxKm, ticks: niceTicks(0, maxKm, 4) };
  }
  return { unit: "km/h", max, ticks: niceTicks(0, max, 4) };
}

function setStatus(msg, isError = false) {
  const s = el("status");
  s.textContent = msg || "";
  s.classList.toggle("error", !!isError);
}

function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function speedKmh(a, b) {
  if (a.t == null || b.t == null) return null;
  const dt = (b.t - a.t) / 1000;
  if (!(dt > 0)) return null;
  return (haversineM(a, b) / dt) * 3.6;
}

function segmentAlt(a, b) {
  const z = b.z ?? a.z;
  return z != null && Number.isFinite(z) ? z : null;
}

function clamp01(v, max) {
  if (!Number.isFinite(v) || !(max > 0)) return 0;
  if (v <= 0) return 0;
  if (v >= max) return max;
  return v;
}

function colorForValue(scale, v, max) {
  if (v == null) return FALLBACK;
  return scale(clamp01(v, max)).hex();
}

function syncUi() {
  for (const r of document.querySelectorAll('input[name="color-mode"]')) {
    r.checked = r.value === settings.mode;
  }
  el("max-speed").value = String(settings.maxSpeed);
  el("max-alt").value = (settings.maxAlt / 1000).toFixed(1);
  el("fixed-color").value = settings.fixedColor;
  const scaled = settings.mode !== "fixed";
  el("scale-block").hidden = !scaled;
  el("fixed-row").hidden = scaled;
  el("max-speed-row").hidden = settings.mode !== "speed";
  el("max-alt-row").hidden = settings.mode !== "altitude";
  for (const r of document.querySelectorAll('input[name="legend-orient"]')) {
    r.checked = r.value === settings.legendOrient;
  }
  el("cmap-reverse").checked = settings.cmapReverse;
  cmap.setName(settings.colormap);
  cmap.setReverse(settings.cmapReverse);
  cmap.setDomain(currentDomain());
  const vertical = settings.legendOrient === "vertical";
  const dir = vertical ? "to top" : "to right";
  const stops = colorStops(settings.colormap, 16);
  if (settings.cmapReverse) stops.reverse();
  const gradientCss = `linear-gradient(${dir}, ${stops.join(",")})`;
  const payload = { ...scaleDisplay(), gradientCss, vertical };
  mapPill.set(payload);
  const mapBox = mapPillCtl.getContainer();
  if (mapBox) {
    mapBox.style.display = scaled ? "" : "none";
    mapBox.classList.toggle("vertical", vertical);
  }
}

function renderList() {
  const host = el("overlays-list");
  host.replaceChildren();
  for (const t of tracks) {
    const row = document.createElement("div");
    row.className = "track-card";
    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = t.visible;
    vis.title = "Anzeigen";
    vis.addEventListener("change", () => {
      t.visible = vis.checked;
      redraw();
    });
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.name;
    name.title = t.sourceName || t.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Entfernen";
    rm.addEventListener("click", () => {
      const i = tracks.findIndex((x) => x.id === t.id);
      if (i >= 0) tracks.splice(i, 1);
      renderList();
      redraw();
    });
    row.append(vis, name, rm);
    host.appendChild(row);
  }
}

function redraw() {
  trackLayer.clearLayers();
  cmap.setDomain(currentDomain());
  const scale = cmap.scale();
  const max = currentMax();
  let missingSpeed = 0;
  let missingAlt = 0;
  let segs = 0;

  for (const t of tracks) {
    if (!t.visible || t.coords.length < 2) continue;
    if (settings.mode === "fixed") {
      L.polyline(t.coords.map((c) => [c.lat, c.lon]), {
        color: settings.fixedColor,
        weight: 3.5,
        opacity: 0.9,
      }).bindTooltip(t.name, { sticky: true }).addTo(trackLayer);
      continue;
    }

    for (let i = 1; i < t.coords.length; i++) {
      const a = t.coords[i - 1];
      const b = t.coords[i];
      segs++;
      let v = null;
      if (settings.mode === "speed") {
        v = speedKmh(a, b);
        if (v == null) missingSpeed++;
      } else {
        v = segmentAlt(a, b);
        if (v == null) missingAlt++;
      }
      const color = v == null ? FALLBACK : colorForValue(scale, v, max);
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color,
        weight: 3.5,
        opacity: 0.9,
      }).addTo(trackLayer);
    }
  }

  if (settings.mode === "speed" && missingSpeed && segs) {
    setStatus(`${missingSpeed} Segment(e) ohne Zeitstempel — grau.`);
  } else if (settings.mode === "altitude" && missingAlt && segs) {
    setStatus(`${missingAlt} Segment(e) ohne Höhe — grau.`);
  } else if (tracks.length && !document.querySelector("#status.error")) {
    setStatus(`${tracks.length} Spur(en)`);
  }
}

async function importOverlayFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const newIds = [];
  const warnings = [];
  for (const file of files) {
    let drafts = [];
    let w = [];
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".kmz")) {
        const buf = await file.arrayBuffer();
        ({ drafts, warnings: w } = await parseOverlayBytes(buf, file.name));
      } else {
        const text = await file.text();
        ({ drafts, warnings: w } = await parseOverlayBytes(text, file.name));
      }
    } catch (err) {
      warnings.push(`${file.name}: ${err.message}`);
      continue;
    }
    for (const msg of w || []) warnings.push(`${file.name}: ${msg}`);
    for (const d of drafts) {
      const id = `tr-${++idSeq}`;
      tracks.push({
        id,
        name: d.name,
        sourceName: d.sourceName,
        visible: true,
        coords: d.coords,
      });
      newIds.push(id);
    }
  }
  renderList();
  redraw();
  if (newIds.length) {
    const added = tracks.filter((o) => newIds.includes(o.id));
    const bounds = L.latLngBounds(added.flatMap((o) => o.coords.map((c) => [c.lat, c.lon])));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    setStatus(`${newIds.length} Flugspur(en) geladen`);
  } else {
    setStatus(warnings[0] || "Keine Flugspuren in der Datei.", true);
  }
  if (warnings.length && newIds.length) console.warn("Import:", warnings);
}

el("overlay-add").addEventListener("click", () => el("overlay-file").click());
el("overlay-file").addEventListener("change", async (e) => {
  const input = e.target;
  try {
    await importOverlayFiles(input.files);
  } finally {
    input.value = "";
  }
});

for (const r of document.querySelectorAll('input[name="color-mode"]')) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    settings.mode = r.value;
    persist();
    syncUi();
    redraw();
  });
}

for (const r of document.querySelectorAll('input[name="legend-orient"]')) {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    settings.legendOrient = r.value === "vertical" ? "vertical" : "horizontal";
    persist();
    syncUi();
  });
}

el("cmap-reverse").addEventListener("change", () => {
  settings.cmapReverse = el("cmap-reverse").checked;
  persist();
  syncUi();
  redraw();
});

el("max-speed").addEventListener("change", () => {
  const v = +el("max-speed").value;
  if (Number.isFinite(v) && v > 0) settings.maxSpeed = v;
  persist();
  syncUi();
  redraw();
});
el("max-alt").addEventListener("change", () => {
  const km = +el("max-alt").value;
  if (Number.isFinite(km) && km > 0) settings.maxAlt = Math.round(km * 1000);
  persist();
  syncUi();
  redraw();
});
el("fixed-color").addEventListener("input", () => {
  settings.fixedColor = el("fixed-color").value;
  persist();
  redraw();
});

syncUi();
redraw();
