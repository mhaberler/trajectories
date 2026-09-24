import { parseOverlayBytes } from "@overlays";
import { createCanvasTrack, segmentValue } from "../src/overlays/canvasTrack.js";
import { mountTrackInspect } from "../src/overlays/inspectControl.js";
import { mountColormapSelect, colorStops } from "./colormapSelect.js";
import { isWindy } from "@colormap";
import { mountScalePill, niceTicks } from "./scalePill.js";
import { mountTrackGlobe } from "./view3d.js";
import { canSampleWind, fetchPointWind, modelRowsHtml } from "./hindcast.js";
import { metricsAt } from "../src/overlays/sample.js";

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
let windHtml = "";
let windSeq = 0;

function hudExtra() {
  return windHtml;
}

function applyWind(html) {
  windHtml = html;
  inspect.refresh();
}

function loadWind(trackId, index) {
  const seq = ++windSeq;
  if (trackId == null || index == null) {
    applyWind("");
    return;
  }
  const track = tracks.find((t) => t.id === trackId);
  const c = track?.coords?.[index];
  const flight = metricsAt(track?.coords, index);
  if (!canSampleWind(c)) {
    applyWind(modelRowsHtml(null));
    return;
  }
  applyWind(modelRowsHtml("loading"));
  fetchPointWind(c).then((models) => {
    if (seq !== windSeq) return;
    applyWind(modelRowsHtml(models, flight));
  }).catch((err) => {
    if (seq !== windSeq) return;
    console.warn("Hindcast:", err);
    applyWind(modelRowsHtml(null));
  });
}

const inspect = mountTrackInspect(map, {
  getTracks: () => tracks.filter((t) => t.visible !== false),
  hudExtra,
  hudLayout: "hindcast",
  onPin(trackId, index) {
    loadWind(trackId, index);
    globe?.showAt(trackId, index);
  },
});

/** @type {{ setTracks: (tracks: object[], opts?: { fly?: boolean }) => void, showAt: (trackId: string|null, index: number|null) => void }|null} */
let globe = null;
mountTrackGlobe(document.getElementById("globe"), {
  hudExtra,
  onPin(trackId, index) {
    loadWind(trackId, index);
    inspect.showAt(trackId, index);
  },
}).then((g) => {
  globe = g;
  globe.setTracks(tracks, { colorForSegment: segmentColor });
  map.invalidateSize();
}).catch((err) => {
  const host = document.getElementById("globe");
  host.textContent = err?.message || String(err);
  host.style.color = "#fff";
  host.style.padding = "16px";
  console.error(err);
});
window.addEventListener("resize", () => map.invalidateSize());

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

function colorForValue(scale, v, max, { clamp = true } = {}) {
  if (v == null) return FALLBACK;
  const x = clamp ? clamp01(v, max) : Math.max(0, v);
  return scale(x).hex();
}

/** Same hex the 2D canvas uses for the segment from a to b. */
function segmentColor(a, b) {
  if (settings.mode === "fixed") return settings.fixedColor;
  cmap.setDomain(currentDomain());
  const scale = cmap.scale();
  const max = currentMax();
  const v = settings.mode === "speed" ? segmentValue("speed", a, b) : segmentAlt(a, b);
  return v == null ? FALLBACK : colorForValue(scale, v, max, { clamp: !windySpeedMode() });
}

function windySpeedMode() {
  return settings.mode === "speed" && isWindy(settings.colormap);
}

/** On-map Windy bar: these km/h sit at equal widths; colors come from the full scale. */
const WINDY_LEGEND_TICKS = [0, 10, 20, 35, 55, 70, 100];

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
  el("max-speed-row").hidden = settings.mode !== "speed" || isWindy(settings.colormap);
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
  let gradientCss;
  let payload;
  if (windySpeedMode()) {
    const ticks = WINDY_LEGEND_TICKS;
    const scale = cmap.scale();
    const last = ticks.length - 1;
    const parts = ticks.map((v, i) => `${scale(v).hex()} ${(i / last) * 100}%`);
    const tickFracs = ticks.map((_, i) => i / last);
    gradientCss = `linear-gradient(${dir}, ${parts.join(", ")})`;
    payload = { unit: "km/h", max: ticks[last], ticks, tickFracs, gradientCss, vertical };
  } else {
    const stops = colorStops(settings.colormap, 16);
    if (settings.cmapReverse) stops.reverse();
    gradientCss = `linear-gradient(${dir}, ${stops.join(",")})`;
    payload = { ...scaleDisplay(), gradientCss, vertical };
  }
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
      inspect.refresh();
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
      createCanvasTrack(t.coords, {
        color: settings.fixedColor,
        weight: 3.5,
        opacity: 0.9,
      }).addTo(trackLayer);
      continue;
    }

    const colorForSegment = (i, a, b) => {
      segs++;
      let v = null;
      if (settings.mode === "speed") {
        v = segmentValue("speed", a, b);
        if (v == null) missingSpeed++;
      } else {
        v = segmentAlt(a, b);
        if (v == null) missingAlt++;
      }
      return segmentColor(a, b);
    };
    createCanvasTrack(t.coords, { colorForSegment, weight: 3.5, opacity: 0.9 }).addTo(trackLayer);
  }

  inspect.refresh();
  globe?.setTracks(tracks, { colorForSegment: segmentColor });

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
    globe?.setTracks(tracks, { fly: true });
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

el("panel-toggle").addEventListener("click", () => {
  const panel = el("panel");
  const collapsed = panel.classList.toggle("collapsed");
  const btn = el("panel-toggle");
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.textContent = collapsed ? "Ausklappen" : "Einklappen";
  btn.title = collapsed ? "Eingaben ausklappen" : "Eingaben einklappen";
});

syncUi();
redraw();
