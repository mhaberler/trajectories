import {
  API_BASE, TRAJECTORY_API, MODELS, SERIES_COLORS, DEFAULT_HEIGHTS,
  HEIGHT_MIN, HEIGHT_MAX, MARKER_INTERVALS, METHODS,
} from "./config.js";
import { WindField } from "./windfield.js";
import { computeTrajectory } from "./integrator.js";
import { renderCrossSection } from "./crosssection.js";
import {
  setUnits, unitState, fmtHeight, fmtWind, heightUnit,
  heightToDisplay, heightFromDisplay, heightSliderCfg,
} from "./units.js";
import { initGeocode } from "./geocode.js";
import { expandProfile, targetStepPolyline } from "./profileExpand.js";

// Konsolen-Monitor: ?debug=1 an der URL oder localStorage.trajDebug = "1".
const DEBUG = new URLSearchParams(location.search).has("debug") ||
  localStorage.getItem("trajDebug") === "1";

/* global L */

const el = (id) => document.getElementById(id);

// --- Einstellungen in localStorage ------------------------------------------
const STORAGE_KEY = "trajectories.settings.v1";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

const saved = loadSettings();
setUnits(saved.units || {});
let settingsReady = false; // erst nach vollständiger Wiederherstellung speichern
/** @type {number|null} CSS `right` inset of #view3d (null = fill beside panel) */
let view3dRight = Number.isFinite(saved.view3dRight) ? saved.view3dRight : null;
/** @type {number|null} CSS `bottom` inset of #view3d (null = full height) */
let view3dBottom = Number.isFinite(saved.view3dBottom) ? saved.view3dBottom : null;

function persist() {
  if (!settingsReady) return;
  const s = {
    model: el("model").value,
    refmode: el("refmode").value,
    markerIntervalSec: +el("markerint").value || 600,
    duration: +el("duration").value || 12,
    direction: el("direction").value,
    heights: [...heightColors].map(([m, color]) => ({ m, color })),
    activeHeight,
    barMax,
    start: state.start,
    view: { center: map.getCenter(), zoom: map.getZoom() },
    baseLayer: activeBaseLayer,
    units: { ...unitState },
    liveMode: el("livemode").checked,
    methods: selectedMethods(),
    metExtras: el("metextras").checked,
    useApi: el("useapi").checked,
    flightProfile: el("flightprofile").checked,
    profileTargets: profileTargets.map((w) => ({
      tSec: w.tSec, targetAgl: w.targetAgl, rate: w.rate,
    })),
    profilePreset: el("fp-preset").value,
    ascentRate: clampRate(+el("ascentrate").value),
    descentRate: clampRate(+el("descentrate").value),
    panelWidth: Math.round(el("panel").getBoundingClientRect().width),
    fpSideHeight: Math.round(el("fp-side").getBoundingClientRect().height) || 110,
    view3dRight,
    view3dBottom,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

const map = L.map("map", {
  center: saved.view?.center ? [saved.view.center.lat, saved.view.center.lng] : [50.5, 10.5],
  zoom: saved.view?.zoom ?? 6,
});
map.on("moveend", () => persist());

// Basiskarten: OSM und Esri-Hybrid (Satellitenbild + Beschriftung), wie in
// DZMaster. Die Wahl wird mitgespeichert.
const baseLayers = {
  "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: ["a", "b", "c"],
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
let activeBaseLayer = baseLayers[saved.baseLayer] ? saved.baseLayer : "OpenStreetMap";
baseLayers[activeBaseLayer].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);
map.on("baselayerchange", (e) => {
  activeBaseLayer = e.name;
  persist();
});

const state = {
  start: null,
  meta: null, // {t0, t1} Epochensekunden des verfügbaren Zeitraums
  // Live-Modus: die „gepinnten" (inaktiven) Trajektorien bleiben stehen,
  // während nur die aktive Linie live neu gezeichnet wird. pinLayers wird
  // zuerst zur Karte gefügt, damit die aktive Linie (layers) darüber liegt.
  dimLayers: L.layerGroup().addTo(map), // Geschwister-Tracks im Profil-Edit (stark gedimmt)
  pinLayers: L.layerGroup().addTo(map),
  layers: L.layerGroup().addTo(map),
  pinRuns: new Map(), // Höhe(m) -> berechneter Run, damit Pins beim Scrubben nicht neu rechnen
  pinKey: "",         // Satz der aktuell gezeichneten Pin-Höhen (für „nur bei Änderung neu zeichnen")
  startMarker: null,
  running: false,
  profileEdit: null, // { active, candidateKey, siblingRuns, t0Ms }
  profileRedrawGen: 0,
};

// --- Höhen-Auswahl: Höhenbalken mit anklickbaren Punkten --------------------
// Map Höhe(m) -> Farbe. Eine Höhe behält ihre Farbe, solange sie am Balken
// ist; beim Entfernen wird der Farb-Slot wieder frei. `activeHeight` ist der
// hervorgehobene Punkt — er entscheidet beim Methodenvergleich, an welcher
// Höhe verglichen wird.
const heightColors = new Map();
let activeHeight = null;
const bar = el("heightbar");

// --- Flugprofil (AGL über Zeit, API-only) -----------------------------------
const FP_MAX_ROWS = 12;
const FP_DIM_OPACITY = 0.18;
const FP_PRESETS = {
  // Heights/times from the Gneixendorf sketch; climb/descent rates come from
  // Steigrate / Sinkrate when the preset is applied.
  climbcruise: [
    { tSec: 0, targetAgl: 150 },
    { tSec: 1200, targetAgl: 150 },
    { tSec: 3600, targetAgl: 1800 },
    { tSec: 5400, targetAgl: 1800 },
    { tSec: 7200, targetAgl: 400 },
  ],
  empty: [
    { tSec: 0, targetAgl: 500 },
    { tSec: 3600, targetAgl: 500 },
  ],
};

function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.min(7, Math.max(1, Math.round(n * 2) / 2));
}

/** Aufstieg–Reiseflug–Sinkflug with current Steig-/Sinkrate. */
function climbCruiseTargets() {
  const asc = clampRate(+el("ascentrate").value);
  const desc = clampRate(+el("descentrate").value);
  const base = FP_PRESETS.climbcruise;
  return [
    { tSec: base[0].tSec, targetAgl: base[0].targetAgl, rate: "jump" },
    { tSec: base[1].tSec, targetAgl: base[1].targetAgl, rate: "jump" }, // low hold
    { tSec: base[2].tSec, targetAgl: base[2].targetAgl, rate: asc },    // Steigrate → cruise
    { tSec: base[3].tSec, targetAgl: base[3].targetAgl, rate: "jump" }, // cruise hold
    { tSec: base[4].tSec, targetAgl: base[4].targetAgl, rate: desc },   // Sinkrate → end
  ];
}

function defaultConstantTargets() {
  const h = activeHeight != null ? activeHeight : 500;
  const hours = Math.min(72, Math.max(1, +el("duration").value || 12));
  return [
    { tSec: 0, targetAgl: h, rate: "jump" },
    { tSec: hours * 3600, targetAgl: h, rate: "jump" },
  ];
}

function cloneTargets(list) {
  return list.map((w) => ({
    tSec: w.tSec,
    targetAgl: w.targetAgl ?? w.hAgl,
    rate: w.rate === undefined ? "jump" : w.rate,
  }));
}

/** @type {{ tSec: number, targetAgl: number, rate: 'jump' | number }[]} */
let profileTargets = climbCruiseTargets();

function runKey(run) {
  return `${run.heightM}|${run.method}|${run.label}`;
}

function applyProfilePreset(key) {
  state.profileEdit = null;
  if (key === "constant") profileTargets = defaultConstantTargets();
  else if (key === "empty") profileTargets = cloneTargets(FP_PRESETS.empty);
  else profileTargets = climbCruiseTargets();
  refreshProfileUI({ scheduleApi: false });
  el("fp-candhint").textContent = "";
}

function renderProfileTable() {
  const tbody = el("fp-tbody");
  tbody.replaceChildren();
  const unit = heightUnit();
  for (let i = 0; i < profileTargets.length; i++) {
    const w = profileTargets[i];
    const tr = document.createElement("tr");
    const tdT = document.createElement("td");
    const inpT = document.createElement("input");
    inpT.type = "number";
    inpT.min = "0";
    inpT.step = "1";
    inpT.value = String(Math.round(w.tSec / 60));
    inpT.dataset.i = String(i);
    inpT.dataset.field = "t";
    inpT.setAttribute("aria-label", `Zeit Punkt ${i + 1} in Minuten`);
    tdT.appendChild(inpT);
    const tdH = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "4px";
    const inpH = document.createElement("input");
    inpH.type = "number";
    inpH.min = "0";
    inpH.step = unit === "ft" ? "50" : "10";
    inpH.value = String(Math.round(heightToDisplay(w.targetAgl)));
    inpH.dataset.i = String(i);
    inpH.dataset.field = "h";
    inpH.setAttribute("aria-label", `Höhe Punkt ${i + 1} AGL`);
    const u = document.createElement("span");
    u.className = "hint";
    u.textContent = unit === "ft" ? "ft" : "m";
    wrap.appendChild(inpH);
    wrap.appendChild(u);
    tdH.appendChild(wrap);
    tr.appendChild(tdT);
    tr.appendChild(tdH);
    tbody.appendChild(tr);
  }
  el("fp-add").disabled = profileTargets.length >= FP_MAX_ROWS;
  el("fp-rm").disabled = profileTargets.length <= 2;
}

function readProfileTable() {
  const rows = [...el("fp-tbody").querySelectorAll("tr")];
  const next = [];
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const tInp = tr.querySelector('input[data-field="t"]');
    const hInp = tr.querySelector('input[data-field="h"]');
    const min = Number(tInp?.value);
    const hDisp = Number(hInp?.value);
    if (!Number.isFinite(min) || !Number.isFinite(hDisp)) continue;
    const prevRate = profileTargets[i]?.rate ?? "jump";
    next.push({
      tSec: Math.max(0, Math.round(min * 60)),
      targetAgl: Math.max(0, Math.round(heightFromDisplay(hDisp))),
      rate: prevRate,
    });
  }
  if (next.length >= 2) profileTargets = next;
}

function validateProfileTargets(list) {
  if (!list || list.length < 2) return "Mindestens zwei Wegpunkte nötig.";
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (!Number.isFinite(w.tSec) || !Number.isFinite(w.targetAgl) || w.targetAgl < 0) {
      return `Ungültiger Wegpunkt ${i + 1}.`;
    }
    if (i > 0 && w.tSec <= list[i - 1].tSec) {
      return "Zeiten müssen streng steigend sein.";
    }
  }
  return null;
}

function updateProfileHint() {
  const hint = el("fp-hint");
  const err = validateProfileTargets(profileTargets);
  if (err) {
    hint.textContent = err;
    hint.classList.add("error");
    return;
  }
  let expanded;
  try {
    expanded = expandProfile(profileTargets);
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add("error");
    return;
  }
  const lastH = profileTargets[profileTargets.length - 1].tSec / 3600;
  hint.textContent =
    `${profileTargets.length} Ziele · ${expanded.length} API-Punkte · bis ${lastH.toFixed(lastH < 10 ? 1 : 0)} h`;
  hint.classList.remove("error");
}

/** @type {{ tMax: number, hMin: number, hMax: number, pad: object, iw: number, ih: number, W: number, H: number, terrain: { tSec: number, z: number }[], useAmsl: boolean } | null} */
let sideViewGeom = null;
/** @type {{ i: number, pointerId: number, moved: boolean } | null} */
let sideDrag = null;

const FP_SIDE_H_MIN = 80;
const FP_SIDE_H_DEFAULT = 110;

function fpSideHeightMax() {
  // Leave room for the rest of the panel; grow with the viewport.
  return Math.min(520, Math.max(FP_SIDE_H_MIN, Math.round(window.innerHeight * 0.45)));
}

function profileCandidateRun() {
  const runs = state.lastRuns?.runs;
  if (!runs?.length) return null;
  const key = state.profileEdit?.candidateKey;
  if (key) {
    const hit = runs.find((r) => runKey(r) === key);
    if (hit) return hit;
  }
  return runs.find((r) => Array.isArray(r.terrain) && r.terrain.some((g) => Number.isFinite(g)))
    || runs[0];
}

function terrainSeriesFromRun(run) {
  if (!run?.r?.points?.length) return [];
  const t0 = run.r.points[0].tMs;
  const out = [];
  for (let i = 0; i < run.r.points.length; i++) {
    const g = run.terrain?.[i];
    if (!Number.isFinite(g)) continue;
    out.push({ tSec: (run.r.points[i].tMs - t0) / 1000, z: +g });
  }
  return out;
}

function terrainAt(series, tSec) {
  if (!series.length) return null;
  if (tSec <= series[0].tSec) return series[0].z;
  const last = series[series.length - 1];
  if (tSec >= last.tSec) return last.z;
  for (let i = 1; i < series.length; i++) {
    if (tSec <= series[i].tSec) {
      const a = series[i - 1];
      const b = series[i];
      const u = (tSec - a.tSec) / Math.max(1e-9, b.tSec - a.tSec);
      return a.z + u * (b.z - a.z);
    }
  }
  return last.z;
}

function niceTicks(min, max, count = 4) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  const t0 = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = t0; v <= max + step * 1e-9; v += step) ticks.push(v);
  if (!ticks.length) ticks.push(min, max);
  return ticks;
}

function setFpSideHeight(px, { save = false } = {}) {
  const h = Math.round(Math.min(fpSideHeightMax(), Math.max(FP_SIDE_H_MIN, px)));
  el("fp-side").style.height = `${h}px`;
  el("fp-side-resize")?.setAttribute("aria-valuenow", String(h));
  el("fp-side-resize")?.setAttribute("aria-valuemax", String(fpSideHeightMax()));
  if (save) persist();
  return h;
}

function sideViewClientToTSec(clientX) {
  const svg = el("fp-side")?.querySelector("svg");
  const g = sideViewGeom;
  if (!svg || !g || g.iw < 1) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width < 1) return null;
  const xVb = ((clientX - rect.left) / rect.width) * g.W;
  const t = ((xVb - g.pad.l) / g.iw) * g.tMax;
  return Math.max(0, Math.min(g.tMax, t));
}

function sideViewClientToAgl(clientY, tSecForTerrain = null) {
  const host = el("fp-side");
  const svg = host?.querySelector("svg");
  const g = sideViewGeom;
  if (!svg || !g) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.height < 1) return null;
  const yVb = ((clientY - rect.top) / rect.height) * g.H;
  const z = g.hMin + ((g.pad.t + g.ih - yVb) / g.ih) * (g.hMax - g.hMin);
  let agl = z;
  if (g.useAmsl) {
    const t = tSecForTerrain ?? (sideDrag != null ? profileTargets[sideDrag.i]?.tSec : null);
    if (t != null) {
      const ground = terrainAt(g.terrain, t);
      agl = z - (ground ?? 0);
    }
  }
  const cfg = heightSliderCfg();
  const disp = Math.round(heightToDisplay(agl) / cfg.step) * cfg.step;
  const m = heightFromDisplay(Math.min(Math.max(disp, 0), heightToDisplay(barMax)));
  return Math.round(Math.min(barMax, Math.max(0, m)));
}

function renderProfileSideView() {
  const host = el("fp-side");
  if (!host || el("flightprofile-panel").hidden) return;
  const err = validateProfileTargets(profileTargets);
  if (err) {
    host.replaceChildren();
    sideViewGeom = null;
    return;
  }
  let expanded;
  try {
    expanded = expandProfile(profileTargets);
  } catch {
    host.replaceChildren();
    sideViewGeom = null;
    return;
  }

  const run = profileCandidateRun();
  const terrain = terrainSeriesFromRun(run);
  const useAmsl = terrain.length >= 2;
  const tMax = Math.max(...profileTargets.map((w) => w.tSec), 1);

  const toZ = (tSec, hAgl) => {
    if (!useAmsl) return hAgl;
    const g = terrainAt(terrain, tSec);
    return (g ?? 0) + hAgl;
  };

  const stepsAgl = targetStepPolyline(profileTargets);
  const steps = stepsAgl.map((p) => ({ tSec: p.tSec, z: toZ(p.tSec, p.hAgl) }));
  const ramp = expanded.map((p) => ({ tSec: p.tSec, z: toZ(p.tSec, p.hAgl) }));
  const handles = profileTargets.map((w) => ({ tSec: w.tSec, z: toZ(w.tSec, w.targetAgl) }));

  let hMin = useAmsl ? Math.min(...terrain.map((p) => p.z)) : 0;
  let hMax = Math.max(
    ...handles.map((p) => p.z),
    ...ramp.map((p) => p.z),
    useAmsl ? hMin + 100 : Math.max(barMax, ...profileTargets.map((w) => w.targetAgl), 100),
  );
  if (useAmsl) {
    hMin = Math.max(0, hMin - 50);
    hMax += 80;
  }
  if (hMax <= hMin) hMax = hMin + 100;

  const rect = host.getBoundingClientRect();
  const W = Math.max(160, Math.round(rect.width) || 320);
  const H = Math.max(FP_SIDE_H_MIN, Math.round(rect.height) || FP_SIDE_H_DEFAULT);
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  sideViewGeom = { tMax, hMin, hMax, pad, iw, ih, W, H, terrain, useAmsl };

  const x = (t) => pad.l + (t / tMax) * iw;
  const y = (z) => pad.t + ih - ((z - hMin) / (hMax - hMin)) * ih;
  const poly = (pts, stroke, width) => {
    if (pts.length < 2) return "";
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.tSec).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" pointer-events="none"/>`;
  };

  let terrainSvg = "";
  if (useAmsl) {
    const top = terrain.map((p, i) =>
      `${i ? "L" : "M"}${x(p.tSec).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
    const close =
      `L${x(terrain[terrain.length - 1].tSec).toFixed(1)},${(pad.t + ih).toFixed(1)} ` +
      `L${x(terrain[0].tSec).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
    terrainSvg =
      `<path d="${top} ${close}" fill="#d8d2c4" fill-opacity="0.7" stroke="none" pointer-events="none"/>` +
      poly(terrain.map((p) => ({ tSec: p.tSec, z: p.z })), "#a89f8a", 1.25);
  } else {
    terrainSvg =
      `<line x1="${pad.l}" y1="${y(0).toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" ` +
      `y2="${y(0).toFixed(1)}" stroke="#a89f8a" stroke-width="1" pointer-events="none"/>`;
  }

  const tTicks = niceTicks(0, tMax / 60, 4); // minutes
  const zTicks = niceTicks(hMin, hMax, 4);
  const yUnit = useAmsl
    ? (heightUnit() === "ft" ? "ft NN" : "m NN")
    : (heightUnit() === "ft" ? "ft AGL" : "m AGL");
  let axes = "";
  axes += `<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + ih}" stroke="#9c9b95" pointer-events="none"/>`;
  axes += `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${pad.l + iw}" y2="${pad.t + ih}" stroke="#9c9b95" pointer-events="none"/>`;
  for (const m of tTicks) {
    const tx = x(m * 60);
    if (tx < pad.l - 0.5 || tx > pad.l + iw + 0.5) continue;
    axes += `<line x1="${tx.toFixed(1)}" y1="${(pad.t + ih).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(pad.t + ih + 4).toFixed(1)}" stroke="#9c9b95" pointer-events="none"/>`;
    axes += `<text x="${tx.toFixed(1)}" y="${(H - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#52514e" pointer-events="none">${Math.round(m)}</text>`;
  }
  axes += `<text x="${(pad.l + iw).toFixed(1)}" y="${(H - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#7a7970" pointer-events="none">min</text>`;
  for (const z of zTicks) {
    const ty = y(z);
    if (ty < pad.t - 0.5 || ty > pad.t + ih + 0.5) continue;
    axes += `<line x1="${(pad.l - 4).toFixed(1)}" y1="${ty.toFixed(1)}" x2="${pad.l}" y2="${ty.toFixed(1)}" stroke="#9c9b95" pointer-events="none"/>`;
    axes += `<text x="${(pad.l - 6).toFixed(1)}" y="${(ty + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#52514e" pointer-events="none">${Math.round(heightToDisplay(z))}</text>`;
  }
  axes += `<text x="4" y="${(pad.t + 8).toFixed(1)}" text-anchor="start" font-size="9" fill="#7a7970" pointer-events="none">${yUnit}</text>`;

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    terrainSvg +
    poly(steps, "#9c9b95", 1.5) +
    poly(ramp, "#1c5cab", 2) +
    axes +
    handles.map((p, i) =>
      `<circle class="fp-side-pt" data-i="${i}" cx="${x(p.tSec).toFixed(1)}" ` +
      `cy="${y(p.z).toFixed(1)}" r="6" fill="#1c5cab"/>`
    ).join("") +
    `</svg>`;
}

function wireProfileSideView() {
  const host = el("fp-side");
  if (!host || host.dataset.wired) return;
  host.dataset.wired = "1";

  const initialH = Number.isFinite(saved.fpSideHeight) ? saved.fpSideHeight : FP_SIDE_H_DEFAULT;
  setFpSideHeight(initialH);
  el("fp-side-resize")?.setAttribute("aria-valuemin", String(FP_SIDE_H_MIN));
  el("fp-side-resize")?.setAttribute("aria-valuemax", String(fpSideHeightMax()));

  if (typeof ResizeObserver !== "undefined") {
    let roT = 0;
    const ro = new ResizeObserver(() => {
      if (el("flightprofile-panel").hidden) return;
      clearTimeout(roT);
      roT = setTimeout(() => renderProfileSideView(), 40);
    });
    ro.observe(host);
  }

  host.addEventListener("pointerdown", (e) => {
    const pt = e.target.closest?.(".fp-side-pt");
    if (!pt || el("flightprofile-panel").hidden) return;
    const i = +pt.dataset.i;
    if (!Number.isFinite(i) || i < 0 || i >= profileTargets.length) return;
    e.preventDefault();
    if (e.altKey) {
      if (profileModalIndex === i) closeProfileModal();
      removeProfileTarget(i);
      return;
    }
    host.setPointerCapture(e.pointerId);
    host.classList.add("dragging");
    sideDrag = { i, pointerId: e.pointerId, moved: false };
  });

  host.addEventListener("dblclick", (e) => {
    if (el("flightprofile-panel").hidden) return;
    if (e.target.closest?.(".fp-side-pt")) return;
    e.preventDefault();
    const tSec = sideViewClientToTSec(e.clientX);
    if (tSec == null) return;
    const hClick = sideViewClientToAgl(e.clientY, tSec);
    const h = hClick != null ? hClick : Math.round(profileHeightAt(tSec));
    insertProfileTarget(tSec, h);
  });

  host.addEventListener("pointermove", (e) => {
    if (!sideDrag || e.pointerId !== sideDrag.pointerId) return;
    const h = sideViewClientToAgl(e.clientY);
    if (h == null) return;
    if (h === profileTargets[sideDrag.i].targetAgl && !sideDrag.moved) return;
    sideDrag.moved = true;
    profileTargets[sideDrag.i] = {
      ...profileTargets[sideDrag.i],
      targetAgl: h,
    };
    renderProfileSideView();
    updateProfileHint();
    const inp = el("fp-tbody").querySelector(
      `tr:nth-child(${sideDrag.i + 1}) input[data-field="h"]`,
    );
    if (inp) inp.value = String(Math.round(heightToDisplay(h)));
    if (profileModalIndex === sideDrag.i) {
      el("fp-modal-h").value = String(Math.round(heightToDisplay(h)));
      el("fp-modal-hlabel").textContent = fmtHeight(h);
    }
  });

  const endDrag = (e) => {
    if (!sideDrag || e.pointerId !== sideDrag.pointerId) return;
    const { i, moved } = sideDrag;
    sideDrag = null;
    host.classList.remove("dragging");
    try { host.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!moved) {
      openProfileModal(i);
      return;
    }
    persist();
    refreshProfileUI({ scheduleApi: true });
  };
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);

  const grip = el("fp-side-resize");
  if (grip && !grip.dataset.wired) {
    grip.dataset.wired = "1";
    let vdrag = null;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add("fp-side-resizing");
      vdrag = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startH: host.getBoundingClientRect().height,
      };
    });
    grip.addEventListener("pointermove", (e) => {
      if (!vdrag || e.pointerId !== vdrag.pointerId) return;
      setFpSideHeight(vdrag.startH + (e.clientY - vdrag.startY));
      renderProfileSideView();
    });
    const endV = (e) => {
      if (!vdrag || e.pointerId !== vdrag.pointerId) return;
      vdrag = null;
      document.body.classList.remove("fp-side-resizing");
      try { grip.releasePointerCapture(e.pointerId); } catch { /* */ }
      persist();
      renderProfileSideView();
    };
    grip.addEventListener("pointerup", endV);
    grip.addEventListener("pointercancel", endV);
    grip.addEventListener("keydown", (e) => {
      const cur = host.getBoundingClientRect().height;
      const step = e.shiftKey ? 24 : 12;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFpSideHeight(cur - step, { save: true });
        renderProfileSideView();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFpSideHeight(cur + step, { save: true });
        renderProfileSideView();
      }
    });
  }
}

function refreshProfileUI({ scheduleApi = true } = {}) {
  renderProfileTable();
  updateProfileHint();
  renderProfileSideView();
  if (scheduleApi && el("flightprofile").checked) scheduleProfileRedraw();
}

/** Interpolate target AGL at tSec from the expanded (or raw) profile. */
function profileHeightAt(tSec) {
  const sorted = [...profileTargets].sort((a, b) => a.tSec - b.tSec);
  if (sorted.length < 2) return sorted[0]?.targetAgl ?? 0;
  if (tSec <= sorted[0].tSec) return sorted[0].targetAgl;
  if (tSec >= sorted[sorted.length - 1].tSec) return sorted[sorted.length - 1].targetAgl;
  try {
    const exp = expandProfile(sorted);
    for (let i = 1; i < exp.length; i++) {
      if (tSec <= exp[i].tSec) {
        const a = exp[i - 1];
        const b = exp[i];
        const u = (tSec - a.tSec) / Math.max(1e-9, b.tSec - a.tSec);
        return a.hAgl + u * (b.hAgl - a.hAgl);
      }
    }
  } catch { /* fall through */ }
  for (let i = 1; i < sorted.length; i++) {
    if (tSec <= sorted[i].tSec) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const u = (tSec - a.tSec) / Math.max(1e-9, b.tSec - a.tSec);
      return a.targetAgl + u * (b.targetAgl - a.targetAgl);
    }
  }
  return sorted[sorted.length - 1].targetAgl;
}

function pointAtTimeOnPath(r, tSec) {
  const pts = r.points;
  if (!pts?.length) return null;
  const t0 = pts[0].tMs;
  const tMs = t0 + tSec * 1000;
  if (tMs <= pts[0].tMs) return { lat: pts[0].lat, lon: pts[0].lon, z: pts[0].z };
  const last = pts[pts.length - 1];
  if (tMs >= last.tMs) return { lat: last.lat, lon: last.lon, z: last.z };
  for (let i = 1; i < pts.length; i++) {
    if (tMs <= pts[i].tMs) {
      const a = pts[i - 1];
      const b = pts[i];
      const u = (tMs - a.tMs) / Math.max(1, b.tMs - a.tMs);
      return {
        lat: a.lat + u * (b.lat - a.lat),
        lon: a.lon + u * (b.lon - a.lon),
        z: Number.isFinite(a.z) && Number.isFinite(b.z) ? a.z + u * (b.z - a.z) : a.z,
      };
    }
  }
  return { lat: last.lat, lon: last.lon, z: last.z };
}

function timeAlongPath(r, lat, lon) {
  const pts = r.points;
  if (!pts?.length) return 0;
  const t0 = pts[0].tMs;
  let bestD = Infinity;
  let bestT = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = (p.tMs - t0) / 1000;
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b.lon - a.lon;
    const aby = b.lat - a.lat;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-18) continue;
    let u = ((lon - a.lon) * abx + (lat - a.lat) * aby) / len2;
    u = Math.min(1, Math.max(0, u));
    const plat = a.lat + u * aby;
    const plon = a.lon + u * abx;
    const d = (plat - lat) ** 2 + (plon - lon) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = ((a.tMs + u * (b.tMs - a.tMs)) - t0) / 1000;
    }
  }
  return bestT;
}

function afterProfileTargetsMutated() {
  persist();
  refreshProfileUI({ scheduleApi: true });
  if (state.profileEdit?.active) {
    const run = profileCandidateRun();
    if (run) paintProfileEditMap(run);
  }
}

function insertProfileTarget(tSec, hAgl) {
  if (profileTargets.length >= FP_MAX_ROWS) {
    setStatus(`Maximal ${FP_MAX_ROWS} Profilpunkte.`, true);
    return false;
  }
  let t = Math.max(0, Math.round(tSec));
  const h = Math.max(0, Math.round(hAgl));
  const sorted = [...profileTargets].sort((a, b) => a.tSec - b.tSec);
  const tMin = sorted[0].tSec;
  const tMax = sorted[sorted.length - 1].tSec;
  if (t <= tMin) t = tMin + 1;
  if (t >= tMax) t = tMax - 1;
  if (t <= tMin || t >= tMax) {
    setStatus("Punkt muss zwischen Start und Ende liegen.", true);
    return false;
  }
  // Nudge off collisions
  const used = new Set(sorted.map((w) => w.tSec));
  while (used.has(t) && t < tMax - 1) t += 1;
  if (used.has(t)) {
    setStatus("Kein freier Zeit-Slot für neuen Punkt.", true);
    return false;
  }
  profileTargets.push({ tSec: t, targetAgl: h, rate: "jump" });
  profileTargets.sort((a, b) => a.tSec - b.tSec);
  afterProfileTargetsMutated();
  setStatus(`Profilpunkt bei ${Math.round(t / 60)} min · ${fmtHeight(h)} AGL`);
  return true;
}

function removeProfileTarget(index) {
  if (profileTargets.length <= 2) {
    setStatus("Mindestens zwei Wegpunkte nötig.", true);
    return false;
  }
  if (index < 0 || index >= profileTargets.length) return false;
  if (profileModalIndex != null) closeProfileModal();
  profileTargets.splice(index, 1);
  afterProfileTargetsMutated();
  setStatus("Profilpunkt gelöscht.");
  return true;
}

function setProfileMapDblClickZoom(enabled) {
  if (!map.doubleClickZoom) return;
  if (enabled) map.doubleClickZoom.enable();
  else map.doubleClickZoom.disable();
}

function applyProfileUI() {
  const on = el("flightprofile").checked;
  el("flightprofile-panel").hidden = !on;
  el("heights-block").classList.toggle("off", on);
  el("methodrow").classList.toggle("off", on);
  el("livemode").disabled = on;
  el("refmode").disabled = on;
  if (on) {
    el("livemode").checked = false;
    el("refmode").value = "agl";
    el("useapi").checked = true;
    for (const c of el("methodlist").querySelectorAll("input")) {
      c.checked = c.value === "height";
    }
    refreshProfileUI({ scheduleApi: false });
  } else {
    state.profileEdit = null;
    el("fp-candhint").textContent = "";
    closeProfileModal();
    state.dimLayers.clearLayers();
    restoreStartMarkerVisibility();
  }
  setProfileMapDblClickZoom(!state.profileEdit?.active);
  applyModeUI();
}

function defaultRateForDelta(dh) {
  return dh >= 0 ? clampRate(+el("ascentrate").value) : clampRate(+el("descentrate").value);
}

function enterProfileFromCandidate(run) {
  if (!state.lastRuns?.runs?.length) return;
  if (state.lastRuns.mode !== "agl") {
    return setStatus("Flugprofil: nur AGL-Läufe wählbar.", true);
  }
  if (run.method !== "height") {
    return setStatus("Flugprofil: nur Methode „Höhe AGL“.", true);
  }
  if (!el("useapi").checked) el("useapi").checked = true;
  el("flightprofile").checked = true;

  const pts = run.r.points;
  const t0 = pts[0].tMs;
  const end = pts.at(-1).tMs;
  const times = new Set([0, Math.max(1, Math.round((end - t0) / 1000))]);
  for (const m of run.r.markers) {
    times.add(Math.max(0, Math.round((m.tMs - t0) / 1000)));
  }
  const sorted = [...times].sort((a, b) => a - b);
  const uniq = sorted.filter((t, i) => i === 0 || t > sorted[i - 1]);
  if (uniq.length < 2) uniq.push(uniq[0] + 3600);
  profileTargets = uniq.map((t) => ({
    tSec: t,
    targetAgl: run.heightM,
    rate: "jump",
  }));

  const key = runKey(run);
  state.profileEdit = {
    active: true,
    candidateKey: key,
    siblingRuns: state.lastRuns.runs.filter((r) => runKey(r) !== key),
    t0Ms: state.lastRuns.t0Ms,
  };
  el("fp-preset").value = "empty";
  applyProfileUI();
  el("fp-candhint").textContent =
    `Kandidat: ${run.label} — Klick: ändern · Doppelklick: Punkt · Alt+Klick: löschen`;
  paintProfileEditMap(run);
  highlightResultCandidate(key);
  refreshProfileUI({ scheduleApi: true });
  setStatus(`Flugprofil: ${run.label}`);
}

function tryPickCandidate(run) {
  enterProfileFromCandidate(run);
}

function highlightResultCandidate(key) {
  for (const line of el("results").querySelectorAll(".result-line")) {
    line.classList.toggle("candidate", line.dataset.runKey === key);
  }
}

function paintProfileEditMap(candidateRun) {
  setProfileMapDblClickZoom(false);
  state.layers.clearLayers();
  state.dimLayers.clearLayers();
  state.pinLayers.clearLayers();
  // Pin sits above circleMarkers and hid the t=0 edit target — hide while editing.
  if (state.startMarker) state.startMarker.setOpacity(0);
  const siblings = state.profileEdit?.siblingRuns || [];
  for (const run of siblings) {
    drawCasing(run.r, state.dimLayers);
    drawTrajectory(run.r, run.color, run.label, run.dash, state.dimLayers, {
      opacity: FP_DIM_OPACITY,
      interactive: false,
    });
  }
  if (candidateRun) {
    drawCasing(candidateRun.r, state.layers);
    drawTrajectory(candidateRun.r, candidateRun.color, candidateRun.label, candidateRun.dash, state.layers, {
      editableMarkers: true,
      onSelect: () => tryPickCandidate(candidateRun),
    });
  }
}

function restoreStartMarkerVisibility() {
  if (state.startMarker) state.startMarker.setOpacity(1);
}

let profileModalIndex = null;

function fillProfileModalMet(m, dir) {
  const box = el("fp-modal-met");
  if (!m?.met) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  const lines = [
    Number.isFinite(m.z) ? `Höhe: ${fmtHeight(m.z)} NN` : null,
    !m.synthetic && Number.isFinite(m.u) && Number.isFinite(m.v)
      ? `Wind: ${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°`
      : null,
    Number.isFinite(m.met.t) ? `T: ${m.met.t.toFixed(1)} °C` : null,
    Number.isFinite(m.met.td) ? `Td: ${m.met.td.toFixed(1)} °C` : null,
    Number.isFinite(m.met.rh) ? `RH: ${Math.round(m.met.rh)} %` : null,
    Number.isFinite(m.met.p) ? `p: ${m.met.p.toFixed(0)} hPa` : null,
    `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E`,
  ].filter(Boolean);
  box.textContent = lines.join("\n");
  box.hidden = lines.length === 0;
}

function openProfileModal(index, markerCtx = null) {
  if (index < 0 || index >= profileTargets.length) return;
  profileModalIndex = index;
  const w = profileTargets[index];
  const cfg = heightSliderCfg();
  const slider = el("fp-modal-h");
  slider.min = String(cfg.min);
  slider.max = String(Math.round(heightToDisplay(barMax)));
  slider.step = String(cfg.step);
  slider.value = String(Math.round(heightToDisplay(w.targetAgl)));
  el("fp-modal-hlabel").textContent = fmtHeight(w.targetAgl);
  const rate = w.rate;
  let modeVal = "jump";
  if (rate !== "jump" && rate != null) {
    const asc = clampRate(+el("ascentrate").value);
    const desc = clampRate(+el("descentrate").value);
    modeVal = (rate === asc || rate === desc) ? "default" : "custom";
    el("fp-modal-rate").value = String(rate);
  }
  for (const r of el("fp-modal").querySelectorAll('input[name="fp-mode"]')) {
    r.checked = r.value === modeVal;
  }
  el("fp-modal-rate-row").hidden = modeVal !== "custom";
  el("fp-modal-title").textContent = `Marke · ${Math.round(w.tSec / 60)} min`;
  updateModalNote();
  const dir = markerCtx
    ? (Math.atan2(-(markerCtx.u || 0), -(markerCtx.v || 0)) * 180 / Math.PI + 360) % 360
    : 0;
  fillProfileModalMet(markerCtx, dir);
  const delBtn = el("fp-modal-del");
  if (delBtn) {
    const canDel = profileTargets.length > 2;
    delBtn.hidden = !canDel;
    delBtn.disabled = !canDel;
  }
  el("fp-modal").hidden = false;
}

function closeProfileModal() {
  el("fp-modal").hidden = true;
  profileModalIndex = null;
  el("fp-modal-met").hidden = true;
  el("fp-modal-met").textContent = "";
}

function updateModalNote() {
  if (profileModalIndex == null || profileModalIndex === 0) {
    el("fp-modal-note").textContent = profileModalIndex === 0
      ? "Startpunkt: Höhe ohne Rampe davor."
      : "";
    return;
  }
  const w = profileTargets[profileModalIndex];
  const prev = profileTargets[profileModalIndex - 1];
  const h = +heightFromDisplay(+el("fp-modal-h").value);
  const dh = h - prev.targetAgl;
  const mode = el("fp-modal").querySelector('input[name="fp-mode"]:checked')?.value;
  if (mode === "jump" || Math.abs(dh) < 1) {
    el("fp-modal-note").textContent = "Sprung: steile Linie über das ganze Intervall.";
    return;
  }
  const r = mode === "custom"
    ? clampRate(+el("fp-modal-rate").value)
    : defaultRateForDelta(dh);
  const need = Math.abs(dh) / r;
  const gap = w.tSec - prev.tSec;
  if (need > gap) {
    el("fp-modal-note").textContent =
      `Gap ${(gap).toFixed(0)} s zu kurz für ${r} m/s → Rate wird geclampt.`;
  } else {
    el("fp-modal-note").textContent =
      `Rampe ${(need).toFixed(0)} s · Start bei t=${Math.round((w.tSec - need) / 60)} min`;
  }
}

function applyModalToTarget() {
  if (profileModalIndex == null) return;
  const h = Math.max(0, Math.round(heightFromDisplay(+el("fp-modal-h").value)));
  const mode = el("fp-modal").querySelector('input[name="fp-mode"]:checked')?.value || "jump";
  const prevH = profileModalIndex > 0
    ? profileTargets[profileModalIndex - 1].targetAgl
    : h;
  let rate = "jump";
  if (mode === "default") rate = defaultRateForDelta(h - prevH);
  else if (mode === "custom") rate = clampRate(+el("fp-modal-rate").value);
  profileTargets[profileModalIndex] = {
    ...profileTargets[profileModalIndex],
    targetAgl: h,
    rate: profileModalIndex === 0 ? "jump" : rate,
  };
  el("fp-modal-hlabel").textContent = fmtHeight(h);
  updateModalNote();
  refreshProfileUI({ scheduleApi: true });
}

const scheduleProfileRedraw = debounce(() => {
  if (!el("flightprofile").checked || !state.start) return;
  const err = validateProfileTargets(profileTargets);
  if (err) return;
  runProfileRedraw();
}, 500);

async function runProfileRedraw() {
  if (!state.start || !state.meta) return;
  const modelKey = el("model").value;
  const model = MODELS[modelKey];
  const { lat, lon } = state.start;
  const b = model.bbox;
  if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) return;
  let expanded;
  try {
    expanded = expandProfile(profileTargets);
  } catch {
    return;
  }
  const direction = +el("direction").value;
  const duration = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = state.profileEdit?.t0Ms ?? (+el("timeslider").value * 3600e3);
  const markerIntervalSec = +el("markerint").value;
  const gen = ++state.profileRedrawGen;
  await runTrajectoriesViaApi({
    modelKey, model, lat, lon, methods: ["height"], compareMode: false,
    activeHeights: [profileTargets[0].targetAgl],
    markerIntervalSec, mode: "agl", direction, duration, t0Ms,
    heightProfile: expanded,
    profileRedraw: true,
    profileGen: gen,
  });
}

// Oberes Ende der Höhenbalken-Skala, in den Einstellungen wählbar (Default
// 6 km). HEIGHT_MAX bleibt die absolute Obergrenze für diese Auswahl.
const BAR_MAX_OPTIONS = [3000, 4000, 5000, 6000, 8000, 10000];
let barMax = BAR_MAX_OPTIONS.includes(saved.barMax) ? saved.barMax : 6000;

function addHeight(m) {
  m = Math.round(Math.min(barMax, Math.max(HEIGHT_MIN, m)));
  if (heightColors.has(m)) { activeHeight = m; renderBar(); return true; }
  if (heightColors.size >= SERIES_COLORS.length) {
    setStatus(`Maximal ${SERIES_COLORS.length} Höhen gleichzeitig.`, true);
    return false;
  }
  const used = new Set(heightColors.values());
  heightColors.set(m, SERIES_COLORS.find((c) => !used.has(c)));
  activeHeight = m;
  renderBar();
  persist();
  return true;
}

function removeHeight(m) {
  heightColors.delete(m);
  if (activeHeight === m) {
    const keys = [...heightColors.keys()].sort((a, b) => a - b);
    activeHeight = keys.length ? keys[0] : null;
  }
  renderBar();
  persist();
}

// --- Höhenbalken: Skala, Umrechnung Pixel<->Höhe, Rendern -------------------
// Der Balken bildet 0…barMax mit einer Wurzel-Skala ab (Grund unten, hohe
// Werte oben): der häufig genutzte untere Bereich wird gespreizt, oben wird
// gestaucht. Die beschrifteten Ticks machen die Abstände transparent.
function metersToFrac(m) {
  return Math.sqrt(Math.min(1, Math.max(0, m / barMax)));
}

// Oben und unten einen Rand freilassen, damit die Endbeschriftungen („Grund",
// „10 km") nicht vom overflow:hidden des Lineals angeschnitten werden. Die
// nutzbare Skala liegt so zwischen BAR_PAD und (1 − BAR_PAD) der Balkenhöhe.
const BAR_PAD = 0.05;
function posPct(m) {
  return (BAR_PAD + metersToFrac(m) * (1 - 2 * BAR_PAD)) * 100;
}

// Rastert eine Höhe auf die Schrittweite der aktuellen Einheit und begrenzt
// sie auf den zulässigen Bereich.
function snapMeters(m) {
  const cfg = heightSliderCfg();
  const disp = Math.round(heightToDisplay(m) / cfg.step) * cfg.step;
  const mm = heightFromDisplay(Math.min(Math.max(disp, cfg.min), cfg.inputMax));
  return Math.round(Math.min(barMax, Math.max(HEIGHT_MIN, mm)));
}

function yToMeters(clientY) {
  const r = bar.getBoundingClientRect();
  const raw = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
  // Rand herausrechnen, dann Wurzel-Skala umkehren.
  const frac = Math.min(1, Math.max(0, (raw - BAR_PAD) / (1 - 2 * BAR_PAD)));
  return snapMeters(frac * frac * barMax);
}

// Gitterlinien passend zu barMax: „Grund" und Maximum immer, dazwischen runde
// Werte mit ~5 Linien Zielabstand. Werte in der Anzeige-Einheit.
function niceStep(maxDisp) {
  const steps = unitState.height === "ft" ? [1000, 2500, 5000, 10000] : [500, 1000, 2000, 2500, 5000];
  const raw = maxDisp / 5;
  return steps.find((s) => raw <= s) ?? steps[steps.length - 1];
}

function tickValues() {
  const maxDisp = Math.round(heightToDisplay(barMax));
  const step = niceStep(maxDisp);
  const ticks = [];
  for (let v = 0; v < maxDisp - step * 0.35; v += step) ticks.push(v);
  ticks.push(maxDisp);
  return ticks;
}

function tickLabel(v) {
  // Der Skalen-Nullpunkt ist bei AGL der Boden, bei AMSL der Meeresspiegel.
  if (v === 0) return el("refmode").value === "amsl" ? "NN" : "Grund";
  const k = Math.round(v / 100) / 10; // Tausender mit einer Nachkommastelle
  return unitState.height === "ft" ? `${k}k ft` : `${k} km`;
}

function renderBar() {
  const live = el("livemode").checked;
  const compare = selectedMethods().length > 1;
  const cfg = heightSliderCfg();
  const editMax = Math.min(cfg.inputMax, Math.round(heightToDisplay(barMax)));
  const mode = el("refmode").value;
  const elev = state.startElevation;
  let html = "";

  // Modellgelände (nur bei NN-Bezug sinnvoll): schraffierte Fläche vom
  // Meeresspiegel bis zur Geländehöhe, deren Oberkante als „Grund" markiert.
  if (mode === "amsl" && elev != null) {
    const bottom = posPct(0);
    const top = posPct(elev);
    html += `<div class="bar-terrain" style="bottom:${bottom}%;height:${top - bottom}%"></div>` +
      `<div class="bar-groundline" style="bottom:${top}%"></div>` +
      `<div class="bar-ticklabel bar-groundlabel" style="bottom:${top}%">Grund</div>`;
  }

  for (const v of tickValues()) {
    const pos = posPct(heightFromDisplay(v));
    html += `<div class="bar-tick" style="bottom:${pos}%"></div>` +
      `<div class="bar-ticklabel" style="bottom:${pos}%">${tickLabel(v)}</div>`;
  }

  // Im Lineal nur die farbigen Striche (Klick-/Ziehziel), die Beschriftung
  // steht in einer eigenen Spalte rechts daneben. Der aktive Punkt trägt dort
  // ein Editierfeld für den genauen Wert.
  const entries = [...heightColors.entries()].sort((a, b) => a[0] - b[0]);
  let labelHtml = "";
  for (const [m, color] of entries) {
    const pos = posPct(m);
    const isActive = m === activeHeight;
    const dim = compare && !isActive;
    const cls = `${isActive ? " active" : ""}${dim ? " dim" : ""}`;
    html += `<div class="bar-marker${cls}" data-m="${m}" style="bottom:${pos}%">` +
      `<span class="bar-line" style="background:${color}"></span></div>`;
    const value = isActive
      ? `<input type="number" class="bar-edit mono" value="${Math.round(heightToDisplay(m))}" ` +
        `min="${cfg.min}" max="${editMax}" step="${cfg.step}">` +
        `<span class="bar-unit hint">${heightUnit()}</span>`
      : `<span class="bar-label mono">${fmtHeight(m)}</span>`;
    labelHtml += `<div class="bar-labelrow${cls}" data-m="${m}" style="bottom:${pos}%">` +
      `<span class="bar-swatch" style="background:${color}"></span>${value}` +
      `<button class="bar-rm" data-m="${m}" title="Entfernen" tabindex="-1">×</button>` +
      `</div>`;
  }
  // Modell-Geländehöhe rechts neben der Grundlinie (bei AGL am unteren Rand,
  // bei AMSL an der Geländeoberkante).
  if (elev != null) {
    const groundPos = posPct(mode === "amsl" ? elev : 0);
    labelHtml += `<div class="bar-groundinfo" style="bottom:${groundPos}%">${fmtHeight(elev)} NN</div>`;
  }
  bar.innerHTML = html;
  el("heightbar-labels").innerHTML = labelHtml;

  updateActiveHint();
}

// Hinweis, welcher Punkt beim Methodenvergleich verglichen wird.
function updateActiveHint() {
  const hint = el("activehint");
  if (selectedMethods().length <= 1) {
    hint.textContent = "";
    hint.classList.remove("accent");
    return;
  }
  hint.textContent = activeHeight != null
    ? `Vergleich bei ${fmtHeight(activeHeight)} — anderen Balkenpunkt anklicken zum Wechseln`
    : "Bitte einen Höhenpunkt für den Vergleich wählen";
  hint.classList.add("accent");
}

// --- Balken-Interaktion: klicken = anlegen/aktivieren, ziehen = verschieben,
// Wert in der aktiven Beschriftung direkt editierbar ------------------------
let drag = null;

// Im Live-Modus zieht jede Änderung der aktiven Höhe eine sofortige
// Neuberechnung nach sich.
function maybeLive() {
  if (el("livemode").checked) liveRunDebounced();
}

// Höhe eines Punkts ändern, ohne einen bereits belegten Wert zu überschreiben.
function moveHeight(fromM, toM) {
  if (toM === fromM || heightColors.has(toM)) return false;
  const color = heightColors.get(fromM);
  heightColors.delete(fromM);
  heightColors.set(toM, color);
  if (activeHeight === fromM) activeHeight = toM;
  return true;
}

bar.addEventListener("pointerdown", (e) => {
  bar.setPointerCapture(e.pointerId);
  const markerEl = e.target.closest(".bar-marker");
  const m = markerEl ? +markerEl.dataset.m : yToMeters(e.clientY);
  if (markerEl || heightColors.has(m)) {
    activeHeight = m;
    renderBar();
    updateHeightContext();
    drag = { m };
    maybeLive();
    return;
  }
  // Leere Stelle: neuen Punkt anlegen (wird aktiv) und gleich ziehbar machen.
  if (addHeight(m)) { drag = { m }; updateHeightContext(); maybeLive(); }
});

bar.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const m = yToMeters(e.clientY);
  if (!moveHeight(drag.m, m)) return;
  drag.m = m;
  renderBar();
  updateHeightContext();
  maybeLive();
});

bar.addEventListener("pointerup", () => {
  if (drag) persist();
  drag = null;
});

// Beschriftungsspalte: × entfernt den Punkt; Klick auf eine noch nicht aktive
// Zeile aktiviert sie und fokussiert das Editierfeld.
el("heightbar-labels").addEventListener("click", (e) => {
  const rm = e.target.closest(".bar-rm");
  if (rm) { removeHeight(+rm.dataset.m); maybeLive(); return; }
  const row = e.target.closest(".bar-labelrow");
  if (!row) return;
  const m = +row.dataset.m;
  if (m === activeHeight) return; // schon aktiv → nicht neu rendern (Fokus behalten)
  activeHeight = m;
  renderBar();
  updateHeightContext();
  persist();
  maybeLive();
  const edit = el("heightbar-labels").querySelector(".bar-labelrow.active .bar-edit");
  if (edit) { edit.focus(); edit.select(); }
});

// Editierfeld der aktiven Höhe: bei Enter/Verlassen den Wert übernehmen.
el("heightbar-labels").addEventListener("change", (e) => {
  if (!e.target.classList.contains("bar-edit")) return;
  const oldM = +e.target.closest(".bar-labelrow").dataset.m;
  if (moveHeight(oldM, snapMeters(heightFromDisplay(+e.target.value)))) {
    persist();
    maybeLive();
  }
  renderBar(); // Wert normalisieren bzw. bei Kollision zurücksetzen
  updateHeightContext();
});

// Tastatur: aktiven Punkt mit Pfeil hoch/runter um eine Schrittweite bewegen.
bar.addEventListener("keydown", (e) => {
  if (activeHeight == null) return;
  const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  const stepM = heightFromDisplay(heightSliderCfg().step);
  if (moveHeight(activeHeight, snapMeters(activeHeight + dir * stepM))) {
    renderBar();
    updateHeightContext();
    persist();
    maybeLive();
  }
});

// --- Live-Modus: die aktive Höhe rechnet bei jeder Änderung sofort neu -------
// Das Windfeld (samt Punkt-Cache) bleibt zwischen den Läufen erhalten,
// solange Modell, Vertikaloption, Zeit und Richtung gleich bleiben — nach
// der ersten Bewegung rechnet der aktive Punkt dann ohne Netzwerkzugriffe.
let liveDirty = false;

function liveRun() {
  if (!el("livemode").checked || !state.start || !state.meta) return;
  if (state.running) { liveDirty = true; return; }
  runTrajectories();
}

const liveRunDebounced = debounce(liveRun, 200);

function applyModeUI() {
  const live = el("livemode").checked;
  el("heightslabel").innerHTML = live
    ? 'Starthöhen <span class="hint">(Live: aktive Höhe folgt dem Balken)</span>'
    : 'Starthöhen <span class="hint">(max. 8, Balken anklicken)</span>';
  renderBar();
}

el("livemode").addEventListener("change", () => {
  if (el("livemode").checked && el("useapi").checked) {
    el("useapi").checked = false; // Live-Scrub nur mit Browser-Rechnung
  }
  if (el("livemode").checked && el("flightprofile").checked) {
    el("flightprofile").checked = false;
    applyProfileUI();
  }
  applyModeUI();
  state.live = null;
  // Beim Verlassen des Live-Modus bleiben alle Trajektorien sichtbar (aktive
  // Linie + Pins). Ein späterer „echter" Lauf zeichnet ohnehin alles neu.
  persist();
  liveRun();
});

// --- Flugprofil: Events -----------------------------------------------------
el("flightprofile").addEventListener("change", () => {
  if (el("flightprofile").checked && el("livemode").checked) {
    el("livemode").checked = false;
    state.live = null;
  }
  if (!el("flightprofile").checked) state.profileEdit = null;
  applyProfileUI();
  persist();
});
el("fp-preset").addEventListener("change", () => {
  applyProfilePreset(el("fp-preset").value);
  persist();
});
el("fp-tbody").addEventListener("change", () => {
  readProfileTable();
  refreshProfileUI({ scheduleApi: true });
  persist();
});
el("fp-add").addEventListener("click", () => {
  readProfileTable();
  if (profileTargets.length >= FP_MAX_ROWS) return;
  const last = profileTargets[profileTargets.length - 1];
  profileTargets.push({
    tSec: last.tSec + 1800,
    targetAgl: last.targetAgl,
    rate: "jump",
  });
  refreshProfileUI({ scheduleApi: true });
  persist();
});
el("fp-rm").addEventListener("click", () => {
  readProfileTable();
  if (profileTargets.length <= 2) return;
  profileTargets.pop();
  refreshProfileUI({ scheduleApi: true });
  persist();
});

wireProfileSideView();

el("fp-modal-close").addEventListener("click", closeProfileModal);
el("fp-modal").addEventListener("click", (e) => {
  if (e.target === el("fp-modal")) closeProfileModal();
});
el("fp-modal-del")?.addEventListener("click", () => {
  const i = profileModalIndex;
  if (i == null) return;
  closeProfileModal();
  removeProfileTarget(i);
});
el("fp-modal-h").addEventListener("input", applyModalToTarget);
el("fp-modal-rate").addEventListener("change", applyModalToTarget);
for (const r of el("fp-modal").querySelectorAll('input[name="fp-mode"]')) {
  r.addEventListener("change", () => {
    el("fp-modal-rate-row").hidden =
      el("fp-modal").querySelector('input[name="fp-mode"]:checked')?.value !== "custom";
    applyModalToTarget();
  });
}
el("ascentrate").addEventListener("change", () => {
  el("ascentrate").value = String(clampRate(+el("ascentrate").value));
  persist();
});
el("descentrate").addEventListener("change", () => {
  el("descentrate").value = String(clampRate(+el("descentrate").value));
  persist();
});

// --- Methoden (Berechnungsarten): eine oder mehrere per Häkchen -------------
for (const m of METHODS) {
  const label = document.createElement("label");
  label.dataset.key = m.key;
  label.innerHTML =
    `<input type="checkbox" value="${m.key}" ${m.key === "height" ? "checked" : ""}>` +
    `<span class="chip" style="background:${m.color}"></span>${m.label}`;
  label.querySelector("input").addEventListener("change", () => {
    state.live = null; // andere Methoden brauchen ggf. andere Variablen
    renderBar(); // Ausgrauen/Aktiv-Hinweis hängen am Vergleichsmodus
    persist();
  });
  el("methodlist").appendChild(label);
}

function selectedMethods() {
  return [...el("methodlist").querySelectorAll("input:checked:not(:disabled)")]
    .map((c) => c.value);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Gespeicherte Höhenliste wiederherstellen (Farben nur, wenn sie noch zur
// Palette gehören und eindeutig sind — sonst neu zuweisen), sonst Standard.
const savedHeights = Array.isArray(saved.heights) ? saved.heights : null;
if (savedHeights?.length) {
  const validColors = savedHeights.every(({ m, color }, i) =>
    Number.isFinite(m) && SERIES_COLORS.includes(color) &&
    savedHeights.findIndex((h) => h.color === color) === i);
  if (validColors) {
    for (const { m, color } of savedHeights.slice(0, SERIES_COLORS.length)) {
      heightColors.set(Math.round(m), color);
    }
  } else {
    savedHeights.forEach(({ m }) => addHeight(m));
  }
} else {
  DEFAULT_HEIGHTS.forEach(addHeight);
}
// Migration: ohne gespeichertes Lineal-Maximum das kleinste passende wählen,
// damit vorhandene Höhen sichtbar bleiben (aber mindestens den 6-km-Default).
if (!BAR_MAX_OPTIONS.includes(saved.barMax) && heightColors.size) {
  const maxH = Math.max(...heightColors.keys());
  barMax = Math.max(6000, BAR_MAX_OPTIONS.find((v) => v >= maxH) ?? HEIGHT_MAX);
}
// Aktiven Punkt wiederherstellen, sonst den untersten nehmen.
if (Number.isFinite(saved.activeHeight) && heightColors.has(Math.round(saved.activeHeight))) {
  activeHeight = Math.round(saved.activeHeight);
} else if (heightColors.size) {
  activeHeight = [...heightColors.keys()].sort((a, b) => a - b)[0];
}
renderBar();

// --- Markenabstand ----------------------------------------------------------
for (const min of MARKER_INTERVALS) {
  const opt = document.createElement("option");
  opt.value = min * 60;
  opt.textContent = min < 60 ? `${min} min` : `${min / 60} h`;
  if (min * 60 === (saved.markerIntervalSec ?? 600)) opt.selected = true;
  el("markerint").appendChild(opt);
}

// --- Lineal-Maximum (Höhenbalken) -------------------------------------------
for (const v of BAR_MAX_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = v;
  opt.textContent = `${v / 1000} km`;
  if (v === barMax) opt.selected = true;
  el("barmax").appendChild(opt);
}
el("barmax").addEventListener("change", () => {
  barMax = +el("barmax").value;
  // Höhen oberhalb des neuen Maximums fallen weg.
  for (const m of [...heightColors.keys()]) if (m > barMax) removeHeight(m);
  renderBar();
  updateHeightContext();
  persist();
});

// --- Übrige Einstellungen wiederherstellen und Änderungen speichern ---------
if (MODELS[saved.model]) el("model").value = saved.model;
if (["agl", "amsl"].includes(saved.refmode)) el("refmode").value = saved.refmode;
if (["1", "-1"].includes(saved.direction)) el("direction").value = saved.direction;
if (Number.isFinite(saved.duration)) el("duration").value = saved.duration;
updateDirectionLabels();
for (const id of ["markerint", "direction", "duration"]) {
  el(id).addEventListener("change", persist);
}

// Modell-Vertikalgeschwindigkeit: je Modell prüfen, ob der Server die
// Variable anbietet, und die 3D-Option entsprechend schalten. Läuft beim
// Start und bei jedem Modellwechsel (Ergebnis wird je Modell gecacht).
let wVarPrefix = null;
const wPrefixByModel = new Map();

async function updateWDetection() {
  const modelKey = el("model").value;
  if (!wPrefixByModel.has(modelKey)) {
    wPrefixByModel.set(modelKey, await WindField.detectWVariable(modelKey));
  }
  wVarPrefix = wPrefixByModel.get(modelKey);
  if (modelKey !== el("model").value) return; // Modell wurde inzwischen gewechselt
  const mLabel = el("methodlist").querySelector('label[data-key="z3d"]');
  if (mLabel) {
    mLabel.querySelector("input").disabled = !wVarPrefix;
    mLabel.classList.toggle("off", !wVarPrefix);
    mLabel.title = wVarPrefix ? "" : "Server liefert noch kein w für dieses Modell";
  }
}

updateWDetection();
if (saved.start && Number.isFinite(saved.start.lat) && Number.isFinite(saved.start.lon)) {
  setStart(saved.start.lat, saved.start.lon);
}

// Einheiten-Auswahl: Balken (samt Editierfeld) und, falls offen, Querschnitt
// in der neuen Einheit neu beschriften.
el("unitheight").value = unitState.height;
el("unitwind").value = unitState.wind;
function onUnitsChange() {
  setUnits({ height: el("unitheight").value, wind: el("unitwind").value });
  renderBar();
  if (el("flightprofile").checked) refreshProfileUI({ scheduleApi: false });
  updateHeightContext();
  if (!el("xsec").hidden && state.xsec) renderCrossSection(el("xsec-body"), state.xsec);
  persist();
}
el("unitheight").addEventListener("change", onUnitsChange);
el("unitwind").addEventListener("change", onUnitsChange);

if (saved.liveMode) el("livemode").checked = true;
if (Array.isArray(saved.methods) && saved.methods.length) {
  for (const c of el("methodlist").querySelectorAll("input")) {
    c.checked = saved.methods.includes(c.value);
  }
} else if (["pressure", "theta"].includes(saved.vmotion)) {
  // Migration: früher gab es statt der Häkchen ein Vertikalbewegungs-Menü.
  for (const c of el("methodlist").querySelectorAll("input")) {
    c.checked = c.value === saved.vmotion;
  }
}
applyModeUI();

if (saved.metExtras) el("metextras").checked = true;
el("useapi").checked = saved.useApi !== false;
if (el("useapi").checked && el("livemode").checked) {
  el("useapi").checked = false; // Live-Scrub nur mit Browser-Rechnung
}
el("useapi").addEventListener("change", () => {
  if (el("useapi").checked && el("livemode").checked) {
    el("livemode").checked = false;
    state.live = null;
  }
  if (!el("useapi").checked && el("flightprofile").checked) {
    el("flightprofile").checked = false;
    applyProfileUI();
    setStatus("Flugprofil braucht „API abrufen“.", true);
  }
  persist();
  updateRunButton();
});
el("metextras").addEventListener("change", () => {
  state.live = null; // Zusatzvariablen erfordern einen frischen Daten-Cache
  persist();
});

// Flugprofil wiederherstellen (nach useApi/liveMode, vor settingsReady)
const savedTargets = Array.isArray(saved.profileTargets) ? saved.profileTargets
  : Array.isArray(saved.profileWaypoints) ? saved.profileWaypoints : null;
if (savedTargets?.length >= 2) {
  const restored = savedTargets
    .map((w) => ({
      tSec: +w.tSec,
      targetAgl: +(w.targetAgl ?? w.hAgl),
      rate: w.rate === "jump" || w.rate == null ? "jump" : +w.rate,
    }))
    .filter((w) => Number.isFinite(w.tSec) && Number.isFinite(w.targetAgl));
  if (restored.length >= 2 && !validateProfileTargets(restored)) {
    profileTargets = restored;
  }
}
if (["climbcruise", "constant", "empty"].includes(saved.profilePreset)) {
  el("fp-preset").value = saved.profilePreset;
}
if (Number.isFinite(saved.ascentRate)) el("ascentrate").value = String(clampRate(saved.ascentRate));
if (Number.isFinite(saved.descentRate)) el("descentrate").value = String(clampRate(saved.descentRate));
// Rebuild default climbcruise after rates are known (skip if waypoints were restored).
if (!(savedTargets?.length >= 2) && el("fp-preset").value === "climbcruise") {
  profileTargets = climbCruiseTargets();
}
if (saved.flightProfile) {
  el("flightprofile").checked = true;
  if (!el("useapi").checked) el("useapi").checked = true;
  if (el("livemode").checked) el("livemode").checked = false;
}
applyProfileUI();

updateHeightContext();

settingsReady = true;

// --- Startpunkt per Klick / Marker ziehen -----------------------------------
map.on("click", (e) => setStart(e.latlng.lat, e.latlng.lng));

function setStart(lat, lon) {
  state.start = { lat, lon };
  el("startpos").textContent = `${lat.toFixed(3)}°N ${lon.toFixed(3)}°E`;
  if (!state.startMarker) {
    state.startMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    state.startMarker.on("dragend", () => {
      const p = state.startMarker.getLatLng();
      setStart(p.lat, p.lng);
    });
  } else {
    state.startMarker.setLatLng([lat, lon]);
  }
  updateRunButton();
  persist();
  fetchStartElevation();
}

initGeocode({ map, setStart, debounce, el });

// Modell-Geländehöhe am Startort — bewusst aus der Forecast-Antwort des
// gewählten Modells (Modellorographie), damit die Anzeige zu dem passt,
// womit die Trajektorien rechnen.
async function fetchStartElevation() {
  const s = state.start;
  if (!s) return;
  const model = MODELS[el("model").value];
  state.startElevation = null;
  updateHeightContext();
  renderBar();
  try {
    const params = new URLSearchParams({
      latitude: s.lat.toFixed(5),
      longitude: s.lon.toFixed(5),
      hourly: `wind_speed_level${model.nLevels}`,
      models: model.apiModel,
      forecast_days: "1",
    });
    const d = await (await fetch(`${API_BASE}/v1/forecast?${params}`)).json();
    if (Number.isFinite(d.elevation) && state.start === s) {
      state.startElevation = d.elevation;
      updateHeightContext();
      renderBar(); // Terrain-Schraffur am Balken (NN-Bezug) aktualisieren
    }
  } catch {
    /* Anzeige bleibt leer */
  }
}

/** Macht den Bezug der aktiven Starthöhe sichtbar: Geländehöhe am Start und
 *  die Umrechnung AGL <-> NN für den aktiven Höhenpunkt. */
function updateHeightContext() {
  const mode = el("refmode").value;
  const elev = state.startElevation;
  const hint = el("heighthint");
  hint.classList.remove("error");
  const h = activeHeight;
  if (h == null) { hint.textContent = ""; return; }
  const ref = mode === "agl" ? "über Grund" : "NN";
  const ort = +el("direction").value === -1 ? "am Zielort" : "am Startort";
  if (elev == null) {
    hint.textContent = `Aktiv: ${fmtHeight(h)} ${ref}`;
  } else if (mode === "agl") {
    hint.textContent = `Aktiv: ${fmtHeight(h)} über Grund ≈ ${fmtHeight(h + elev)} NN ${ort}`;
  } else if (h < elev) {
    hint.textContent = `Aktiv: ${fmtHeight(h)} NN liegt ${ort} unter Grund!`;
    hint.classList.add("error");
  } else {
    hint.textContent = `Aktiv: ${fmtHeight(h)} NN ≈ ${fmtHeight(h - elev)} über Grund ${ort}`;
  }
}

// --- Zeitschieber aus meta.json des gewählten Modells -----------------------
async function loadMeta() {
  const model = MODELS[el("model").value];
  el("status").textContent = "Lade Modelllauf-Info …";
  el("status").className = "";
  try {
    const meta = await (await fetch(`${API_BASE}/data/${model.dataset}/static/meta.json`)).json();
    // Der Server hält mehrere Tage Archiv (geprüft ≥5 d) — für Rückwärts-
    // trajektorien großzügiger Vorlauf; die echte Kante meldet der Integrator.
    const t0 = meta.last_run_initialisation_time - PAST_HOURS * 3600;
    const t1 = meta.data_end_time;
    state.meta = { t0, t1 };
    const slider = el("timeslider");
    const prev = +slider.value || null;
    slider.min = Math.ceil(t0 / 3600);
    slider.max = Math.floor(t1 / 3600);
    // Beim ersten Laden auf die aktuelle Uhrzeit (auf volle Stunde gerundet)
    // stellen, bei Modellwechsel die gewählte Zeit behalten — jeweils auf den
    // verfügbaren Zeitraum begrenzt.
    const want = prev ?? Math.round(Date.now() / 3600e3);
    slider.value = Math.min(Math.max(want, +slider.min), +slider.max);
    el("runinfo").textContent =
      ` · Lauf ${fmtTime(meta.last_run_initialisation_time * 1000)}, Daten bis ${fmtTime(t1 * 1000)}`;
    updateTimeLabel();
    updateReachHint();
    el("status").textContent = "";
  } catch (err) {
    el("status").textContent = `Modelllauf-Info nicht erreichbar: ${err.message}`;
    el("status").className = "error";
    state.meta = null;
  }
  updateRunButton();
}

function updateTimeLabel() {
  el("timelabel").textContent = fmtTime(+el("timeslider").value * 3600e3);
}

// Vergangenheits-Horizont für den Zeitschieber (der Server hält mehrere Tage
// Archiv). Die echte Datenkante meldet ansonsten der Integrator.
const PAST_HOURS = 72;

// Bei Rückwärtstrajektorien ist der gesetzte Punkt/Zeitpunkt die Ankunft.
function updateDirectionLabels() {
  const back = +el("direction").value === -1;
  el("pointlabel").textContent = back ? "Zielpunkt" : "Startpunkt";
  el("timeheadlabel").innerHTML = `${back ? "Zielzeit" : "Startzeit"} <span class="hint">(UTC)</span>`;
}

// Vorab-Hinweis, wie weit die Daten in der gewählten Richtung ab dem
// gewählten Zeitpunkt reichen — nur Transparenz, kein harter Block.
function updateReachHint() {
  const box = el("reachhint");
  if (!state.meta) { box.textContent = ""; box.classList.remove("error"); return; }
  const dir = +el("direction").value;
  const dur = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = +el("timeslider").value * 3600e3;
  const back = dir === -1;
  const edgeMs = (back ? state.meta.t0 : state.meta.t1) * 1000;
  const availH = Math.max(0, (back ? t0Ms - edgeMs : edgeMs - t0Ms) / 3600e3);
  const word = back ? "rückwärts" : "vorwärts";
  if (availH < dur) {
    box.textContent = `Nur ${Math.floor(availH)} h Daten ${word} (bis ${fmtTime(edgeMs)}) — Trajektorie endet dort.`;
    box.classList.add("error");
  } else {
    box.textContent = `${dur} h ${word} bis ${fmtTime(t0Ms + dir * dur * 3600e3)} — innerhalb der Daten.`;
    box.classList.remove("error");
  }
}

el("timeslider").addEventListener("input", () => { updateTimeLabel(); updateReachHint(); });
el("timeslider").addEventListener("change", persist);
el("duration").addEventListener("input", updateReachHint);
el("direction").addEventListener("change", () => {
  updateDirectionLabels();
  updateHeightContext(); // „am Startort"/„am Zielort" hängt an der Richtung
  updateReachHint();
});
el("model").addEventListener("change", () => {
  persist();
  loadMeta();
  updateWDetection();
  fetchStartElevation(); // Modellorographie unterscheidet sich je Modell
});
// Beim Wechsel des Höhenbezugs die vorhandenen Höhen physisch beibehalten:
// AGL→AMSL addiert die Geländehöhe, AMSL→AGL zieht sie ab (gerundet auf die
// Schrittweite). Ohne bekannte Geländehöhe wird nur neu beschriftet.
el("refmode").addEventListener("change", () => {
  convertHeightsForRefmode(el("refmode").value);
  updateHeightContext();
  renderBar();
  persist();
  maybeLive();
});

function convertHeightsForRefmode(toMode) {
  const elev = state.startElevation;
  if (elev == null || !heightColors.size) return;
  const shift = toMode === "amsl" ? elev : -elev;
  const items = [...heightColors.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([m, color]) => ({ raw: m + shift, color, wasActive: m === activeHeight }));
  // Lineal-Maximum bei Bedarf anheben, damit keine Höhe oben herausfällt.
  const maxRaw = Math.max(...items.map((i) => i.raw));
  if (maxRaw > barMax) {
    barMax = BAR_MAX_OPTIONS.find((v) => v >= maxRaw) ?? HEIGHT_MAX;
    el("barmax").value = barMax;
  }
  heightColors.clear();
  activeHeight = null;
  for (const it of items) {
    const m = snapMeters(it.raw); // rastert und begrenzt auf [HEIGHT_MIN, barMax]
    if (heightColors.has(m)) continue; // unter Grund geratene Höhen können zusammenfallen
    heightColors.set(m, it.color);
    if (it.wasActive) activeHeight = m;
  }
  if (activeHeight == null && heightColors.size) {
    activeHeight = [...heightColors.keys()].sort((a, b) => a - b)[0];
  }
}

function updateRunButton() {
  el("run").disabled = state.running || !state.start || !state.meta;
}

// --- Berechnung -------------------------------------------------------------
el("run").addEventListener("click", runTrajectories);

/** Convert Trajectories-API GeoJSON back into the app's run objects. */
function runsFromApiGeoJSON(gj, { mode, modelKey, direction, duration, t0Ms }) {
  const lines = (gj.features || []).filter(
    (f) => f.geometry?.type === "LineString" && f.properties?.kind === "trajectory",
  );
  const markers = (gj.features || []).filter(
    (f) => f.geometry?.type === "Point" && f.properties?.kind === "marker",
  );
  const runs = [];
  for (const f of lines) {
    const p = f.properties || {};
    const times = p.times || [];
    const coords = f.geometry.coordinates || [];
    const points = [];
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const tMs = times[i]
        ? Date.parse(times[i])
        : t0Ms + (direction > 0 ? 1 : -1) * i * 60000;
      points.push({
        lat: c[1],
        lon: c[0],
        z: c.length > 2 ? c[2] : null,
        tMs,
      });
    }
    if (points.length < 2) continue;
    const heightM = +p.start_height_m;
    const method = p.vertical_motion || "height";
    const rawLabel = typeof p.label === "string" ? p.label : "";
    const label = rawLabel.slice(0, 120).replace(/[<>&"]/g, "")
      || `${fmtHeight(heightM)} ${mode.toUpperCase()}`;
    const style = METHODS.find((m) => m.key === method);
    const cssColor = /^#[0-9a-f]{3,8}$/i.test(p.stroke || p.color || "")
      ? (p.stroke || p.color)
      : null;
    const color = cssColor || style?.color || colorFor(heightM);
    const dash = style?.dash || null;
    const lineMarkers = markers
      .filter((m) => (m.properties?.label || "") === label)
      .map((m) => {
        const mp = m.properties || {};
        const mc = m.geometry.coordinates || [];
        const spdMs = ((mp.wind_speed_kmh || 0) / 3.6);
        const dirRad = ((mp.wind_direction_deg || 0) * Math.PI) / 180;
        // Same convention as drawTrajectory: dir = atan2(-u, -v) "from".
        const u = -spdMs * Math.sin(dirRad);
        const v = -spdMs * Math.cos(dirRad);
        const met = (mp.temperature_c != null || mp.pressure_hpa != null)
          ? {
            t: mp.temperature_c,
            td: mp.dewpoint_c,
            rh: mp.relative_humidity_pct,
            p: mp.pressure_hpa,
          }
          : null;
        return {
          lat: mc[1],
          lon: mc[0],
          z: mc.length > 2 ? mc[2] : null,
          tMs: mp.time ? Date.parse(mp.time) : points[0].tMs,
          u, v, met,
        };
      });
    const rawTerrain = Array.isArray(p.terrain_m) ? p.terrain_m : null;
    const terrain = points.map((_, i) => {
      const g = rawTerrain ? rawTerrain[i] : null;
      return Number.isFinite(g) ? +g : null;
    });
    runs.push({
      r: {
        points,
        markers: lineMarkers,
        status: p.status || "ok",
        reason: p.stop_reason || null,
      },
      color,
      label,
      heightM: Number.isFinite(heightM) ? heightM : 0,
      method,
      dash,
      terrain,
    });
  }
  return runs.sort((a, b) => a.heightM - b.heightM);
}

async function runTrajectoriesViaApi({
  modelKey, lat, lon, methods, compareMode,
  activeHeights, markerIntervalSec, mode, direction, duration, t0Ms,
  heightProfile = null,
  profileRedraw = false,
  profileGen = null,
}) {
  const keepSiblings = profileRedraw && state.profileEdit?.active;
  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  state.pinLayers.clearLayers();
  state.pinRuns.clear();
  state.pinKey = "";
  if (!keepSiblings) {
    state.dimLayers.clearLayers();
    el("results").innerHTML = "";
    state.profileEdit = el("flightprofile").checked && heightProfile
      ? state.profileEdit
      : null;
    if (!state.profileEdit?.active) restoreStartMarkerVisibility();
  }
  el("download").disabled = true;
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  if (!keepSiblings) el("xsec").hidden = true;
  if (!keepSiblings) {
    state.lastRuns = null;
    state.xsec = null;
  }
  state.live = null;
  setStatus(keepSiblings ? "API: aktualisiere Flugprofil …" : "API: lade Trajektorien …");

  const profile = heightProfile && heightProfile.length >= 2 ? heightProfile : null;
  const forecastHours = profile
    ? Math.min(duration, Math.max(1, Math.ceil(profile[profile.length - 1].tSec / 3600)))
    : duration;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    models: modelKey,
    time: new Date(t0Ms).toISOString().replace(/\.\d{3}Z$/, "Z"),
    timeformat: "iso8601",
    forecast_hours: String(forecastHours),
    vertical_motion: profile ? "height" : methods.join(","),
    direction: direction > 0 ? "forward" : "backward",
    marker_interval: String(markerIntervalSec / 60),
    met_extras: String(el("metextras").checked),
    format: "geojson",
    backend: "auto",
  });
  if (profile) {
    params.set("profile_time", profile.map((w) => w.tSec).join(","));
    params.set("profile_height", profile.map((w) => w.hAgl).join(","));
    params.set("marker_interval_climbing", "10");
  } else if (mode === "amsl") {
    params.set("height_amsl", activeHeights.join(","));
  } else {
    params.set("height_agl", activeHeights.join(","));
  }

  const t0 = performance.now();
  try {
    const url = `${TRAJECTORY_API}/v1/trajectory?${params}`;
    if (DEBUG) console.debug("[traj] API", url);
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const body = await resp.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`Serverfehler ${resp.status}: ${body.slice(0, 180)}`);
    }
    const ms = performance.now() - t0;
    if (!resp.ok || data?.error) {
      throw new Error(data?.reason || `HTTP ${resp.status}`);
    }
    if (profileGen != null && profileGen !== state.profileRedrawGen) return;
    const runs = runsFromApiGeoJSON(data, {
      mode: profile ? "agl" : mode, modelKey, direction, duration: forecastHours, t0Ms,
    });
    if (!runs.length) throw new Error("API lieferte keine Trajektorien");

    if (keepSiblings) {
      const candidate = runs[0];
      const siblings = state.profileEdit.siblingRuns;
      state.profileEdit.candidateKey = runKey(candidate);
      paintProfileEditMap(candidate);
      const all = [candidate, ...siblings];
      state.lastRuns = {
        runs: all, modelKey, mode: "agl", t0Ms, duration: forecastHours, direction,
      };
      el("results").innerHTML = "";
      for (const run of all) reportResult(run.r, run.heightM, run.color, run.label, run);
      highlightResultCandidate(runKey(candidate));
      state.xsec = {
        runs: all.map((run) => ({
          ...run,
          terrain: run.terrain || run.r.points.map(() => null),
        })),
        t0Ms,
        direction,
        overlay: false,
      };
      el("fp-candhint").textContent =
        `Kandidat: ${candidate.label} — Marken anklicken zum Ändern`;
    } else if (profile) {
      const siblings = state.profileEdit?.siblingRuns || [];
      state.profileEdit = {
        active: true,
        candidateKey: runKey(runs[0]),
        siblingRuns: siblings,
        t0Ms,
      };
      paintProfileEditMap(runs[0]);
      const all = siblings.length ? [runs[0], ...siblings] : runs;
      for (const run of all) reportResult(run.r, run.heightM, run.color, run.label, run);
      highlightResultCandidate(runKey(runs[0]));
      state.lastRuns = {
        runs: all, modelKey, mode: "agl", t0Ms, duration: forecastHours, direction,
      };
      state.xsec = {
        runs: all.map((run) => ({
          ...run,
          terrain: run.terrain || run.r.points.map(() => null),
        })),
        t0Ms,
        direction,
        overlay: false,
      };
      el("fp-candhint").textContent =
        `Kandidat: ${runs[0].label} — Marken anklicken zum Ändern`;
    } else {
      const pickable = mode === "agl";
      for (const run of runs) drawCasing(run.r, state.layers);
      for (const run of runs) {
        drawTrajectory(run.r, run.color, run.label, run.dash, state.layers, {
          onSelect: pickable && run.method === "height"
            ? () => tryPickCandidate(run)
            : null,
        });
      }
      for (const run of runs) reportResult(run.r, run.heightM, run.color, run.label, run);
      state.lastRuns = { runs, modelKey, mode, t0Ms, duration: forecastHours, direction };
      state.xsec = {
        runs: runs.map((run) => ({
          ...run,
          terrain: run.terrain || run.r.points.map(() => null),
        })),
        t0Ms,
        direction,
        overlay: compareMode,
      };
    }

    const g0 = (keepSiblings ? runs[0] : runs[0])?.terrain?.find((g) => Number.isFinite(g));
    if (Number.isFinite(g0)) state.startElevation = g0;
    el("download").disabled = false;
    el("xsecbtn").disabled = false;
    el("view3dbtn").disabled = false;
    if (view3dMod && !el("view3d").hidden) view3dMod.update(view3dData());
    setStatus(`API: ${keepSiblings ? "Profil" : `${runs.length} Trajektorie(n)`} · ${fmtMs(ms)}`);
  } catch (err) {
    if (profileGen != null && profileGen !== state.profileRedrawGen) return;
    const ms = performance.now() - t0;
    setStatus(`API-Fehler: ${err.message} · ${fmtMs(ms)}`, true);
  } finally {
    state.running = false;
    updateRunButton();
  }
}

/** Format wall time for status line (API fetch or browser compute). */
function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function runTrajectories() {
  const modelKey = el("model").value;
  const model = MODELS[modelKey];
  const { lat, lon } = state.start;
  const liveMode = el("livemode").checked;
  const profileOn = el("flightprofile").checked;
  if (profileOn) {
    readProfileTable();
    const perr = validateProfileTargets(profileTargets);
    if (perr) return setStatus(perr, true);
    if (!el("useapi").checked) {
      return setStatus("Flugprofil braucht „API abrufen“.", true);
    }
  }
  const methods = profileOn ? ["height"] : selectedMethods();
  // Mehrere Methoden ergeben nur bei genau einer Starthöhe eine lesbare
  // Darstellung (Farbe kodiert dann die Methode statt der Höhe). Verglichen
  // wird am aktiven Balkenpunkt; die übrigen Punkte bleiben erhalten.
  const compareMode = !profileOn && methods.length > 1;
  // Pin-Modus: reiner Höhen-Live-Betrieb. Die aktive Höhe rechnet bei jeder
  // Balkenbewegung neu (Scrub), die übrigen Balkenpunkte bleiben als „Pins"
  // stehen. Im Methodenvergleich gibt es keine Pins.
  const pinMode = liveMode && !compareMode && !profileOn;
  const allBarHeights = [...heightColors.keys()].sort((a, b) => a - b);
  // Live-Modus und Methodenvergleich rechnen an der aktiven Höhe; sonst alle
  // Höhen des Balkens.
  const activeHeights = profileOn
    ? [profileTargets[0].targetAgl]
    : (liveMode || compareMode)
      ? (activeHeight != null ? [activeHeight] : [])
      : allBarHeights;
  // Pins sind die übrigen Balkenhöhen (nur im Pin-Modus).
  const pinHeights = pinMode ? allBarHeights.filter((m) => m !== activeHeight) : [];
  const markerIntervalSec = +el("markerint").value;
  const mode = profileOn ? "agl" : el("refmode").value;
  if (!methods.length) {
    return setStatus("Bitte mindestens eine Methode wählen.", true);
  }
  const direction = +el("direction").value;
  const duration = Math.min(72, Math.max(1, +el("duration").value || 12));
  const t0Ms = +el("timeslider").value * 3600e3;

  if (!profileOn && !activeHeights.length) {
    return setStatus(compareMode
      ? "Bitte einen Höhenpunkt am Balken für den Vergleich wählen."
      : "Bitte eine Höhe am Balken wählen.", true);
  }
  const b = model.bbox;
  if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) {
    return setStatus(`Startpunkt liegt außerhalb des ${model.label}-Gebiets.`, true);
  }

  // Optional: Trajectories-HTTP-API statt Browser-Windfeld/Integrator.
  if (el("useapi").checked) {
    let heightProfile = null;
    if (profileOn) {
      try {
        heightProfile = expandProfile(profileTargets);
      } catch (e) {
        return setStatus(e.message, true);
      }
    }
    state.dimLayers.clearLayers();
    return runTrajectoriesViaApi({
      modelKey, model, lat, lon, methods, compareMode,
      activeHeights, markerIntervalSec, mode, direction, duration, t0Ms,
      heightProfile,
    });
  }

  // Signatur der Nicht-Höhen-Parameter (zugleich der Windfeld-Cache-Schlüssel:
  // Modell, Vertikaloption, Zeitfenster, Richtung, Startregion). Bleibt sie
  // gleich, hat sich nur die aktive Höhe bewegt → Scrub-Lauf: nur die aktive
  // Linie neu, die Pins bleiben. Ändert sie sich → Full-Lauf: alles neu.
  const metExtras = el("metextras").checked;
  const sig = [modelKey, methods.join("+"), t0Ms, duration, direction, metExtras,
    Math.round(lat), Math.round(lon)].join("|");
  const canReuse = liveMode && state.live?.sig === sig
    && activeHeights[0] <= state.live.spanTop;
  // Scrub (Pins behalten) nur, wenn sich wirklich ausschließlich die aktive
  // Höhe geändert hat. pinSig fasst alle übrigen pfadbestimmenden Größen exakt
  // (inkl. Höhenbezug und ungerundetem Startpunkt) — sonst wären die Pins zu
  // anderen Parametern gerechnet als die aktive Linie.
  const pinSig = [sig, mode, lat, lon].join("|");
  const scrub = pinMode && canReuse && state.live?.pinSig === pinSig;

  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  el("results").innerHTML = "";
  if (!scrub) {
    // Full-Lauf: Pins verwerfen und frisch aufbauen.
    state.pinLayers.clearLayers();
    state.pinRuns.clear();
    state.pinKey = "";
  }
  el("download").disabled = true;
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  const xsecWasOpen = !el("xsec").hidden;
  el("xsec").hidden = true;
  state.lastRuns = null;
  state.xsec = null;
  setStatus("Berechne …");
  const t0 = performance.now();

  try {
    // Im Live-Modus das Windfeld über Läufe hinweg behalten, solange die
    // Signatur gleich bleibt und die Höhe ins geladene Levelfenster passt.
    let wf;
    if (canReuse) {
      wf = state.live.wf;
    } else {
      wf = new WindField(modelKey, { wVarPrefix, debug: DEBUG });
      const tEnd = t0Ms + direction * duration * 3600e3;
      // Im Live-Modus deckt das Windfeld den ganzen Balken ab, damit auch Pins
      // und spätere Höhenwechsel ohne Nachladen bedient werden.
      const spanTop = liveMode
        ? Math.max(barMax, ...activeHeights, ...pinHeights)
        : Math.max(...activeHeights);
      await wf.init(lat, lon, spanTop, Math.min(t0Ms, tEnd), Math.max(t0Ms, tEnd), methods, metExtras);
      state.live = liveMode ? { wf, sig, spanTop } : null;
      if (DEBUG) {
        console.debug(`[traj] Modell ${modelKey}, Methoden ${methods.join("+")}, ` +
          `Levelfenster ${wf.levels.at(-1)}–${wf.levels[0]} (${wf.levels.length} Level), ` +
          `Zeitfenster ${wf.startDate}…${wf.endDate}`);
      }
    }
    // Aktuelle Pin-Parameter merken (auch bei wiederverwendetem Windfeld), damit
    // der nächste Lauf Scrub gegen genau diesen Stand prüfen kann.
    if (state.live) state.live.pinSig = pinSig;

    // Einen Lauf (Höhe × Methode) rechnen.
    const computeOne = async (heightM, method) => {
      const style = METHODS.find((m) => m.key === method);
      const color = compareMode ? style.color : colorFor(heightM);
      const dash = compareMode ? style.dash : null;
      const { target, label } = await makeTarget(wf, lat, lon, heightM, mode, method, t0Ms);
      const r = await computeTrajectory({
        windAt: wf.windAt.bind(wf),
        lat0: lat, lon0: lon, target, t0Ms,
        durationHours: duration, direction, gridMeters: model.gridMeters,
        markerIntervalSec,
      });
      return { r, color, label, heightM, method, dash };
    };
    // Eine scheiternde Methode/Höhe soll die übrigen nicht mitreißen.
    const reportError = (labelText, color, err) => {
      const line = document.createElement("div");
      line.className = "result-line";
      line.innerHTML = `<span class="chip" style="background:${color}"></span>` +
        `${labelText} <span class="note">Fehler: ${err.message}</span>`;
      el("results").appendChild(line);
    };

    // Aktive Läufe: entweder mehrere Höhen × eine Methode oder eine Höhe ×
    // mehrere Methoden (oben abgesichert).
    const activeRuns = [];
    for (const heightM of activeHeights) {
      for (const method of methods) {
        const style = METHODS.find((m) => m.key === method);
        setStatus(`Berechne ${compareMode ? style.label : fmtHeight(heightM)} …`);
        try {
          activeRuns.push(await computeOne(heightM, method));
        } catch (err) {
          reportError(compareMode ? style.label : fmtHeight(heightM),
            compareMode ? style.color : colorFor(heightM), err);
        }
      }
    }

    // Pins: aus dem Cache halten, nur fehlende (z. B. gerade deaktivierte)
    // Höhen einmalig mit dem gecachten Windfeld nachrechnen.
    const pinRunList = [];
    if (pinMode) {
      for (const heightM of pinHeights) {
        let run = state.pinRuns.get(heightM);
        if (!run) {
          try {
            run = await computeOne(heightM, methods[0]);
            state.pinRuns.set(heightM, run);
          } catch (err) {
            reportError(fmtHeight(heightM), colorFor(heightM), err);
            continue;
          }
        }
        pinRunList.push(run);
      }
      // Cache von Höhen befreien, die nicht mehr Pin sind (weg vom Balken oder
      // jetzt aktiv).
      for (const m of [...state.pinRuns.keys()]) {
        if (!pinHeights.includes(m)) state.pinRuns.delete(m);
      }
    }

    // Zeichnen. Pins nur neu, wenn sich ihr Satz geändert hat — reines Ziehen
    // der aktiven Höhe lässt die Pins unangetastet (kein Flackern). Je Layer
    // zwei Durchgänge (erst alle weißen Unterlagen, dann alle Farblinien),
    // sonst übermalt die Unterlage einer Linie die Nachbarlinie, wo Pfade
    // (fast) übereinanderliegen, und in Strichlücken erschiene Weiß.
    const pinKey = pinHeights.join(",");
    const pickable = mode === "agl" && !compareMode;
    if (!scrub || pinKey !== state.pinKey) {
      state.pinLayers.clearLayers();
      for (const run of pinRunList) drawCasing(run.r, state.pinLayers);
      for (const run of pinRunList) {
        drawTrajectory(run.r, run.color, run.label, run.dash, state.pinLayers, {
          onSelect: pickable && run.method === "height" ? () => tryPickCandidate(run) : null,
        });
      }
      state.pinKey = pinKey;
    }
    state.dimLayers.clearLayers();
    restoreStartMarkerVisibility();
    for (const run of activeRuns) drawCasing(run.r, state.layers);
    for (const run of activeRuns) {
      drawTrajectory(run.r, run.color, run.label, run.dash, state.layers, {
        onSelect: pickable && run.method === "height" ? () => tryPickCandidate(run) : null,
      });
    }

    // Alle sichtbaren Läufe (aktiv + Pins) nach Höhe sortiert — Ergebnisliste,
    // Querschnitt und 3D-Ansicht spiegeln so das gesamte Bild.
    const runs = [...activeRuns, ...pinRunList].sort((a, b) => a.heightM - b.heightM);
    for (const run of runs) reportResult(run.r, run.heightM, run.color, run.label, run);
    state.lastRuns = { runs, modelKey, mode, t0Ms, duration, direction };
    el("download").disabled = runs.length === 0;

    // Querschnitt: Modellgelände entlang jedes Pfades aus dem Punkt-Cache.
    // Im Vergleichsmodus als Overlay (ein Streifen, Gelände der Referenz).
    state.xsec = {
      runs: runs.map((run) => ({
        ...run,
        terrain: run.r.points.map((p) => wf.elevationAt(p.lat, p.lon)),
      })),
      t0Ms,
      direction,
      overlay: compareMode,
    };
    // Querschnitt standardmäßig zu — nur der Knopf wird aktiv. Im
    // Live-Modus bleibt ein geöffneter Querschnitt offen und läuft mit.
    el("xsecbtn").disabled = runs.length === 0;
    if (liveMode && xsecWasOpen && runs.length) showCrossSection(true);
    // Offene 3D-Ansicht läuft mit (Live-Modus, Neuberechnung).
    el("view3dbtn").disabled = runs.length === 0;
    if (view3dMod && !el("view3d").hidden && runs.length) view3dMod.update(view3dData());
    // Scrub-Läufe sind sehr kurz und häufig — Zeit nur bei Full-Runs zeigen.
    if (!scrub) {
      setStatus(`${runs.length} Trajektorie(n) · ${fmtMs(performance.now() - t0)}`);
    } else {
      setStatus("");
    }
  } catch (err) {
    setStatus(`Fehler: ${err.message} · ${fmtMs(performance.now() - t0)}`, true);
  } finally {
    state.running = false;
    updateRunButton();
    if (liveDirty && el("livemode").checked) {
      liveDirty = false;
      setTimeout(liveRun, 0);
    }
  }
}

/** Zielfläche je Starthöhe: bei isobar/isentrop wird p0 bzw. θ0 am
 *  Startpunkt diagnostiziert und dann konstant gehalten. */
async function makeTarget(wf, lat, lon, heightM, mode, vmotion, t0Ms) {
  const ref = mode.toUpperCase();
  if (vmotion === "height") {
    return { target: { type: "height", mode, value: heightM }, label: `${fmtHeight(heightM)} ${ref}` };
  }
  const d = await wf.diagnoseAt(lat, lon, heightM, mode, t0Ms);
  if (d.error) throw new Error(d.error);
  if (vmotion === "pressure") {
    return { target: { type: "pressure", value: d.p }, label: `${fmtHeight(heightM)} → ${d.p.toFixed(0)} hPa` };
  }
  if (vmotion === "theta") {
    return { target: { type: "theta", value: d.theta }, label: `${fmtHeight(heightM)} → θ ${d.theta.toFixed(1)} K` };
  }
  return { target: { type: "z3d", value: d.zAmsl }, label: `${fmtHeight(heightM)} ${ref} (3D)` };
}

// Weiße Unterlage als Kontrast-Ausgleich auf Kartenkacheln (eigener
// Durchgang vor allen Farblinien, siehe runTrajectories).
function drawCasing(r, layer = state.layers) {
  if (r.points.length < 2) return;
  L.polyline(r.points.map((p) => [p.lat, p.lon]), {
    color: "#ffffff", weight: 6, opacity: 0.85, interactive: false,
  }).addTo(layer);
}

function nearestTargetIndex(tSec) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < profileTargets.length; i++) {
    const d = Math.abs(profileTargets[i].tSec - tSec);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function drawTrajectory(r, color, label, dash = null, layer = state.layers, opts = {}) {
  if (r.points.length < 2) return;
  const opacity = opts.opacity ?? 1;
  const interactive = opts.interactive !== false && opacity > 0.5;
  const latlngs = r.points.map((p) => [p.lat, p.lon]);
  const line = L.polyline(latlngs, {
    color, weight: 3, opacity, dashArray: dash, interactive,
  }).addTo(layer).bindTooltip(
    opts.editableMarkers
      ? `${label}<br><em>Doppelklick: Punkt einfügen</em>`
      : label,
    { sticky: true },
  );
  if (opts.onSelect && interactive) {
    line.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      opts.onSelect();
    });
  }
  if (opts.editableMarkers) {
    line.on("dblclick", (e) => {
      L.DomEvent.stop(e);
      L.DomEvent.preventDefault(e);
      const ll = e.latlng;
      const tSec = timeAlongPath(r, ll.lat, ll.lng);
      insertProfileTarget(tSec, profileHeightAt(tSec));
    });
  }

  const t0 = r.points[0]?.tMs ?? 0;
  const end = r.points.at(-1);
  /** @type {{ lat: number, lon: number, tMs: number, u?: number, v?: number, z?: number, met?: object, profileIndex?: number, synthetic?: string }[]} */
  const dots = [];
  if (opts.editableMarkers && profileTargets.length >= 2) {
    for (let i = 0; i < profileTargets.length; i++) {
      const w = profileTargets[i];
      const pos = pointAtTimeOnPath(r, w.tSec);
      if (!pos) continue;
      let nearestMet = null;
      let bestD = Infinity;
      for (const m of r.markers) {
        const d = Math.abs(m.tMs - (t0 + w.tSec * 1000));
        if (d < bestD) { bestD = d; nearestMet = m; }
      }
      const syn = i === 0 ? "start" : (i === profileTargets.length - 1 ? "end" : undefined);
      dots.push({
        lat: pos.lat,
        lon: pos.lon,
        tMs: t0 + w.tSec * 1000,
        z: pos.z,
        profileIndex: i,
        synthetic: syn,
        u: nearestMet?.u,
        v: nearestMet?.v,
        met: bestD < 120_000 ? nearestMet?.met : undefined,
      });
    }
  } else {
    if (opts.editableMarkers && r.points[0]) {
      dots.push({
        lat: r.points[0].lat,
        lon: r.points[0].lon,
        tMs: t0,
        z: r.points[0].z,
        synthetic: "start",
      });
    }
    for (const m of r.markers) dots.push(m);
    if (opts.editableMarkers && end) {
      const lastMark = r.markers.at(-1);
      if (!lastMark || Math.abs(end.tMs - lastMark.tMs) > 1500) {
        dots.push({
          lat: end.lat, lon: end.lon, tMs: end.tMs, z: end.z, synthetic: "end",
        });
      }
    }
  }

  for (const m of dots) {
    const dir = (Math.atan2(-(m.u || 0), -(m.v || 0)) * 180 / Math.PI + 360) % 360;
    const zLine = Number.isFinite(m.z) ? `<br>${fmtHeight(m.z)} NN` : "";
    const windLine = m.synthetic
      ? (m.synthetic === "start" ? "Start" : "Ziel")
      : `${fmtWind(Math.hypot(m.u || 0, m.v || 0))} aus ${Math.round(dir)}°`;
    const tipExtra = opts.editableMarkers
      ? "<br><em>Klick: ändern · Alt+Klick: löschen</em>"
      : (m.met ? "<br><em>klicken für Details</em>" : "");
    const marker = L.circleMarker([m.lat, m.lon], {
      radius: opts.editableMarkers ? 7 : 4,
      color,
      weight: 2,
      fillColor: "#ffffff",
      fillOpacity: Math.max(opacity, opts.editableMarkers ? 1 : opacity),
      opacity: Math.max(opacity, opts.editableMarkers ? 1 : opacity),
      interactive: interactive || !!opts.editableMarkers,
    }).addTo(layer).bindTooltip(
      `<div class="marker-tip">${fmtTime(m.tMs)}<br>${label}<br>` +
      `${windLine}${zLine}${tipExtra}</div>`,
    );
    if (m.met && !opts.editableMarkers) {
      const rows = [
        `<strong>${fmtTime(m.tMs)}</strong>`,
        label,
        Number.isFinite(m.z) ? `Höhe: ${fmtHeight(m.z)} NN` : null,
        `Wind: ${fmtWind(Math.hypot(m.u || 0, m.v || 0))} aus ${Math.round(dir)}°`,
        Number.isFinite(m.met.t) ? `T: ${m.met.t.toFixed(1)} °C` : null,
        Number.isFinite(m.met.td) ? `Td: ${m.met.td.toFixed(1)} °C` : null,
        Number.isFinite(m.met.rh) ? `RH: ${Math.round(m.met.rh)} %` : null,
        Number.isFinite(m.met.p) ? `p: ${m.met.p.toFixed(0)} hPa` : null,
        `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E`,
      ];
      marker.bindPopup(`<div class="marker-tip">${rows.filter(Boolean).join("<br>")}</div>`);
    }
    if (opts.editableMarkers) {
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        const idx = Number.isFinite(m.profileIndex)
          ? m.profileIndex
          : nearestTargetIndex(Math.max(0, Math.round((m.tMs - t0) / 1000)));
        if (e.originalEvent?.altKey) {
          if (profileModalIndex === idx) closeProfileModal();
          removeProfileTarget(idx);
          return;
        }
        openProfileModal(idx, m);
      });
    }
  }
}

function reportResult(r, heightM, color, label, run = null) {
  const line = document.createElement("div");
  line.className = "result-line";
  const end = r.points.at(-1);
  const note = r.status === "stopped"
    ? `gestoppt ${fmtTime(end.tMs)}: ${r.reason}`
    : `bis ${fmtTime(end.tMs)}`;
  const chip = document.createElement("span");
  chip.className = "chip";
  if (/^#[0-9a-f]{3,8}$/i.test(color || "")) chip.style.background = color;
  line.appendChild(chip);
  line.appendChild(document.createTextNode(`${label} `));
  const noteEl = document.createElement("span");
  noteEl.className = "note";
  noteEl.textContent = note;
  line.appendChild(noteEl);
  if (run) {
    line.dataset.runKey = runKey(run);
    line.addEventListener("click", () => tryPickCandidate(run));
  }
  el("results").appendChild(line);
}

// --- Querschnitt ------------------------------------------------------------
function showCrossSection(show) {
  el("xsec").hidden = !show;
  el("xsecbtn").textContent = show ? "Querschnitt ausblenden" : "Querschnitt anzeigen";
  if (show && state.xsec) {
    // Ein Streifen je Trajektorie; im Overlay (Methodenvergleich) einer.
    const n = state.xsec.overlay ? 2 : state.xsec.runs.length;
    const h = Math.min(110 * n + 62, Math.round(window.innerHeight * 0.55));
    el("xsec").style.height = `${Math.max(h, 190)}px`;
    el("xsec-hint").textContent = state.xsec.overlay
      ? "Höhe über NN · Gelände entlang des Referenzpfads"
      : "Höhe über NN · Gelände entlang des jeweiligen Pfades";
    renderCrossSection(el("xsec-body"), state.xsec);
  }
}

// --- Mobiles Bedienfeld (Bottom-Sheet, ein-/ausklappbar) --------------------
function setPanelCollapsed(collapsed) {
  el("panel").classList.toggle("collapsed", collapsed);
  el("paneltoggle").textContent = collapsed ? "▴" : "▾";
  el("paneltoggle").setAttribute("aria-expanded", String(!collapsed));
}
el("paneltoggle").addEventListener("click", () =>
  setPanelCollapsed(!el("panel").classList.contains("collapsed")));

// --- Panelbreite (Desktop, linker Griff) ------------------------------------
const PANEL_W_MIN = 280;
const PANEL_W_MAX = 720;
const PANEL_W_DEFAULT = 400;

// 3D layout consts/helpers must come before initPanelResize: setPanelWidth
// calls layoutView3d() on startup (TDZ if these are still uninitialized).
let view3dMod = null;
const V3D_EDGE = 10;
const V3D_MIN_W = 280;
const V3D_MIN_H = 200;

function view3dMobile() {
  return window.matchMedia("(max-width: 700px), (max-height: 500px)").matches;
}

/** Minimum `right` inset so the overlay clears the control panel. */
function view3dMinRight() {
  const panelW = el("panel").getBoundingClientRect().width || PANEL_W_DEFAULT;
  return Math.round(panelW + V3D_EDGE * 2);
}

function layoutView3d() {
  const box = el("view3d");
  if (!box || view3dMobile()) return;
  const minRight = view3dMinRight();
  const maxRight = Math.max(minRight, window.innerWidth - V3D_EDGE - V3D_MIN_W);
  let right = view3dRight == null ? minRight : view3dRight;
  right = Math.min(maxRight, Math.max(minRight, right));
  const maxBottom = Math.max(V3D_EDGE, window.innerHeight - V3D_EDGE - V3D_MIN_H);
  let bottom = view3dBottom == null ? V3D_EDGE : view3dBottom;
  bottom = Math.min(maxBottom, Math.max(V3D_EDGE, bottom));
  box.style.top = `${V3D_EDGE}px`;
  box.style.left = `${V3D_EDGE}px`;
  box.style.right = `${right}px`;
  box.style.bottom = `${bottom}px`;
  el("view3d-resize-e")?.setAttribute("aria-valuenow", String(right));
  el("view3d-resize-s")?.setAttribute("aria-valuenow", String(bottom));
}

function panelWidthMax() {
  return Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, window.innerWidth - 40));
}

function setPanelWidth(px, { save = false } = {}) {
  const w = Math.round(Math.min(panelWidthMax(), Math.max(PANEL_W_MIN, px)));
  el("panel").style.width = `${w}px`;
  el("panel-resize").setAttribute("aria-valuenow", String(w));
  layoutView3d();
  if (save) persist();
  return w;
}

(function initPanelResize() {
  const handle = el("panel-resize");
  handle.setAttribute("aria-valuemin", String(PANEL_W_MIN));
  handle.setAttribute("aria-valuemax", String(PANEL_W_MAX));
  const initial = Number.isFinite(saved.panelWidth) ? saved.panelWidth : PANEL_W_DEFAULT;
  setPanelWidth(initial);

  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (window.matchMedia("(max-width: 700px), (max-height: 500px)").matches) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("panel-resizing");
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startW: el("panel").getBoundingClientRect().width,
    };
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    // Panel is right-anchored: drag left → wider.
    setPanelWidth(drag.startW + (drag.startX - e.clientX));
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    document.body.classList.remove("panel-resizing");
    try { handle.releasePointerCapture(e.pointerId); } catch { /* */ }
    persist();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 16;
    const cur = el("panel").getBoundingClientRect().width;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPanelWidth(cur + step, { save: true });
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPanelWidth(cur - step, { save: true });
    } else if (e.key === "Home") {
      e.preventDefault();
      setPanelWidth(PANEL_W_MIN, { save: true });
    } else if (e.key === "End") {
      e.preventDefault();
      setPanelWidth(panelWidthMax(), { save: true });
    }
  });
  window.addEventListener("resize", () => {
    const cur = el("panel").getBoundingClientRect().width;
    if (cur > panelWidthMax()) setPanelWidth(panelWidthMax());
  });
})();

el("xsecbtn").addEventListener("click", () => showCrossSection(el("xsec").hidden));
el("xsec-close").addEventListener("click", () => showCrossSection(false));
window.addEventListener("resize", () => {
  if (!el("xsec").hidden && state.xsec) renderCrossSection(el("xsec-body"), state.xsec);
});

// --- 3D-Ansicht (Cesium, lazy geladen) --------------------------------------
(function initView3dResize() {
  const east = el("view3d-resize-e");
  const south = el("view3d-resize-s");
  if (!east || !south) return;
  east.setAttribute("aria-valuemin", String(V3D_EDGE));
  south.setAttribute("aria-valuemin", String(V3D_EDGE));

  let drag = null;
  east.addEventListener("pointerdown", (e) => {
    if (view3dMobile() || el("view3d").hidden) return;
    e.preventDefault();
    east.setPointerCapture(e.pointerId);
    document.body.classList.add("v3d-resizing-e");
    const cur = parseFloat(el("view3d").style.right) || view3dMinRight();
    drag = { axis: "e", pointerId: e.pointerId, startX: e.clientX, start: cur };
  });
  south.addEventListener("pointerdown", (e) => {
    if (view3dMobile() || el("view3d").hidden) return;
    e.preventDefault();
    south.setPointerCapture(e.pointerId);
    document.body.classList.add("v3d-resizing-s");
    const cur = parseFloat(el("view3d").style.bottom) || V3D_EDGE;
    drag = { axis: "s", pointerId: e.pointerId, startY: e.clientY, start: cur };
  });
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.axis === "e") {
      // Drag left → larger right inset → narrower overlay.
      view3dRight = drag.start + (drag.startX - e.clientX);
      layoutView3d();
    } else {
      view3dBottom = drag.start + (drag.startY - e.clientY);
      layoutView3d();
    }
  };
  const onEnd = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    document.body.classList.remove("v3d-resizing-e", "v3d-resizing-s");
    try {
      (drag.axis === "e" ? east : south).releasePointerCapture(e.pointerId);
    } catch { /* */ }
    drag = null;
    persist();
  };
  for (const h of [east, south]) {
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onEnd);
    h.addEventListener("pointercancel", onEnd);
  }
  east.addEventListener("keydown", (e) => {
    if (el("view3d").hidden) return;
    const step = e.shiftKey ? 40 : 16;
    const cur = parseFloat(el("view3d").style.right) || view3dMinRight();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      view3dRight = cur + step;
      layoutView3d();
      persist();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      view3dRight = cur - step;
      layoutView3d();
      persist();
    }
  });
  south.addEventListener("keydown", (e) => {
    if (el("view3d").hidden) return;
    const step = e.shiftKey ? 40 : 16;
    const cur = parseFloat(el("view3d").style.bottom) || V3D_EDGE;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      view3dBottom = cur + step;
      layoutView3d();
      persist();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      view3dBottom = cur - step;
      layoutView3d();
      persist();
    }
  });
  window.addEventListener("resize", () => {
    layoutView3d();
    const cur = el("fp-side")?.getBoundingClientRect().height;
    if (cur > fpSideHeightMax()) setFpSideHeight(fpSideHeightMax(), { save: true });
  });
  layoutView3d();
})();

// Modellorographie am Start für den Höhenabgleich Geoid vs. Ellipsoid;
// die Geländewerte entlang des Pfads liegen im Querschnitts-Zustand vor.
function view3dData() {
  return {
    runs: state.lastRuns.runs,
    start: state.start,
    modelElev: state.xsec?.runs?.[0]?.terrain?.[0] ?? state.startElevation,
  };
}

function hide3D() {
  el("view3d").hidden = true;
  el("view3dbtn").textContent = "3D-Ansicht";
}

el("view3dbtn").addEventListener("click", async () => {
  if (!el("view3d").hidden) return hide3D();
  if (!state.lastRuns?.runs?.length) return;
  el("view3dbtn").disabled = true;
  setStatus("Lade 3D-Ansicht …");
  try {
    view3dMod ??= await import("./view3d.js");
    el("view3d").hidden = false;
    layoutView3d();
    await view3dMod.show(view3dData());
    el("view3dbtn").textContent = "3D-Ansicht schließen";
    setStatus("");
  } catch (err) {
    hide3D();
    setStatus(`3D-Ansicht: ${err.message}`, true);
  } finally {
    el("view3dbtn").disabled = false;
  }
});
el("v3d-close").addEventListener("click", hide3D);

// --- Export (GeoJSON / GPX / KML) -------------------------------------------
const DOWNLOAD_FORMATS = {
  geojson: { ext: "geojson", type: "application/geo+json", build: (d) => JSON.stringify(buildGeoJSON(d)) },
  gpx: { ext: "gpx", type: "application/gpx+xml", build: buildGPX },
  kml: { ext: "kml", type: "application/vnd.google-earth.kml+xml", build: buildKML },
};

el("download").addEventListener("click", () => {
  if (!state.lastRuns) return;
  const fmt = DOWNLOAD_FORMATS[el("downloadfmt").value] ?? DOWNLOAD_FORMATS.geojson;
  const blob = new Blob([fmt.build(state.lastRuns)], { type: fmt.type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const stamp = new Date(state.lastRuns.t0Ms).toISOString().slice(0, 16)
    .replace(/[-:]/g, "").replace("T", "_");
  a.download = `trajektorien_${state.lastRuns.modelKey}_${stamp}Z.${fmt.ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/** Trackname mit Start- und Zielhöhe (AMSL, in Metern wie die Höhenwerte in
 *  der Datei). Vorwärts: Start → Ziel; rückwärts: Ankunft ← Herkunft. */
function trackName({ r, label }, direction) {
  const m = (z) => Number.isFinite(z) ? `${Math.round(z)} m` : "?";
  const z0 = m(r.points[0]?.z);
  const zEnd = m(r.points.at(-1)?.z);
  return direction > 0
    ? `${label} · Start ${z0} → Ziel ${zEnd}`
    : `${label} · Ziel ${z0} ← Herkunft ${zEnd}`;
}

function xmlEsc(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

function buildGeoJSON({ runs, modelKey, mode, t0Ms, duration, direction }) {
  const rd = (x) => Math.round(x * 1e5) / 1e5;
  const round1 = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
  const iso = (ms) => new Date(ms).toISOString();
  const coord = (p) => Number.isFinite(p.z)
    ? [rd(p.lon), rd(p.lat), Math.round(p.z)]
    : [rd(p.lon), rd(p.lat)];
  const features = [];
  for (const { r, color, label, heightM, method } of runs) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: r.points.map(coord) },
      properties: {
        kind: "trajectory",
        label,
        start_height_m: heightM,
        height_reference: mode,
        vertical_motion: method,
        model: modelKey,
        direction: direction > 0 ? "forward" : "backward",
        start_time: iso(t0Ms),
        end_time: iso(r.points.at(-1).tMs),
        duration_requested_h: duration,
        status: r.status,
        stop_reason: r.reason,
        color,
        stroke: color,
        "stroke-width": 2,
        times: r.points.map((p) => iso(p.tMs)),
      },
    });
    for (const m of r.markers) {
      const spd = Math.hypot(m.u, m.v) * 3.6;
      const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coord(m) },
        properties: {
          kind: "marker",
          label,
          time: iso(m.tMs),
          wind_speed_kmh: Math.round(spd),
          wind_direction_deg: Math.round(dir),
          color,
          "marker-color": color,
          ...(m.met ? {
            temperature_c: round1(m.met.t),
            dewpoint_c: round1(m.met.td),
            relative_humidity_pct: Number.isFinite(m.met.rh) ? Math.round(m.met.rh) : null,
            pressure_hpa: round1(m.met.p),
          } : {}),
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** GPX 1.1 — jede Trajektorie als eigener <trk> mit Farbe (gpx_style-Extension,
 *  Hex; zusätzlich Garmins gpxx:DisplayColor als nächster Standardname). */
function buildGPX({ runs, modelKey, t0Ms, direction }) {
  const iso = (ms) => new Date(ms).toISOString();
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Windtrajektorien"' +
      ' xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"' +
      ' xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">',
    `  <metadata><name>Trajektorien ${xmlEsc(modelKey)}</name><time>${iso(t0Ms)}</time></metadata>`,
  ];
  for (const run of runs) {
    const hex = run.color.replace("#", "").toLowerCase();
    out.push("  <trk>");
    out.push(`    <name>${xmlEsc(trackName(run, direction))}</name>`);
    out.push("    <extensions>");
    out.push(`      <gpx_style:line><gpx_style:color>${hex}</gpx_style:color></gpx_style:line>`);
    out.push(`      <gpxx:TrackExtension><gpxx:DisplayColor>${gpxNamedColor(run.color)}</gpxx:DisplayColor></gpxx:TrackExtension>`);
    out.push("    </extensions>");
    out.push("    <trkseg>");
    for (const p of run.r.points) {
      const ele = Number.isFinite(p.z) ? `<ele>${Math.round(p.z)}</ele>` : "";
      out.push(`      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}<time>${iso(p.tMs)}</time></trkpt>`);
    }
    out.push("    </trkseg>");
    out.push("  </trk>");
  }
  out.push("</gpx>");
  return out.join("\n");
}

/** KML — jede Trajektorie als eigenes Placemark mit eigenem LineStyle (Farbe
 *  als aabbggrr). Höhen absolut (AMSL); tessellate für saubere Bodenprojektion. */
function buildKML({ runs, modelKey, direction }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>Trajektorien ${xmlEsc(modelKey)}</name>`,
  ];
  for (const run of runs) {
    const pts = run.r.points;
    const has3d = pts.some((p) => Number.isFinite(p.z));
    // Fehlende Höhen (z == null) mit dem nächstbekannten Wert füllen, damit im
    // absoluten Modus kein Ausreißer auf Meereshöhe entsteht.
    const zFill = pts.map((p) => p.z);
    for (let i = 1; i < zFill.length; i++) if (!Number.isFinite(zFill[i])) zFill[i] = zFill[i - 1];
    for (let i = zFill.length - 2; i >= 0; i--) if (!Number.isFinite(zFill[i])) zFill[i] = zFill[i + 1];
    const coords = pts
      .map((p, i) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)},${Number.isFinite(zFill[i]) ? Math.round(zFill[i]) : 0}`)
      .join(" ");
    out.push("    <Placemark>");
    out.push(`      <name>${xmlEsc(trackName(run, direction))}</name>`);
    out.push(`      <Style><LineStyle><color>${kmlColor(run.color)}</color><width>3</width></LineStyle></Style>`);
    out.push("      <LineString>");
    out.push(`        <altitudeMode>${has3d ? "absolute" : "clampToGround"}</altitudeMode>`);
    out.push("        <tessellate>1</tessellate>");
    out.push(`        <coordinates>${coords}</coordinates>`);
    out.push("      </LineString>");
    out.push("    </Placemark>");
  }
  out.push("  </Document>", "</kml>");
  return out.join("\n");
}

/** #rrggbb → KML-Farbe aabbggrr (voll deckend). */
function kmlColor(hex) {
  const h = hex.replace("#", "");
  return `ff${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toLowerCase();
}

/** Nächster der 16 Garmin-Standardfarbnamen zu #rrggbb (für gpxx:DisplayColor,
 *  das nur benannte Farben kennt). Der exakte Hex steckt in gpx_style:color. */
function gpxNamedColor(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const palette = [
    ["Black", 0, 0, 0], ["DarkRed", 139, 0, 0], ["DarkGreen", 0, 100, 0],
    ["DarkYellow", 139, 139, 0], ["DarkBlue", 0, 0, 139], ["DarkMagenta", 139, 0, 139],
    ["DarkCyan", 0, 139, 139], ["LightGray", 211, 211, 211], ["DarkGray", 105, 105, 105],
    ["Red", 255, 0, 0], ["Green", 0, 255, 0], ["Yellow", 255, 255, 0],
    ["Blue", 0, 0, 255], ["Magenta", 255, 0, 255], ["Cyan", 0, 255, 255], ["White", 255, 255, 255],
  ];
  let best = "DarkGray", bestD = Infinity;
  for (const [name, pr, pg, pb] of palette) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// --- Helfer -----------------------------------------------------------------
function colorFor(heightM) {
  return heightColors.get(heightM) || "#0b0b0b";
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function setStatus(msg, isError = false) {
  el("status").textContent = msg;
  el("status").className = isError ? "error" : "";
}

loadMeta();
