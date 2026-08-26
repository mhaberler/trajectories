import {
  TRAJECTORY_API, MODELS, modelApiBase, modelForecastUrl, SERIES_COLORS, DEFAULT_HEIGHTS,
  HEIGHT_MIN, HEIGHT_MAX, MARKER_INTERVALS, METHODS,
  OM_PUBLIC_FORECAST, OM_PRESSURE_LEVELS_HPA,
} from "./config.js";
import { WindField } from "./windfield.js";
import { computeTrajectory } from "./integrator.js";
import { renderCrossSection } from "./crosssection";
import {
  setUnits, unitState, fmtHeight, fmtWind, heightUnit,
  heightToDisplay, heightFromDisplay, heightSliderCfg,
} from "./units";
import { initGeocode, reversePlaceName } from "./geocode.js";
import { expandProfile } from "./profileExpand.js";
import { trackSampleKey } from "./dem/mapterhorn.js";
import { createTimebar } from "./timebar.js";
import {
  computeMorphRuns as computeMorphRunsAt,
} from "./launchMorph.js";

// Konsolen-Monitor: ?debug=1 an der URL oder localStorage.trajDebug = "1".
const DEBUG = new URLSearchParams(location.search).has("debug") ||
  localStorage.getItem("trajDebug") === "1";

const API_BACKENDS = new Set(["auto", "http", "om"]);
const apiBackendParam = new URLSearchParams(location.search).get("backend");
const apiBackend = API_BACKENDS.has(apiBackendParam) ? apiBackendParam : "auto";
console.log(
  "[traj] API backend",
  apiBackend,
  apiBackendParam == null ? "(default, no ?backend=)" : `(?backend=${apiBackendParam})`,
);

/* global L */

const el = (id) => document.getElementById(id);

/** @type {ReturnType<typeof createTimebar> | null} */
let timebar = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let bandCommitTimer = null;
/** Bumps to cancel in-flight start elevation / model-level probes. */
let modelLevelProbeGen = 0;

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
    launchWindowH: liveUiStash
      ? liveUiStash.launchWindowH
      : Math.min(12, Math.max(0, +el("launchwindow").value || 0)),
    launchStepMin: Math.max(5, +el("launchstep").value || 15),
    tStartMs: liveUiStash?.tStartMs ?? timebar?.startMs?.() ?? null,
    playMs: timebar?.playMs?.() ?? liveUiStash?.playMs ?? null,
    direction: el("direction").value,
    heights: [...heightColors].map(([m, color]) => ({ m, color })),
    activeHeight,
    barMax,
    start: state.start,
    startPlace: state.startPlace || null,
    view: { center: map.getCenter(), zoom: map.getZoom() },
    baseLayer: activeBaseLayer,
    units: { ...unitState },
    liveMode: el("livemode").checked,
    methods: selectedMethods(),
    metExtras: el("metextras").checked,
    liveSavedUseApi: liveUiStash ? liveUiStash.useApi : null,
    useApi: liveUiStash ? liveUiStash.useApi : el("useapi").checked,
    profileTargets: profileTargets.map((w) => {
      const o = { tSec: w.tSec, targetAgl: w.targetAgl };
      if (Number.isFinite(w.targetAmsl)) o.targetAmsl = w.targetAmsl;
      return o;
    }),
    profilePreset: el("fp-preset").value,
    savedProfiles: savedProfiles.map((p) => ({
      id: p.id,
      name: p.name,
      targets: p.targets.map((w) => {
        const o = { tSec: w.tSec, targetAgl: w.targetAgl };
        if (Number.isFinite(w.targetAmsl)) o.targetAmsl = w.targetAmsl;
        return o;
      }),
    })),
    panelWidth: Math.round(el("panel").getBoundingClientRect().width),
    fpSideHeight: Math.round(el("fp-side").getBoundingClientRect().height) || 110,
    fpTableVisible: !el("fp-table-block")?.hidden,
    fpDemOverlay: !!el("fp-dem")?.checked,
    xsecDem: !!el("xsec-dem")?.checked,
    xsecHeight,
    xsecRight,
    downloadFmt: el("downloadfmt").value,
    exportOpts,
    exportOptsRev: EXPORT_OPTS_REV,
    filenamePattern,
    shareGithub: { ...shareGithub },
    fpDemIntervalMin: clampDemIntervalMin(+el("fp-dem-interval")?.value),
    fpInheritMode: profileInheritMode(),
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

// Basiskarten: OSM, OpenTopo und Esri-Hybrid. Die Wahl wird mitgespeichert.
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
let activeBaseLayer = baseLayers[saved.baseLayer] ? saved.baseLayer : "OpenStreetMap";
baseLayers[activeBaseLayer].addTo(map);
L.control.layers(baseLayers, null, { position: "topleft" }).addTo(map);
map.on("baselayerchange", (e) => {
  activeBaseLayer = e.name;
  persist();
});

// --- Export-Einstellungen ---------------------------------------------------
const EXPORT_DEFAULTS = {
  html: {
    markers: true,
    markerRadius: 5,
    lineWidth: 3,
    lineOpacity: 0.85,
    profile: false,
    profileHeight: 200,
    baseOpacity: 1,
    defaultBase: "OpenStreetMap",
    tracklist: true,
    legendHtml: "",
    defaultView: "2d",
    exaggeration: 1.5,
    /** 3D-Kartengrundlage (esri|osm|opentopo); mit App-3D synchron. */
    defaultImagery: "esri",
  },
  kml: {
    markers: true, iconScale: 1.6, labelScale: 0.7, lineWidth: 3,
    clampToGround: false, hideLabels: true,
  },
  gpx: { markersAsWaypoints: false },
  geojson: { precision: 5 },
};

/** id, Format, Schlüssel, Art — eine Zeile je Bedienelement im Dialog. */
const EXPORT_FIELDS = [
  ["ex-html-markers", "html", "markers", "bool"],
  ["ex-html-markerradius", "html", "markerRadius", "num"],
  ["ex-html-linewidth", "html", "lineWidth", "num"],
  ["ex-html-lineopacity", "html", "lineOpacity", "num"],
  ["ex-html-profile", "html", "profile", "bool"],
  ["ex-html-profileheight", "html", "profileHeight", "num"],
  ["ex-html-baseopacity", "html", "baseOpacity", "num"],
  ["ex-html-defaultbase", "html", "defaultBase", "text"],
  ["ex-html-tracklist", "html", "tracklist", "bool"],
  ["ex-html-legend", "html", "legendHtml", "text"],
  ["ex-html-defaultview", "html", "defaultView", "text"],
  ["ex-html-exaggeration", "html", "exaggeration", "num"],
  ["ex-kml-markers", "kml", "markers", "bool"],
  ["ex-kml-hidelabels", "kml", "hideLabels", "bool"],
  ["ex-kml-iconscale", "kml", "iconScale", "num"],
  ["ex-kml-labelscale", "kml", "labelScale", "num"],
  ["ex-kml-linewidth", "kml", "lineWidth", "num"],
  ["ex-kml-clamp", "kml", "clampToGround", "bool"],
  ["ex-gpx-wpt", "gpx", "markersAsWaypoints", "bool"],
  ["ex-geojson-precision", "geojson", "precision", "num"],
];

/** Bump when an export default flips and old localStorage must not keep the prior value. */
const EXPORT_OPTS_REV = 3; // 3: html.exaggeration default 1.5 (was 3)

function mergeExportOpts(stored, rev = 0) {
  const out = {};
  for (const [fmt, def] of Object.entries(EXPORT_DEFAULTS)) {
    out[fmt] = { ...def, ...(stored?.[fmt] || {}) };
  }
  // Einmalig: gespeichertes profile:true stammte vom alten Default, nicht
  // zwingend von einer bewussten Wahl — nach Rev-Bump auf den neuen Default.
  if (rev < 2 && out.html) out.html.profile = false;
  // Einmalig: Überhöhung auf 1.5 (alter Default 3; Zwischenspeicher oft 2–3).
  if (rev < 3 && out.html) out.html.exaggeration = 1.5;
  return out;
}

// Querschnitt: Maße des Panels. Hier oben, weil persist() sie liest.
const XSEC_EDGE = 10;
// renderCrossSection zeichnet nie kleiner als 320×120; das Panel muss den
// Kopf (~33 px) zusätzlich unterbringen, sonst ragt das SVG darüber hinaus.
const XSEC_MIN_H = 155;
const XSEC_MIN_W = 320;

/** Vom Nutzer gezogene Maße; null = automatisch aus der Streifenzahl. */
let xsecHeight = Number.isFinite(saved.xsecHeight) ? saved.xsecHeight : null;
let xsecRight = Number.isFinite(saved.xsecRight) ? saved.xsecRight : null;

// Bewusst als JS-Objekt geführt statt bei jedem persist() aus dem DOM gelesen
// wie der Rest: `legendHtml` steckt in einem Textfeld, das nie geöffnet
// worden sein muss — über das DOM ginge der Wert vorher verloren.
const exportOpts = mergeExportOpts(saved.exportOpts, saved.exportOptsRev || 0);

/** Dateinamen-Muster für alle Exportformate (Download + Share). */
const DEFAULT_FILENAME_PATTERN = "{ymd}_{hm}Z_{place}_{duration}_{model}";
let filenamePattern = typeof saved.filenamePattern === "string" && saved.filenamePattern.trim()
  ? saved.filenamePattern.trim()
  : DEFAULT_FILENAME_PATTERN;

/** 3D-Kartenwahl der App → Default für HTML-Export-3D. */
const IMAGERY_KINDS = ["esri", "osm", "opentopo"];
try {
  const v3d = JSON.parse(localStorage.getItem("trajectories.view3d.v1") || "{}");
  if (IMAGERY_KINDS.includes(v3d?.imagery)) exportOpts.html.defaultImagery = v3d.imagery;
} catch {
  /* ignore */
}
window.addEventListener("traj-3d-imagery", (e) => {
  const kind = e?.detail;
  if (!IMAGERY_KINDS.includes(kind)) return;
  if (exportOpts.html.defaultImagery === kind) return;
  exportOpts.html.defaultImagery = kind;
  persist();
});

/** GitHub-Pages-Teilen: PAT/Repo nur im Browser (localStorage). */
const SHARE_GITHUB_DEFAULTS = {
  owner: "mhaberler",
  repo: "trajectories",
  branch: "gh-pages",
  pagesBase: "",
  token: "",
  pagesBaseCustom: false,
};
function mergeShareGithub(stored) {
  const s = { ...SHARE_GITHUB_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  s.owner = String(s.owner || SHARE_GITHUB_DEFAULTS.owner).trim() || SHARE_GITHUB_DEFAULTS.owner;
  s.repo = String(s.repo || SHARE_GITHUB_DEFAULTS.repo).trim() || SHARE_GITHUB_DEFAULTS.repo;
  s.branch = String(s.branch || SHARE_GITHUB_DEFAULTS.branch).trim() || SHARE_GITHUB_DEFAULTS.branch;
  s.token = String(s.token || "");
  s.pagesBase = String(s.pagesBase || "");
  s.pagesBaseCustom = !!s.pagesBaseCustom;
  return s;
}
const shareGithub = mergeShareGithub(saved.shareGithub);

function defaultSharePagesBase(owner, repo) {
  const o = String(owner || "").trim();
  const r = String(repo || "").trim();
  if (!o || !r) return "";
  return `https://${o}.github.io/${r}/`;
}

function applyShareGithubUI() {
  const tok = el("ex-share-token");
  const owner = el("ex-share-owner");
  const repo = el("ex-share-repo");
  const branch = el("ex-share-branch");
  const base = el("ex-share-pagesbase");
  if (!tok || !owner || !repo || !branch || !base) return;
  tok.value = shareGithub.token;
  owner.value = shareGithub.owner;
  repo.value = shareGithub.repo;
  branch.value = shareGithub.branch;
  base.value = shareGithub.pagesBaseCustom && shareGithub.pagesBase
    ? shareGithub.pagesBase
    : defaultSharePagesBase(shareGithub.owner, shareGithub.repo);
}

function readShareGithubUI() {
  const tok = el("ex-share-token");
  const owner = el("ex-share-owner");
  const repo = el("ex-share-repo");
  const branch = el("ex-share-branch");
  const base = el("ex-share-pagesbase");
  if (!tok || !owner || !repo || !branch || !base) return;
  shareGithub.token = tok.value;
  shareGithub.owner = owner.value.trim() || SHARE_GITHUB_DEFAULTS.owner;
  shareGithub.repo = repo.value.trim() || SHARE_GITHUB_DEFAULTS.repo;
  shareGithub.branch = branch.value.trim() || SHARE_GITHUB_DEFAULTS.branch;
  const auto = defaultSharePagesBase(shareGithub.owner, shareGithub.repo);
  const typed = base.value.trim();
  if (!typed || typed === auto) {
    shareGithub.pagesBaseCustom = false;
    shareGithub.pagesBase = "";
    if (base.value !== auto) base.value = auto;
  } else {
    shareGithub.pagesBaseCustom = true;
    shareGithub.pagesBase = typed.endsWith("/") ? typed : `${typed}/`;
  }
}

function setDownloadEnabled(on) {
  el("download").disabled = !on;
  const shareBtn = el("sharehtml");
  if (shareBtn) shareBtn.disabled = !on;
}


const state = {
  start: null,
  meta: null, // {t0, t1} Epochensekunden des verfügbaren Zeitraums
  // Live-Modus: die „gepinnten" (inaktiven) Trajektorien bleiben stehen,
  // während nur die aktive Linie live neu gezeichnet wird. pinLayers wird
  // zuerst zur Karte gefügt, damit die aktive Linie (layers) darüber liegt.
  dimLayers: L.layerGroup().addTo(map), // Geschwister-Tracks im Profil-Edit (stark gedimmt)
  pinLayers: L.layerGroup().addTo(map),
  layers: L.layerGroup().addTo(map),
  overlayLayers: L.layerGroup().addTo(map), // importierte Flugspuren
  /** @type {Map<string, { run: object, layer: object, bounds: object|null }>} */
  runMapTracks: new Map(),
  /** @type {Set<string>} */
  hiddenRunKeys: new Set(),
  pinRuns: new Map(), // Höhe(m) -> berechneter Run, damit Pins beim Scrubben nicht neu rechnen
  pinKey: "",         // Satz der aktuell gezeichneten Pin-Höhen (für „nur bei Änderung neu zeichnen")
  startMarker: null,
  running: false,
  profileEdit: null, // { active, candidateKey, siblingRuns, t0Ms }
  profileRedrawGen: 0,
  launchWindowGen: 0,
  /** @type {null | { tStartMs: number, tEndMs: number, stepMs: number, samples: { t0Ms: number, runs: object[] }[] }} */
  launchWindow: null,
  selectedRunKey: null, // ausgewählter Lauf für den Querschnitt (runKey)
  startElevation: null, // Modellorographie am Start (m NN)
  // ICON-Modelllevel (geometrisch) am Start: { …, levels: [{ n, hAgl }] }
  modelLevelProbe: null,
  // Isobaren von api.open-meteo.com: { …, levels: [{ hPa, zAmsl }] }
  pressureLevelProbe: null,
  // Importierte Flugspuren (Session): { id, name, color, note, sourceName, visible, coords }
  overlays: [],
  /** Ortsname von Geocode-Auswahl (kurz); null = Kartenklick / unbekannt. */
  startPlace: null,
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
const FP_SAVED_MAX = 20;
const FP_PRESETS = {
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

function profileDurationHours() {
  return Math.min(72, Math.max(0.25, +el("duration").value || 12));
}

function profileDurationSec() {
  return profileDurationHours() * 3600;
}

function defaultConstantTargets() {
  const h = activeHeight != null ? activeHeight : 500;
  return [
    { tSec: 0, targetAgl: h },
    { tSec: profileDurationSec(), targetAgl: h },
  ];
}

function cloneTargets(list) {
  return list.map((w) => {
    /** @type {{ tSec: number, targetAgl: number, targetAmsl?: number }} */
    const out = {
      tSec: +w.tSec,
      targetAgl: Math.max(0, +(w.targetAgl ?? w.hAgl)),
    };
    if (Number.isFinite(+w.targetAmsl)) out.targetAmsl = Math.max(0, +w.targetAmsl);
    return out;
  });
}

/** @type {{ tSec: number, targetAgl: number, targetAmsl?: number }[]} */
let profileTargets = cloneTargets(FP_PRESETS.climbcruise);

/** @type {{ id: string, name: string, targets: { tSec: number, targetAgl: number, targetAmsl?: number }[] }[]} */
let savedProfiles = [];

function normalizeSavedProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (!p || typeof p.name !== "string") continue;
    const name = p.name.trim().slice(0, 40);
    if (!name) continue;
    const targets = cloneTargets(Array.isArray(p.targets) ? p.targets : []);
    if (validateProfileTargets(targets)) continue;
    out.push({
      id: typeof p.id === "string" && p.id ? p.id : `p-${Date.now()}-${out.length}`,
      name,
      targets,
    });
    if (out.length >= FP_SAVED_MAX) break;
  }
  return out;
}

function renderSavedProfileSelect(selectId = null) {
  const sel = el("fp-saved");
  if (!sel) return;
  const keep = selectId ?? sel.value;
  sel.replaceChildren();
  if (!savedProfiles.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— keine gespeichert —";
    sel.appendChild(opt);
    sel.disabled = true;
    el("fp-apply-saved").disabled = true;
    el("fp-del-saved").disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of savedProfiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (keep && savedProfiles.some((p) => p.id === keep)) sel.value = keep;
  el("fp-apply-saved").disabled = false;
  el("fp-del-saved").disabled = false;
}

function saveCurrentProfile() {
  const name = (el("fp-save-name").value || "").trim().slice(0, 40);
  if (!name) {
    setStatus("Bitte einen Namen für das Profil eingeben.", true);
    return;
  }
  const err = validateProfileTargets(profileTargets);
  if (err) {
    setStatus(err, true);
    return;
  }
  const targets = cloneTargets(profileTargets);
  const key = name.toLowerCase();
  const existing = savedProfiles.find((p) => p.name.toLowerCase() === key);
  if (existing) {
    existing.targets = targets;
    existing.name = name;
    renderSavedProfileSelect(existing.id);
  } else {
    if (savedProfiles.length >= FP_SAVED_MAX) {
      setStatus(`Maximal ${FP_SAVED_MAX} gespeicherte Profile.`, true);
      return;
    }
    const id = `p-${Date.now()}`;
    savedProfiles.push({ id, name, targets });
    savedProfiles.sort((a, b) => a.name.localeCompare(b.name, "de"));
    renderSavedProfileSelect(id);
  }
  el("fp-save-name").value = name;
  persist();
  setStatus(`Profil „${name}“ gespeichert.`);
}

function applySavedProfile() {
  const id = el("fp-saved").value;
  const hit = savedProfiles.find((p) => p.id === id);
  if (!hit) return;
  state.profileEdit = null;
  profileTargets = cloneTargets(hit.targets);
  el("fp-save-name").value = hit.name;
  refreshProfileUI({ scheduleApi: true });
  el("fp-candhint").textContent = `Gespeichertes Profil „${hit.name}“ übernommen.`;
}

function deleteSavedProfile() {
  const id = el("fp-saved").value;
  const hit = savedProfiles.find((p) => p.id === id);
  if (!hit) return;
  if (!confirm(`Profil „${hit.name}“ löschen?`)) return;
  savedProfiles = savedProfiles.filter((p) => p.id !== id);
  renderSavedProfileSelect();
  persist();
  setStatus(`Profil „${hit.name}“ gelöscht.`);
}

function runKey(run) {
  return `${run.heightM}|${run.method}|${run.label}`;
}

function applyProfilePreset(key) {
  state.profileEdit = null;
  if (key === "constant") profileTargets = defaultConstantTargets();
  else if (key === "empty") profileTargets = cloneTargets(FP_PRESETS.empty);
  else profileTargets = cloneTargets(FP_PRESETS.climbcruise);
  refreshProfileUI({ scheduleApi: false });
  el("fp-candhint").textContent = "";
}

function setFpTableVisible(visible, { save = false } = {}) {
  const block = el("fp-table-block");
  const btn = el("fp-table-toggle");
  if (!block || !btn) return;
  const on = !!visible;
  block.hidden = !on;
  btn.setAttribute("aria-expanded", on ? "true" : "false");
  btn.title = on ? "Tabelle ausblenden" : "Tabelle einblenden";
  btn.setAttribute("aria-label", on ? "Tabelle ausblenden" : "Tabelle einblenden");
  if (save) persist();
}

/** Display AMSL for a waypoint (informational; not an editable table field). */
function profileTableAmslText(w) {
  const amsl = waypointAmsl(w);
  if (amsl == null) return "–";
  const unit = heightUnit();
  return `${Math.round(heightToDisplay(amsl))} ${unit === "ft" ? "ft" : "m"}`;
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
    const tdAmsl = document.createElement("td");
    tdAmsl.className = "fp-amsl-cell hint mono";
    tdAmsl.dataset.field = "amsl";
    tdAmsl.title = "NN-Höhe (aus AGL + Gelände; nicht gespeichert)";
    tdAmsl.textContent = profileTableAmslText(w);
    tr.appendChild(tdT);
    tr.appendChild(tdH);
    tr.appendChild(tdAmsl);
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
    /** @type {{ tSec: number, targetAgl: number, targetAmsl?: number }} */
    const row = {
      tSec: Math.max(0, Math.round(min * 60)),
      targetAgl: Math.max(0, Math.round(heightFromDisplay(hDisp))),
    };
    const prevAmsl = profileTargets[i]?.targetAmsl;
    if (Number.isFinite(prevAmsl)) row.targetAmsl = prevAmsl;
    next.push(row);
  }
    if (next.length >= 2) {
      profileTargets = next;
      for (let i = 0; i < profileTargets.length; i++) {
        const tSec = clampProfileTime(i, profileTargets[i].tSec);
        if (tSec !== profileTargets[i].tSec) {
          profileTargets[i] = { ...profileTargets[i], tSec };
        }
      }
    }
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
    `${profileTargets.length} Punkte · bis ${lastH.toFixed(lastH < 10 ? 1 : 0)} h`;
  hint.classList.remove("error");
}

/** Mean vertical rate (m/s AGL) between two waypoints; null if dt≤0. */
function segmentMeanRate(iFrom, iTo) {
  const a = profileTargets[iFrom];
  const b = profileTargets[iTo];
  if (!a || !b) return null;
  const dt = b.tSec - a.tSec;
  if (!(dt > 0)) return null;
  return (b.targetAgl - a.targetAgl) / dt;
}

function fmtVertRate(rMs) {
  if (rMs == null || !Number.isFinite(rMs)) return "–";
  if (Math.abs(rMs) < 0.05) return "0 m/s";
  const sign = rMs > 0 ? "+" : "";
  return `${sign}${rMs.toFixed(1)} m/s`;
}

/** Live Δh/Δt of legs touching waypoint i (previous ← · → next), plus current time. */
function updateSegmentRateHint(i) {
  const box = el("fp-side-rates");
  if (!box) return;
  const w = profileTargets[i];
  if (!w) {
    box.textContent = "";
    return;
  }
  const parts = [`t = ${Math.round(w.tSec / 60)} min`];
  const rates = [];
  if (i > 0) rates.push(`← ${fmtVertRate(segmentMeanRate(i - 1, i))}`);
  if (i < profileTargets.length - 1) rates.push(`${fmtVertRate(segmentMeanRate(i, i + 1))} →`);
  if (rates.length) parts.push(`Vertikalrate ${rates.join(" · ")}`);
  box.textContent = parts.join(" · ");
}

function clearSegmentRateHint() {
  const box = el("fp-side-rates");
  if (box) box.textContent = "";
}

const SIDE_HOVER_MS = 450;
/** @type {{ kind: 'seg'|'pt'|null, i: number|null, timer: number, x: number, y: number, visible: boolean }} */
let sideHover = { kind: null, i: null, timer: 0, x: 0, y: 0, visible: false };

/** Mean vertical rate (m/s AGL) on expanded profile segment i → i+1. */
function expandedSegmentRate(expanded, i) {
  const a = expanded[i];
  const b = expanded[i + 1];
  if (!a || !b) return null;
  const dt = b.tSec - a.tSec;
  if (!(dt > 0)) return null;
  return (b.hAgl - a.hAgl) / dt;
}

/** Nearest marker on run to profile-relative tSec (includes wind/met when present). */
function markerNearProfileTime(run, tSec) {
  const marks = run?.r?.markers;
  if (!marks?.length || !run.r.points?.length) return null;
  const t0 = run.r.points[0].tMs;
  let best = null;
  let bestD = Infinity;
  for (const m of marks) {
    if (m.synthetic) continue;
    const mt = (m.tMs - t0) / 1000;
    const d = Math.abs(mt - tSec);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/** Map-style context for profile waypoint i (position + nearest met). */
function profileWaypointContext(run, i) {
  const w = profileTargets[i];
  if (!w || !run?.r?.points?.length) return null;
  const r = run.r;
  const t0 = r.points[0].tMs;
  const pos = pointAtTimeOnPath(r, w.tSec);
  let nearestMet = null;
  let bestD = Infinity;
  for (const m of r.markers || []) {
    const d = Math.abs(m.tMs - (t0 + w.tSec * 1000));
    if (d < bestD) {
      bestD = d;
      nearestMet = m;
    }
  }
  return {
    lat: pos?.lat,
    lon: pos?.lon,
    z: pos?.z,
    tSec: w.tSec,
    targetAgl: w.targetAgl,
    u: nearestMet?.u,
    v: nearestMet?.v,
    met: bestD < 120_000 ? nearestMet?.met : undefined,
  };
}

function appendWindMetRows(rows, m) {
  if (m && Number.isFinite(m.u) && Number.isFinite(m.v)) {
    const dir = (Math.atan2(-(m.u || 0), -(m.v || 0)) * 180 / Math.PI + 360) % 360;
    rows.push({ label: "Wind", value: `${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°` });
  }
  if (m?.met) {
    if (Number.isFinite(m.met.t)) rows.push({ label: "T", value: `${m.met.t.toFixed(1)} °C` });
    if (Number.isFinite(m.met.td)) rows.push({ label: "Td", value: `${m.met.td.toFixed(1)} °C` });
    if (Number.isFinite(m.met.rh)) rows.push({ label: "RH", value: `${Math.round(m.met.rh)} %` });
    if (Number.isFinite(m.met.p)) rows.push({ label: "p", value: `${m.met.p.toFixed(0)} hPa` });
  }
}

/** @returns {{ label: string, value: string }[]} */
function segmentHoverRows(expanded, i) {
  const a = expanded[i];
  const b = expanded[i + 1];
  if (!a || !b) return [];
  const dt = b.tSec - a.tSec;
  const dh = b.hAgl - a.hAgl;
  const rate = expandedSegmentRate(expanded, i);
  /** @type {{ label: string, value: string }[]} */
  const rows = [
    { label: "Zeit", value: `${Math.round(a.tSec / 60)}–${Math.round(b.tSec / 60)} min` },
    { label: "Vertikalrate", value: fmtVertRate(rate) },
  ];
  if (Number.isFinite(dh) && dt > 0) {
    const sign = dh > 0 ? "+" : "";
    rows.push({ label: "Δh", value: `${sign}${Math.round(dh)} m` });
  }
  return rows;
}

/** @returns {{ label: string, value: string }[]} */
function markerHoverRows(i, run) {
  const w = profileTargets[i];
  if (!w) return [];
  /** @type {{ label: string, value: string }[]} */
  const rows = [
    { label: "Zeit", value: `${Math.round(w.tSec / 60)} min` },
    { label: "Höhe AGL", value: fmtHeight(w.targetAgl) },
  ];
  const ctx = profileWaypointContext(run, i);
  if (ctx) {
    if (Number.isFinite(ctx.z)) rows.push({ label: "Höhe NN", value: fmtHeight(ctx.z) });
    appendWindMetRows(rows, ctx);
    if (Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon)) {
      rows.push({ label: "Pos", value: `${ctx.lat.toFixed(4)}°N ${ctx.lon.toFixed(4)}°E` });
    }
  }
  return rows;
}

function ensureSideHoverTip() {
  let tip = el("fp-side-tip");
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "fp-side-tip";
  tip.className = "fp-side-tip mono";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  return tip;
}

function hideSideHoverTip() {
  const tip = el("fp-side-tip");
  if (tip) {
    tip.hidden = true;
    tip.innerHTML = "";
  }
  sideHover.visible = false;
}

function positionSideHoverTip(clientX, clientY) {
  const tip = el("fp-side-tip");
  if (!tip || tip.hidden) return;
  const pad = 12;
  const ox = 14;
  const oy = 16;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = clientX + ox;
  let top = clientY + oy;
  if (left + tw + pad > window.innerWidth) left = clientX - tw - ox;
  if (top + th + pad > window.innerHeight) top = clientY - th - oy;
  left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - th - pad));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showSideHoverRows(rows) {
  if (!rows.length) {
    hideSideHoverTip();
    return;
  }
  const tip = ensureSideHoverTip();
  tip.innerHTML =
    `<table><tbody>` +
    rows.map((r) =>
      `<tr><th>${r.label}</th><td>${r.value}</td></tr>`
    ).join("") +
    `</tbody></table>`;
  tip.hidden = false;
  sideHover.visible = true;
  positionSideHoverTip(sideHover.x, sideHover.y);
}

function showSegmentHoverHint(segI) {
  const expanded = sideViewGeom?.expanded;
  if (!expanded || segI < 0 || segI >= expanded.length - 1) {
    hideSideHoverTip();
    return;
  }
  showSideHoverRows(segmentHoverRows(expanded, segI));
}

function showMarkerHoverHint(ptI) {
  if (ptI < 0 || ptI >= profileTargets.length) {
    hideSideHoverTip();
    return;
  }
  showSideHoverRows(markerHoverRows(ptI, profileCandidateRun()));
}

function cancelSideHover({ clearHint = false } = {}) {
  if (sideHover.timer) {
    clearTimeout(sideHover.timer);
    sideHover.timer = 0;
  }
  sideHover.kind = null;
  sideHover.i = null;
  if (clearHint) hideSideHoverTip();
}

/** @param {'seg'|'pt'} kind */
function scheduleSideHover(kind, i) {
  if (sideDrag) return;
  if (sideHover.kind === kind && sideHover.i === i) {
    if (!sideHover.timer) return; // already showing
    return; // timer already pending
  }
  if (sideHover.timer) clearTimeout(sideHover.timer);
  if (sideHover.kind != null) hideSideHoverTip();
  sideHover.kind = kind;
  sideHover.i = i;
  sideHover.timer = setTimeout(() => {
    sideHover.timer = 0;
    if (sideDrag || sideHover.kind !== kind || sideHover.i !== i) return;
    if (kind === "seg") showSegmentHoverHint(i);
    else showMarkerHoverHint(i);
  }, SIDE_HOVER_MS);
}

/**
 * Clamp waypoint time: start fixed at 0; others strictly between neighbors (±1 s gap).
 * Last point cannot pass the Dauer field (seconds).
 */
function clampProfileTime(i, tSec) {
  if (i === 0) return 0;
  let t = Math.max(0, Math.round(tSec));
  const prev = profileTargets[i - 1]?.tSec ?? 0;
  const next = i < profileTargets.length - 1 ? profileTargets[i + 1].tSec : null;
  const lo = prev + 1;
  const hi = next != null ? next - 1 : profileDurationSec();
  if (hi < lo) return prev + 1; // degenerate gap — stay just after prev
  return Math.min(hi, Math.max(lo, t));
}

/** @type {{ tMax: number, hMin: number, hMax: number, pad: object, iw: number, ih: number, W: number, H: number, terrain: { tSec: number, z: number }[], useAmsl: boolean, expanded?: { tSec: number, hAgl: number }[] } | null} */
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

function clampDemIntervalMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(30, Math.max(0.5, Math.round(n * 2) / 2));
}

/** @type {{ key: string, series: { tSec: number, z: number }[], loading: boolean, error: string|null, gen: number }} */
const demHiState = { key: "", series: [], loading: false, error: null, gen: 0 };
/** @type {AbortController | null} */
let demHiAbort = null;

/**
 * DEM-Cache des Querschnitts, je Lauf. Getrennt vom Flugprofil-Zustand
 * (`demHiState`), weil dort immer nur der Kandidatenlauf zählt, hier aber
 * mehrere Läufe gleichzeitig ein Profil behalten sollen — einmal geholt,
 * bleibt es beim Wechsel zwischen Tracks stehen.
 * @type {Map<string, { key: string, pendingKey: string, series: { tSec: number, z: number }[], loading: boolean, error: string|null, gen: number, abort: AbortController|null }>}
 */
const xsecDem = new Map();

function xsecDemEntry(runKeyStr) {
  let e = xsecDem.get(runKeyStr);
  if (!e) {
    e = { key: "", pendingKey: "", series: [], loading: false, error: null, gen: 0, abort: null };
    xsecDem.set(runKeyStr, e);
  }
  return e;
}

/** DEM im Flugprofil (Seitenansicht). */
function demOverlayEnabled() {
  return !!el("fp-dem")?.checked;
}

/** DEM im Querschnittsfenster — eigener Schalter, unabhängig vom Flugprofil. */
function xsecDemEnabled() {
  return !!el("xsec-dem")?.checked;
}

function demIntervalSec() {
  return clampDemIntervalMin(+el("fp-dem-interval")?.value) * 60;
}

function setDemStatus(msg) {
  const s = el("fp-dem-status");
  if (s) s.textContent = msg || "";
}

function updateDemLegend() {
  const leg = el("fp-side-legend")?.querySelector(".fp-leg-dem");
  if (leg) leg.hidden = !(demOverlayEnabled() && demHiState.series.length >= 2);
}

function attachDemHiToXsec() {
  if (!state.xsec) return;
  if (demOverlayEnabled() && demHiState.series.length >= 2) {
    state.xsec.terrainHi = demHiState.series;
  } else {
    delete state.xsec.terrainHi;
  }
  drawCrossSection();
}

/**
 * Querschnitt zeichnen — eine Höhe (Dropdown), optional mit DEM.
 * Einziger Renderpfad, damit Auswahl und DEM-Nachlieferung sich nicht
 * gegenseitig überschreiben.
 */
function drawCrossSection() {
  if (!state.xsec || el("xsec").hidden) return;
  syncXsecAltitudeOptions();
  const data = xsecViewData();
  if (!data) return;
  sizeCrossSection(data);
  renderCrossSection(el("xsec-body"), data);
}

function xsecAltitudeKey(run) {
  return `${run.heightM}|${run.method}`;
}

/** Keep #xsec-alt options in sync with current xsec runs. */
function syncXsecAltitudeOptions() {
  const sel = el("xsec-alt");
  if (!sel || !state.xsec?.runs?.length) return;
  const prev = sel.value;
  const keys = [];
  const seen = new Set();
  for (const run of state.xsec.runs) {
    const key = xsecAltitudeKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, label: run.label || `${run.heightM} m` });
  }
  const want = keys.map((k) => k.key).join("\0");
  const have = [...sel.options].map((o) => o.value).join("\0");
  if (want !== have) {
    sel.innerHTML = "";
    for (const k of keys) {
      const opt = document.createElement("option");
      opt.value = k.key;
      opt.textContent = k.label;
      sel.appendChild(opt);
    }
  }
  const fromSel = state.selectedRunKey
    ? state.xsec.runs.find((r) => runKey(r) === state.selectedRunKey)
    : null;
  const preferred = fromSel
    ? xsecAltitudeKey(fromSel)
    : (prev && keys.some((k) => k.key === prev) ? prev : keys[0]?.key);
  if (preferred) sel.value = preferred;
}

/** Der aktuell ausgewählte Lauf im Querschnitt, oder null. */
function selectedXsecRun() {
  if (!state.xsec) return null;
  const key = el("xsec-alt")?.value;
  if (key) {
    const byAlt = state.xsec.runs.find((run) => xsecAltitudeKey(run) === key);
    if (byAlt) return byAlt;
  }
  if (!state.selectedRunKey) return state.xsec.runs[0] || null;
  return state.xsec.runs.find((run) => runKey(run) === state.selectedRunKey) || state.xsec.runs[0] || null;
}

/**
 * Sicht auf `state.xsec`: immer eine Höhe (Dropdown); DEM aus dem Cache.
 */
function xsecViewData() {
  if (!state.xsec) return null;
  const sel = selectedXsecRun();
  if (!sel) return null;
  const withDem = (run) => {
    if (!xsecDemEnabled()) return run;
    const series = xsecDem.get(runKey(run))?.series;
    return series && series.length >= 2 ? { ...run, terrainHi: series } : run;
  };
  return { ...state.xsec, runs: [withDem(sel)], overlay: false };
}

async function fetchElevationLine(pts, intervalSec, signal) {
  const t0 = pts[0].tMs;
  const body = {
    points: pts.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      t_sec: (p.tMs - t0) / 1000,
    })),
    interval_sec: Math.max(15, intervalSec),
  };
  const resp = await fetch(`${TRAJECTORY_API}/v1/elevation/line`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.error) {
    throw new Error(data?.reason || `DEM HTTP ${resp.status}`);
  }
  const demBackend = data?.properties?.dem_backend;
  const demStats = data?.properties?.dem_stats;
  if (demBackend || (demStats && typeof demStats === "object")) {
    console.info("[dem]", demBackend || "?", demStats || {});
  }
  const feats = Array.isArray(data?.features) ? data.features : [];
  /** @type {{ tSec: number, z: number }[]} */
  const series = [];
  for (const f of feats) {
    const tSec = +f?.properties?.t_sec;
    const z = +f?.properties?.elevation;
    if (Number.isFinite(tSec) && Number.isFinite(z)) series.push({ tSec, z });
  }
  series.sort((a, b) => a.tSec - b.tSec);
  return series;
}

/**
 * DEM für einen Lauf des Querschnitts holen (einmalig, gecacht). Der
 * Cache-Schlüssel enthält den Pfad, damit ein neu gerechneter Lauf gleicher
 * Höhe kein veraltetes Profil erbt.
 */
async function ensureXsecDem(run) {
  const pts = run?.r?.points;
  if (!pts || pts.length < 2) return;
  const rk = runKey(run);
  const entry = xsecDemEntry(rk);
  const intervalSec = demIntervalSec();
  const key = `${rk}|${trackSampleKey(pts, intervalSec)}`;
  if (key === entry.key && entry.series.length >= 2) return;
  if (entry.loading && key === entry.pendingKey) return;

  entry.abort?.abort();
  const ac = new AbortController();
  entry.abort = ac;
  const gen = ++entry.gen;
  entry.loading = true;
  entry.error = null;
  entry.pendingKey = key;
  // Neuer Pfad: altes DEM verwerfen, sonst zeigt der Streifen fremden Boden.
  entry.series = [];
  entry.key = "";
  setXsecDemStatus("Gelände …");
  drawCrossSection();
  try {
    const series = await fetchElevationLine(pts, intervalSec, ac.signal);
    if (gen !== entry.gen) return;
    entry.key = key;
    entry.series = series;
    entry.loading = false;
    setXsecDemStatus(series.length >= 2 ? "" : "kein Gelände");
  } catch (err) {
    if (err?.name === "AbortError" || gen !== entry.gen) return;
    entry.loading = false;
    entry.error = err?.message || "Fehler";
    setXsecDemStatus(entry.error);
  }
  drawCrossSection();
}

function setXsecDemStatus(msg) {
  const s = el("xsec-dem-status");
  if (s) s.textContent = msg || "";
}

async function refreshDemHiOverlay() {
  updateDemLegend();
  if (!demOverlayEnabled()) {
    if (demHiAbort) {
      demHiAbort.abort();
      demHiAbort = null;
    }
    demHiState.loading = false;
    demHiState.error = null;
    demHiState.series = [];
    demHiState.key = "";
    setDemStatus("");
    updateDemLegend();
    renderProfileSideView();
    attachDemHiToXsec();
    return;
  }
  const run = profileCandidateRun() || state.lastRuns?.runs?.[0];
  const pts = run?.r?.points;
  if (!pts || pts.length < 2) {
    setDemStatus("Kein Track");
    renderProfileSideView();
    attachDemHiToXsec();
    return;
  }
  const intervalSec = demIntervalSec();
  const key = `${runKey(run)}|${trackSampleKey(pts, intervalSec)}`;
  if (key === demHiState.key && demHiState.series.length >= 2 && !demHiState.loading) {
    updateDemLegend();
    renderProfileSideView();
    attachDemHiToXsec();
    return;
  }
  if (demHiAbort) demHiAbort.abort();
  const ac = new AbortController();
  demHiAbort = ac;
  const gen = ++demHiState.gen;
  demHiState.loading = true;
  demHiState.error = null;
  // New track/path: drop stale DEM so axis/profile don't keep the old ground.
  demHiState.series = [];
  demHiState.key = "";
  setDemStatus("Mapterhorn …");
  renderProfileSideView();
  attachDemHiToXsec();
  try {
    const series = await fetchElevationLine(pts, intervalSec, ac.signal);
    if (gen !== demHiState.gen) return;
    demHiState.key = key;
    demHiState.series = series;
    demHiState.loading = false;
    setDemStatus(series.length >= 2 ? `${series.length} Punkte` : "keine Daten");
    updateDemLegend();
    renderProfileSideView();
    attachDemHiToXsec();
  } catch (err) {
    if (err?.name === "AbortError") return;
    if (gen !== demHiState.gen) return;
    demHiState.loading = false;
    demHiState.error = err?.message || "Fehler";
    setDemStatus(demHiState.error);
    renderProfileSideView();
    attachDemHiToXsec();
  }
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

function sideViewClientToTSec(clientX, { allowBeyond = false } = {}) {
  const svg = el("fp-side")?.querySelector("svg");
  const g = sideViewGeom;
  if (!svg || !g || g.iw < 1) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.width < 1) return null;
  const xVb = ((clientX - rect.left) / rect.width) * g.W;
  const t = ((xVb - g.pad.l) / g.iw) * g.tMax;
  if (allowBeyond) return Math.max(0, t);
  return Math.max(0, Math.min(g.tMax, t));
}

/** Absolute chart height (m NN when axis is AMSL, else m AGL). */
function sideViewClientToZ(clientY) {
  const host = el("fp-side");
  const svg = host?.querySelector("svg");
  const g = sideViewGeom;
  if (!svg || !g) return null;
  const rect = svg.getBoundingClientRect();
  if (rect.height < 1) return null;
  const yVb = ((clientY - rect.top) / rect.height) * g.H;
  const z = g.hMin + ((g.pad.t + g.ih - yVb) / g.ih) * (g.hMax - g.hMin);
  const cfg = heightSliderCfg();
  const disp = Math.round(heightToDisplay(z) / cfg.step) * cfg.step;
  const m = heightFromDisplay(Math.min(Math.max(disp, 0), heightToDisplay(barMax)));
  return Math.round(Math.min(barMax, Math.max(0, m)));
}

function sideViewClientToAgl(clientY, tSecForTerrain = null) {
  const z = sideViewClientToZ(clientY);
  if (z == null) return null;
  const g = sideViewGeom;
  if (!g?.useAmsl) return z;
  const t = tSecForTerrain ?? (sideDrag != null ? profileTargets[sideDrag.i]?.tSec : null);
  if (t == null) return z;
  const ground = terrainAt(g.terrain.length >= 2 ? g.terrain : profileGroundSeries(), t);
  return Math.round(Math.min(barMax, Math.max(0, z - (ground ?? 0))));
}

function renderProfileSideView() {
  const host = el("fp-side");
  if (!host || el("flightprofile-panel").hidden) return;
  const err = validateProfileTargets(profileTargets);
  if (err) {
    cancelSideHover({ clearHint: true });
    host.replaceChildren();
    sideViewGeom = null;
    return;
  }
  let expanded;
  try {
    expanded = expandProfile(profileTargets);
  } catch {
    cancelSideHover({ clearHint: true });
    host.replaceChildren();
    sideViewGeom = null;
    return;
  }

  const run = profileCandidateRun();
  const terrain = terrainSeriesFromRun(run);
  const demHi = (demOverlayEnabled() && demHiState.series.length >= 2) ? demHiState.series : [];
  // One ground series for axis + AGL↔AMSL (DEM when on, else model) — never mix.
  const groundSeries = profileGroundSeries();
  const useAmsl = groundSeries.length >= 2;
  const tMax = Math.max(...profileTargets.map((w) => w.tSec), profileDurationSec(), 1);
  const inheritAmsl = profileInheritMode() === "amsl";

  const toZ = (tSec, hAgl) => {
    if (!useAmsl) return hAgl;
    const g = terrainAt(groundSeries, tSec);
    return (g ?? 0) + hAgl;
  };

  // AMSL inherit: prefer stored absolute NN (flat after cascade). Else AGL+ground.
  const handles = profileTargets.map((w) => ({
    tSec: w.tSec,
    z: (inheritAmsl && Number.isFinite(w.targetAmsl))
      ? w.targetAmsl
      : toZ(w.tSec, w.targetAgl),
  }));
  // AMSL mode: blue line = piecewise-linear through handles (not AGL-expanded×model).
  // Otherwise a V appears when only some markers have targetAmsl / model≠DEM.
  const ramp = inheritAmsl
    ? handles
    : expanded.map((p) => ({ tSec: p.tSec, z: toZ(p.tSec, p.hAgl) }));

  const groundZs = [
    ...groundSeries.map((p) => p.z),
    ...demHi.map((p) => p.z),
  ].filter((z) => Number.isFinite(z));
  let hMin = useAmsl && groundZs.length ? Math.min(...groundZs) : 0;
  let hMax = Math.max(
    ...handles.map((p) => p.z).filter((z) => Number.isFinite(z)),
    ...ramp.map((p) => p.z).filter((z) => Number.isFinite(z)),
    ...demHi.map((p) => p.z).filter((z) => Number.isFinite(z)),
    useAmsl ? hMin + 1 : Math.max(...profileTargets.map((w) => w.targetAgl), 1),
  );
  // AMSL: start just below lowest ground (100 m floor) so terrain sits above the axis.
  // Recalculated whenever renderProfileSideView runs (after traj + each DEM path).
  const AXIS_M = 100;
  if (useAmsl) {
    const rawMin = Math.max(0, hMin);
    hMin = Math.floor(rawMin / AXIS_M) * AXIS_M;
    if (hMin >= rawMin) hMin = Math.max(0, hMin - AXIS_M);
  } else {
    hMin = 0;
  }
  hMax = Math.ceil(hMax / AXIS_M) * AXIS_M;
  if (hMax <= hMin) hMax = hMin + AXIS_M;

  const rect = host.getBoundingClientRect();
  const W = Math.max(160, Math.round(rect.width) || 320);
  const H = Math.max(FP_SIDE_H_MIN, Math.round(rect.height) || FP_SIDE_H_DEFAULT);
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  sideViewGeom = {
    tMax, hMin, hMax, pad, iw, ih, W, H,
    terrain: groundSeries,
    useAmsl,
    expanded,
  };

  const x = (t) => pad.l + (t / tMax) * iw;
  const y = (z) => pad.t + ih - ((z - hMin) / (hMax - hMin)) * ih;
  const poly = (pts, stroke, width, extra = "") => {
    if (pts.length < 2) return "";
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.tSec).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" pointer-events="none"${extra}/>`;
  };

  // Invisible thick hit targets on profile segments (handles stay above).
  let segHits = "";
  for (let i = 0; i < expanded.length - 1; i++) {
    const a = expanded[i];
    const b = expanded[i + 1];
    segHits +=
      `<line class="fp-side-seg" data-seg="${i}" ` +
      `x1="${x(a.tSec).toFixed(1)}" y1="${y(toZ(a.tSec, a.hAgl)).toFixed(1)}" ` +
      `x2="${x(b.tSec).toFixed(1)}" y2="${y(toZ(b.tSec, b.hAgl)).toFixed(1)}" ` +
      `stroke="transparent" stroke-width="12" pointer-events="stroke"/>`;
  }

  let terrainSvg = "";
  // Grey blob = Mapterhorn; black polyline = model terrain (when DEM on).
  // Without DEM: model keeps the grey fill alone.
  if (demHi.length >= 2) {
    const top = demHi.map((p, i) =>
      `${i ? "L" : "M"}${x(p.tSec).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
    const close =
      `L${x(demHi[demHi.length - 1].tSec).toFixed(1)},${(pad.t + ih).toFixed(1)} ` +
      `L${x(demHi[0].tSec).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
    terrainSvg =
      `<path d="${top} ${close}" fill="#d8d2c4" fill-opacity="0.85" stroke="none" pointer-events="none"/>` +
      poly(demHi, "#a89f8a", 1);
    if (terrain.length >= 2) {
      terrainSvg += poly(terrain.map((p) => ({ tSec: p.tSec, z: p.z })), "#1a1a18", 1.5);
    }
  } else if (terrain.length >= 2) {
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
    poly(ramp, "#1c5cab", 2) +
    segHits +
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
    cancelSideHover({ clearHint: true });
    host.setPointerCapture(e.pointerId);
    host.classList.add("dragging");
    sideDrag = { i, pointerId: e.pointerId, moved: false };
    updateSegmentRateHint(i);
  });

  host.addEventListener("pointerover", (e) => {
    if (sideDrag || el("flightprofile-panel").hidden) return;
    sideHover.x = e.clientX;
    sideHover.y = e.clientY;
    const pt = e.target.closest?.(".fp-side-pt");
    if (pt) {
      const i = +pt.dataset.i;
      if (!Number.isFinite(i)) return;
      scheduleSideHover("pt", i);
      return;
    }
    const seg = e.target.closest?.(".fp-side-seg");
    if (!seg) return;
    const i = +seg.dataset.seg;
    if (!Number.isFinite(i)) return;
    scheduleSideHover("seg", i);
  });

  host.addEventListener("pointermove", (e) => {
    if (sideDrag || el("flightprofile-panel").hidden) return;
    const hit = e.target.closest?.(".fp-side-pt") || e.target.closest?.(".fp-side-seg");
    if (!hit) return;
    sideHover.x = e.clientX;
    sideHover.y = e.clientY;
    if (sideHover.visible) positionSideHoverTip(e.clientX, e.clientY);
  });

  host.addEventListener("pointerout", (e) => {
    const from = e.target.closest?.(".fp-side-pt") || e.target.closest?.(".fp-side-seg");
    if (!from) return;
    const to = e.relatedTarget;
    if (to?.closest?.(".fp-side-pt") || to?.closest?.(".fp-side-seg")) return;
    cancelSideHover({ clearHint: true });
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
    const i = sideDrag.i;
    const rawT = sideViewClientToTSec(e.clientX);
    if (rawT == null) return;
    const tSec = clampProfileTime(i, rawT);
    const cur = profileTargets[i];
    // AMSL inherit + AMSL axis: edit absolute NN and copy that value to the right.
    const amslMode = profileInheritMode() === "amsl" && !!sideViewGeom?.useAmsl;
    const hEdit = amslMode
      ? sideViewClientToZ(e.clientY)
      : sideViewClientToAgl(e.clientY, tSec);
    if (hEdit == null) return;
    const prevKey = amslMode
      ? (Number.isFinite(cur.targetAmsl) ? cur.targetAmsl : Math.round(toZPreview(cur)))
      : cur.targetAgl;
    if (hEdit === prevKey && tSec === cur.tSec && !sideDrag.moved) return;
    sideDrag.moved = true;
    profileTargets[i] = { ...cur, tSec };
    cascadeProfileAltitude(i, hEdit);
    renderProfileSideView();
    updateSegmentRateHint(i);
    const rows = el("fp-tbody").querySelectorAll("tr");
    const row = rows[i];
    const inpT = row?.querySelector('input[data-field="t"]');
    if (inpT) inpT.value = String(Math.round(tSec / 60));
    for (let j = i; j < rows.length; j++) {
      const w = profileTargets[j];
      const inpH = rows[j]?.querySelector('input[data-field="h"]');
      if (inpH && w) inpH.value = String(Math.round(heightToDisplay(w.targetAgl)));
      const amslCell = rows[j]?.querySelector('[data-field="amsl"]');
      if (amslCell && w) amslCell.textContent = profileTableAmslText(w);
    }
    if (profileModalIndex != null && profileModalIndex >= i) {
      const mw = profileTargets[profileModalIndex];
      const mh = mw?.targetAgl ?? 0;
      el("fp-modal-h").value = String(Math.round(heightToDisplay(mh)));
      el("fp-modal-hlabel").textContent = fmtHeight(mh);
      if (profileModalIndex === i) {
        el("fp-modal-title").textContent = `Marke · ${Math.round(tSec / 60)} min`;
      }
      updateModalNote();
    }
  });

  const endDrag = (e) => {
    if (!sideDrag || e.pointerId !== sideDrag.pointerId) return;
    const { i, moved } = sideDrag;
    sideDrag = null;
    host.classList.remove("dragging");
    try { host.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!moved) {
      clearSegmentRateHint();
      updateProfileHint();
      openProfileModal(i);
      return;
    }
    clearSegmentRateHint();
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

/** @returns {"amsl"|"agl"|"none"} inherit mode for cascade / add / insert (default AMSL). */
function profileInheritMode() {
  if (el("fp-inherit-none")?.checked) return "none";
  if (el("fp-inherit-agl")?.checked) return "agl";
  return "amsl";
}

/**
 * Single ground series for side-view AMSL axis and AGL↔AMSL encoding.
 * Prefer Mapterhorn when the overlay is on; else model traj orography.
 */
function profileGroundSeries() {
  if (demOverlayEnabled() && demHiState.series.length >= 2) return demHiState.series;
  return terrainSeriesFromRun(profileCandidateRun());
}

/** @deprecated alias — same as profileGroundSeries */
function profileEncodeGroundSeries() {
  return profileGroundSeries();
}

function encodeAglFromAmsl(amsl, tSec, fallbackAgl = 0) {
  const g = terrainAt(profileGroundSeries(), tSec);
  if (g == null || !Number.isFinite(g)) return Math.max(0, Math.round(fallbackAgl));
  return Math.max(0, Math.round(amsl - g));
}

function waypointAmsl(w) {
  if (Number.isFinite(w?.targetAmsl)) return Math.round(w.targetAmsl);
  const g = terrainAt(profileGroundSeries(), w.tSec);
  if (g == null || !Number.isFinite(g)) return null;
  return Math.round(g + w.targetAgl);
}

/** Chart AMSL (or AGL if no ground) for early-out while dragging. */
function toZPreview(w) {
  if (!w) return null;
  if (Number.isFinite(w.targetAmsl)) return Math.round(w.targetAmsl);
  const g = terrainAt(profileGroundSeries(), w.tSec);
  if (g == null || !Number.isFinite(g)) return Math.round(w.targetAgl);
  return Math.round(g + w.targetAgl);
}

function updateInheritHint() {
  const hint = el("fp-inherit-hint");
  if (!hint) return;
  const mode = profileInheritMode();
  hint.textContent = mode === "agl"
    ? "spätere Marker · AGL = konstante Höhe über Grund"
    : mode === "none"
      ? "jeder Marker unabhängig · keine Kopie nach rechts"
      : "spätere Marker · AMSL = konstante NN-Höhe";
}

/**
 * Inherit height onto a new waypoint from `earlier`.
 * AGL mode: copy AGL. AMSL mode: copy absolute AMSL (no DEM delta).
 * @returns {{ tSec: number, targetAgl: number, targetAmsl?: number }|null}
 */
function inheritWaypointFromEarlier(earlier, tSec, hAgl = null) {
  if (profileInheritMode() === "none") {
    const h = Number.isFinite(hAgl) ? hAgl : profileHeightAt(tSec);
    return { tSec, targetAgl: Math.max(0, Math.round(h)) };
  }
  if (!earlier) return null;
  if (profileInheritMode() === "agl") {
    return { tSec, targetAgl: Math.max(0, Math.round(earlier.targetAgl)) };
  }
  const amsl = waypointAmsl(earlier);
  if (amsl == null) {
    setStatus("AMSL-Vererbung: keine Geländehöhe für AGL-Encoding.", true);
    return null;
  }
  return {
    tSec,
    targetAmsl: amsl,
    targetAgl: encodeAglFromAmsl(amsl, tSec, earlier.targetAgl),
  };
}

/**
 * Cascade height from `fromIndex` to the right (inclusive).
 * AGL mode: `h` is AGL — copy to later markers.
 * AMSL mode: `h` is absolute AMSL (m NN) — copy that AMSL to later markers;
 *   AGL is re-encoded from the same ground series the side view uses.
 * @returns {boolean}
 */
function cascadeProfileAltitude(fromIndex, h) {
  if (fromIndex < 0 || fromIndex >= profileTargets.length) return false;
  const val = Math.max(0, Math.round(h));
  const mode = profileInheritMode();
  const last = mode === "none" ? fromIndex + 1 : profileTargets.length;

  if (mode === "agl" || mode === "none") {
    for (let j = fromIndex; j < last; j++) {
      const w = profileTargets[j];
      profileTargets[j] = { tSec: w.tSec, targetAgl: val };
    }
    return true;
  }

  // AMSL: same NN height on this marker and every marker to the right.
  for (let j = fromIndex; j < last; j++) {
    const w = profileTargets[j];
    profileTargets[j] = {
      tSec: w.tSec,
      targetAmsl: val,
      targetAgl: encodeAglFromAmsl(val, w.tSec, w.targetAgl),
    };
  }
  return true;
}

function insertProfileTarget(tSec, _hAgl) {
  if (profileTargets.length >= FP_MAX_ROWS) {
    setStatus(`Maximal ${FP_MAX_ROWS} Profilpunkte.`, true);
    return false;
  }
  let t = Math.max(0, Math.round(tSec));
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
  const earlier = [...sorted].reverse().find((w) => w.tSec < t) || sorted[0];
  const next = inheritWaypointFromEarlier(earlier, t, _hAgl);
  if (!next) return false;
  profileTargets.push(next);
  profileTargets.sort((a, b) => a.tSec - b.tSec);
  afterProfileTargetsMutated();
  setStatus(`Profilpunkt bei ${Math.round(t / 60)} min · ${fmtHeight(next.targetAgl)} AGL`);
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
    if (el("livemode").checked) liveUiStash = null;
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
  demHiState.key = "";
  refreshDemHiOverlay();
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
  if (profileModalIndex == null) {
    el("fp-modal-note").textContent = "";
    return;
  }
  const i = profileModalIndex;
  const h = +heightFromDisplay(+el("fp-modal-h").value);
  const rateParts = [];
  if (i > 0) {
    const prev = profileTargets[i - 1];
    const dt = profileTargets[i].tSec - prev.tSec;
    const geo = dt > 0 ? (h - prev.targetAgl) / dt : null;
    rateParts.push(`← ${fmtVertRate(geo)}`);
  }
  if (i < profileTargets.length - 1) {
    const next = profileTargets[i + 1];
    const dt = next.tSec - profileTargets[i].tSec;
    const geo = dt > 0 ? (next.targetAgl - h) / dt : null;
    rateParts.push(`${fmtVertRate(geo)} →`);
  }
  const rateLine = rateParts.length ? `Vertikalrate ${rateParts.join(" · ")}` : "";
  el("fp-modal-note").textContent = i === 0
    ? (rateLine ? `Startpunkt · ${rateLine}` : "Startpunkt")
    : (rateLine || "Höhe mit Schieberegler ändern; Zeit per Ziehen im Profil.");
}

function applyModalToTarget() {
  if (profileModalIndex == null) return;
  const hAgl = Math.max(0, Math.round(heightFromDisplay(+el("fp-modal-h").value)));
  const i = profileModalIndex;
  if (profileInheritMode() === "amsl") {
    // Modal edits AGL; inheritance propagates absolute AMSL.
    const g = terrainAt(profileEncodeGroundSeries(), profileTargets[i].tSec);
    const amsl = Math.max(0, Math.round((g ?? 0) + hAgl));
    cascadeProfileAltitude(i, amsl);
  } else {
    cascadeProfileAltitude(i, hAgl);
  }
  el("fp-modal-hlabel").textContent = fmtHeight(profileTargets[i].targetAgl);
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
  const duration = Math.min(72, Math.max(0.25, +el("duration").value || 12));
  const t0Ms = state.profileEdit?.t0Ms ?? timebarStartMs();
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
const BAR_MAX_OPTIONS = [2000, 3000, 4000, 5000, 6000, 8000, 10000];
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
  dropRunsForHeight(m);
  persist();
}

/**
 * Ergebnisse einer entfernten Starthöhe wegräumen: Karte, Ergebnisliste,
 * Querschnitt und 3D-Ansicht. Ohne das blieben Linie und Streifen bis zur
 * nächsten Berechnung stehen, obwohl die Höhe nicht mehr am Balken hängt.
 */
function dropRunsForHeight(m) {
  if (!state.lastRuns) return;
  state.pinRuns.delete(m);
  const keep = state.lastRuns.runs.filter((run) => run.heightM !== m);
  if (keep.length === state.lastRuns.runs.length) return;
  // DEM-Cache ist nach runKey geschlüsselt, nicht nach Höhe.
  for (const run of state.lastRuns.runs) {
    if (run.heightM === m) {
      const rk = runKey(run);
      xsecDem.get(rk)?.abort?.abort();
      xsecDem.delete(rk);
    }
  }

  if (!keep.length) {
    // Letzte Höhe entfernt — es gibt nichts mehr zu zeigen.
    state.layers.clearLayers();
    state.pinLayers.clearLayers();
    state.runMapTracks.clear();
    state.hiddenRunKeys.clear();
    state.lastRuns = null;
    state.xsec = null;
    resetRunSelection();
    el("results").innerHTML = "";
    setDownloadEnabled(false);
    el("xsecbtn").disabled = true;
    el("view3dbtn").disabled = true;
    showCrossSection(false);
    if (view3dMod && !el("view3d").hidden) hide3D();
    refreshMapTracklist();
    return;
  }

  state.lastRuns = { ...state.lastRuns, runs: keep };
  if (state.xsec) {
    state.xsec = { ...state.xsec, runs: state.xsec.runs.filter((run) => run.heightM !== m) };
  }
  // Auswahl könnte auf den entfernten Lauf gezeigt haben.
  if (state.selectedRunKey && !keep.some((run) => runKey(run) === state.selectedRunKey)) {
    state.selectedRunKey = null;
  }
  repaintRuns();
  drawCrossSection();
  if (view3dMod && !el("view3d").hidden) view3dMod.update(view3dData());
}

/** Karte und Ergebnisliste aus `state.lastRuns` neu aufbauen. */
function repaintRuns() {
  const { runs, mode } = state.lastRuns;
  state.layers.clearLayers();
  state.pinLayers.clearLayers();
  state.runMapTracks.clear();
  restoreStartMarkerVisibility();
  const pickable = mode === "agl";
  paintRunsAsMapTracks(runs, state.layers, pickable);
  el("results").innerHTML = "";
  for (const run of runs) reportResult(run.r, run.heightM, run.color, run.label, run);
  highlightSelectedRun();
  refreshMapTracklist();
  void direction;
}

/**
 * Zeichnet Läufe als einzeln schaltbare LayerGroups in `parent`.
 * `state.runMapTracks` wird ergänzt (nicht geleert — Caller leert bei Bedarf).
 */
function paintRunsAsMapTracks(runs, parent, pickable) {
  for (const run of runs) {
    const key = runKey(run);
    const g = L.layerGroup();
    drawCasing(run.r, g);
    drawTrajectory(run.r, run.color, run.label, run.dash, g, {
      onSelect: trackSelectHandler(run, pickable),
    });
    const latlngs = (run.r?.points || []).map((p) => [p.lat, p.lon]);
    const bounds = latlngs.length >= 2 ? L.latLngBounds(latlngs) : null;
    state.runMapTracks.set(key, { run, layer: g, bounds, parent });
    if (!state.hiddenRunKeys.has(key)) g.addTo(parent);
  }
}

// --- Höhenbalken: Skala, Umrechnung Pixel<->Höhe, Rendern -------------------
// Der Balken bildet 0…barMax mit einer Wurzel-Skala ab (Grund unten, hohe
// Werte oben): der häufig genutzte untere Bereich wird gespreizt, oben wird
// gestaucht. Im NN-Bezug wird der Streifen NN→Grund auf einen festen kleinen
// Anteil gestaucht, damit das Gelände nicht den unteren Balken dominiert.
const BAR_TERRAIN_FRAC = 0.1;

function metersToFrac(m) {
  const mode = el("refmode").value;
  const elev = state.startElevation;
  if (mode === "amsl" && elev != null && elev > 0 && elev < barMax) {
    if (m <= elev) {
      return BAR_TERRAIN_FRAC * Math.sqrt(Math.min(1, Math.max(0, m / elev)));
    }
    const u = (m - elev) / (barMax - elev);
    return BAR_TERRAIN_FRAC + (1 - BAR_TERRAIN_FRAC) * Math.sqrt(Math.min(1, Math.max(0, u)));
  }
  return Math.sqrt(Math.min(1, Math.max(0, m / barMax)));
}

function fracToMeters(frac) {
  const f = Math.min(1, Math.max(0, frac));
  const mode = el("refmode").value;
  const elev = state.startElevation;
  if (mode === "amsl" && elev != null && elev > 0 && elev < barMax) {
    if (f <= BAR_TERRAIN_FRAC) {
      const t = f / BAR_TERRAIN_FRAC;
      return t * t * elev;
    }
    const u = (f - BAR_TERRAIN_FRAC) / (1 - BAR_TERRAIN_FRAC);
    return elev + u * u * (barMax - elev);
  }
  return f * f * barMax;
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
  // Rand herausrechnen, dann Skala umkehren.
  const frac = Math.min(1, Math.max(0, (raw - BAR_PAD) / (1 - 2 * BAR_PAD)));
  return snapMeters(fracToMeters(frac));
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
    const mTick = heightFromDisplay(v);
    // Im gestauchten Geländestreifen keine Zwischen-Ticks (nur NN bleibt).
    if (mode === "amsl" && elev != null && mTick > 0 && mTick < elev) continue;
    const pos = posPct(mTick);
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

  // Modelllevel-Carets links (geometrisch) / Isobaren rechts (api.open-meteo.com).
  // Außerhalb des blauen Balkens in eigenen Spalten; Hover über data-tip.
  let hCarets = "";
  let pCarets = "";
  const probe = state.modelLevelProbe;
  if (probe?.levels?.length && (mode === "agl" || elev != null)) {
    for (const lv of probe.levels) {
      if (!(lv.hAgl > 0)) continue;
      const mDisp = mode === "amsl" ? lv.hAgl + elev : lv.hAgl;
      if (!(mDisp > 0) || mDisp > barMax) continue;
      const pos = posPct(mDisp);
      const mSnap = snapMeters(mDisp);
      hCarets += `<div class="bar-model-caret bar-model-caret--h" data-m="${mSnap}" ` +
        `style="bottom:${pos}%" data-tip="${lv.n}: ${fmtHeight(mDisp)}"></div>`;
    }
  }
  const pProbe = state.pressureLevelProbe;
  if (pProbe?.levels?.length) {
    for (const lv of pProbe.levels) {
      let mDisp;
      if (mode === "amsl") mDisp = lv.zAmsl;
      else if (elev != null) mDisp = lv.zAmsl - elev;
      else continue;
      if (!(mDisp > 0) || mDisp > barMax) continue;
      const pos = posPct(mDisp);
      const mSnap = snapMeters(mDisp);
      pCarets += `<div class="bar-model-caret bar-model-caret--p" data-m="${mSnap}" ` +
        `style="bottom:${pos}%" data-tip="${Math.round(lv.hPa)} hPa"></div>`;
    }
  }

  // Modell-Geländehöhe rechts neben der Grundlinie (bei AGL am unteren Rand,
  // bei AMSL an der Geländeoberkante).
  if (elev != null) {
    const groundPos = posPct(mode === "amsl" ? elev : 0);
    labelHtml += `<div class="bar-groundinfo" style="bottom:${groundPos}%">${fmtHeight(elev)} NN</div>`;
  }
  bar.innerHTML = html;
  el("heightbar-carets-h").innerHTML = hCarets;
  el("heightbar-carets-p").innerHTML = pCarets;
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

function onCaretPointerDown(e) {
  const caretEl = e.target.closest(".bar-model-caret");
  if (!caretEl) return;
  e.preventDefault();
  e.stopPropagation();
  const m = +caretEl.dataset.m;
  if (addHeight(m)) {
    updateHeightContext();
    maybeLive();
  }
}
el("heightbar-carets-h").addEventListener("pointerdown", onCaretPointerDown);
el("heightbar-carets-p").addEventListener("pointerdown", onCaretPointerDown);

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

function applyLiveLaunchUi() {
  const live = el("livemode").checked;
  const title = live
    ? "Live-Modus: Startzeit eingefroren; Launch-Fenster aus"
    : "0 = einzelne Startzeit; >0 = Launch-Fenster [T0, T0+Fenster]";
  el("launchwindow").disabled = live;
  el("launchstep").disabled = live;
  el("launchwindow").title = title;
  el("launchstep").title = live ? title : "";
}

/** @type {null | {
 *   launchWindowH: number,
 *   useApi: boolean,
 *   tStartMs: number,
 *   playMs: number,
 *   launchWindow: object | null,
 * }} */
let liveUiStash = null;

function captureLiveUiStash() {
  return {
    launchWindowH: Math.min(12, Math.max(0, +el("launchwindow").value || 0)),
    useApi: el("useapi").checked,
    tStartMs: timebar?.startMs?.() ?? timebarPlayMs(),
    playMs: timebarPlayMs(),
    launchWindow: state.launchWindow,
  };
}

function restoreLiveUi() {
  const s = liveUiStash;
  liveUiStash = null;
  if (!s) return;
  try {
    el("launchwindow").value = String(s.launchWindowH);
    state.launchWindow = s.launchWindow;
    if (s.launchWindowH > 0) {
      timebar?.setBand(s.tStartMs);
      if (Number.isFinite(s.playMs)) timebar?.setPlayMs(s.playMs, { silent: true });
    } else {
      timebar?.setBand(s.playMs ?? s.tStartMs);
    }
    updateTimeLabel();
    updateReachHint();
  } finally {
    // After timebar persist: always put API back last (Live had forced it off).
    el("useapi").checked = !!s.useApi;
  }
}

/** Collapse Launch Window to the timebar playhead so Live can run locally. */
function freezeLaunchForLive() {
  const t0 = timebarPlayMs();
  // Keep the first snapshot; a second freeze would see API already off.
  if (!liveUiStash) liveUiStash = captureLiveUiStash();
  const winH = liveUiStash.launchWindowH;
  const hadLaunch = winH > 0 || !!liveUiStash.launchWindow;

  if (state.launchWindow?.samples?.length >= 2) {
    const runs = computeMorphRuns(t0);
    if (runs?.length) {
      const prev = state.lastRuns;
      state.lastRuns = {
        runs,
        modelKey: prev?.modelKey || el("model").value,
        mode: prev?.mode || el("refmode").value,
        t0Ms: t0,
        duration: prev?.duration ?? (+el("duration").value || 12),
        direction: prev?.direction ?? (+el("direction").value || 1),
      };
      morphAtStartMs(t0);
    }
  }

  if (hadLaunch) {
    el("launchwindow").value = "0";
    state.launchWindow = null;
    timebar?.setBand(t0);
  }
  if (liveUiStash.useApi) el("useapi").checked = false;

  setStatus(`Live lokal · Start eingefroren ${fmtTime(t0)} · API/Launch aus`);
}

function applyModeUI() {
  applyLiveLaunchUi();
  const live = el("livemode").checked;
  el("heightslabel").innerHTML = live
    ? 'Starthöhen <span class="hint">(Live: aktive Höhe folgt dem Balken)</span>'
    : 'Starthöhen <span class="hint">(max. 8, Balken anklicken)</span>';
  renderBar();
}

el("livemode").addEventListener("change", () => {
  const leaving = !el("livemode").checked;
  const restoreApi = leaving ? (liveUiStash ? liveUiStash.useApi : true) : null;
  if (el("livemode").checked) {
    if (el("flightprofile").checked) {
      el("flightprofile").checked = false;
      applyProfileUI();
    }
    freezeLaunchForLive();
  } else {
    restoreLiveUi();
  }
  applyModeUI();
  state.live = null;
  // Beim Verlassen des Live-Modus bleiben alle Trajektorien sichtbar (aktive
  // Linie + Pins). Ein späterer „echter" Lauf zeichnet ohnehin alles neu.
  persist();
  if (leaving) {
    el("useapi").checked = !!restoreApi;
    persist();
  }
  liveRun();
});

// --- Flugprofil: Events -----------------------------------------------------
el("flightprofile").addEventListener("change", () => {
  if (el("flightprofile").checked && el("livemode").checked) {
    el("livemode").checked = false;
    state.live = null;
    liveUiStash = null;
    applyModeUI();
  }
  if (!el("flightprofile").checked) state.profileEdit = null;
  applyProfileUI();
  persist();
});
el("fp-preset").addEventListener("change", () => {
  applyProfilePreset(el("fp-preset").value);
  persist();
});
el("fp-table-toggle").addEventListener("click", () => {
  setFpTableVisible(!!el("fp-table-block").hidden, { save: true });
});
el("fp-dem").addEventListener("change", () => {
  persist();
  refreshDemHiOverlay();
});
el("fp-dem-interval").addEventListener("change", () => {
  el("fp-dem-interval").value = String(clampDemIntervalMin(+el("fp-dem-interval").value));
  demHiState.key = ""; // force resample
  persist();
  if (demOverlayEnabled()) refreshDemHiOverlay();
});
el("fp-inherit-amsl")?.addEventListener("change", () => {
  updateInheritHint();
  persist();
  renderProfileSideView();
});
el("fp-inherit-agl")?.addEventListener("change", () => {
  updateInheritHint();
  persist();
  renderProfileSideView();
});
el("fp-inherit-none")?.addEventListener("change", () => {
  updateInheritHint();
  persist();
  renderProfileSideView();
});
el("fp-tbody").addEventListener("change", (e) => {
  const inp = e.target;
  const field = inp?.dataset?.field;
  const tr = inp?.closest?.("tr");
  const rows = [...el("fp-tbody").querySelectorAll("tr")];
  const i = tr ? rows.indexOf(tr) : -1;
  readProfileTable();
  if (field === "h" && i >= 0 && i < profileTargets.length) {
    if (profileInheritMode() === "amsl") {
      const amsl = waypointAmsl(profileTargets[i]);
      if (amsl != null) cascadeProfileAltitude(i, amsl);
    } else {
      cascadeProfileAltitude(i, profileTargets[i].targetAgl);
    }
  }
  refreshProfileUI({ scheduleApi: true });
  persist();
});
el("fp-add").addEventListener("click", () => {
  readProfileTable();
  if (profileTargets.length >= FP_MAX_ROWS) return;
  const last = profileTargets[profileTargets.length - 1];
  const tSec = last.tSec + 1800;
  const next = profileInheritMode() === "none"
    ? { tSec, targetAgl: Math.max(0, Math.round(last.targetAgl)) }
    : inheritWaypointFromEarlier(last, tSec);
  if (!next) return;
  profileTargets.push(next);
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
el("fp-save").addEventListener("click", saveCurrentProfile);
el("fp-apply-saved").addEventListener("click", applySavedProfile);
el("fp-del-saved").addEventListener("click", deleteSavedProfile);
el("fp-save-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveCurrentProfile();
  }
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
if (Number.isFinite(saved.launchWindowH) || Number.isFinite(saved.takeoffWindowH)) {
  const raw = Number.isFinite(saved.launchWindowH)
    ? saved.launchWindowH
    : saved.takeoffWindowH;
  el("launchwindow").value = String(Math.min(12, Math.max(0, raw)));
}
if (Number.isFinite(saved.launchStepMin) || Number.isFinite(saved.ensembleStepMin)) {
  el("launchstep").value = Number.isFinite(saved.launchStepMin)
    ? saved.launchStepMin
    : saved.ensembleStepMin;
}
updateDirectionLabels();
for (const id of ["markerint", "direction", "duration", "launchwindow", "launchstep"]) {
  el(id).addEventListener("change", persist);
}
el("launchwindow").addEventListener("input", () => {
  timebar?.onLaunchWindowInput();
  const w = Math.max(0, +el("launchwindow").value || 0);
  if (w <= 0) {
    clearLaunchWindow();
    return;
  }
  if (el("livemode").checked) {
    el("livemode").checked = false;
    state.live = null;
    liveUiStash = null;
    el("useapi").checked = true;
    applyModeUI();
    setStatus("Launch-Fenster braucht „API abrufen“; Live-Modus aus.");
    persist();
  }
});
el("launchstep").addEventListener("input", () => {
  timebar?.onLaunchWindowInput();
  timebar?.render();
});
el("duration").addEventListener("input", () => {
  updateReachHint();
  timebar?.render();
  const last = profileTargets.length - 1;
  if (last >= 1) {
    const tSec = clampProfileTime(last, profileTargets[last].tSec);
    if (tSec !== profileTargets[last].tSec) {
      profileTargets[last] = { ...profileTargets[last], tSec };
      renderProfileTable();
      updateProfileHint();
    }
  }
  renderProfileSideView();
});

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

// Einheiten-Auswahl: Balken (samt Editierfeld) und, falls offen, Querschnitt
// in der neuen Einheit neu beschriften.
el("unitheight").value = unitState.height;
el("unitwind").value = unitState.wind;
function onUnitsChange() {
  setUnits({ height: el("unitheight").value, wind: el("unitwind").value });
  renderBar();
  if (el("flightprofile").checked) refreshProfileUI({ scheduleApi: false });
  updateHeightContext();
  drawCrossSection();
  persist();
}
el("unitheight").addEventListener("change", onUnitsChange);
el("unitwind").addEventListener("change", onUnitsChange);

if (saved.liveMode) el("livemode").checked = true;
if (el("livemode").checked) {
  const savedApi = saved.liveSavedUseApi;
  liveUiStash = {
    launchWindowH: Math.min(12, Math.max(0, +el("launchwindow").value || 0)),
    // Missing liveSavedUseApi: older persist wrote the frozen-off checkbox.
    useApi: savedApi == null ? true : !!savedApi,
    tStartMs: Number.isFinite(saved.tStartMs) ? saved.tStartMs : timebarPlayMs(),
    playMs: Number.isFinite(saved.playMs) ? saved.playMs : timebarPlayMs(),
    launchWindow: null,
  };
  el("launchwindow").value = "0";
}
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
  el("useapi").checked = false;
}
applyLiveLaunchUi();
el("useapi").addEventListener("change", () => {
  if (el("useapi").checked && el("livemode").checked) {
    el("livemode").checked = false;
    state.live = null;
    restoreLiveUi();
    el("useapi").checked = true;
    applyModeUI();
    setStatus("API abrufen: Live-Modus aus (Live rechnet lokal).");
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
savedProfiles = normalizeSavedProfiles(saved.savedProfiles);
renderSavedProfileSelect();
const savedTargets = Array.isArray(saved.profileTargets) ? saved.profileTargets
  : Array.isArray(saved.profileWaypoints) ? saved.profileWaypoints : null;
if (savedTargets?.length >= 2) {
  const restored = cloneTargets(savedTargets)
    .filter((w) => Number.isFinite(w.tSec) && Number.isFinite(w.targetAgl));
  if (restored.length >= 2 && !validateProfileTargets(restored)) {
    profileTargets = restored;
  }
}
if (["climbcruise", "constant", "empty"].includes(saved.profilePreset)) {
  el("fp-preset").value = saved.profilePreset;
}
setFpTableVisible(saved.fpTableVisible !== false);
if (saved.fpDemOverlay !== false) el("fp-dem").checked = true;
else el("fp-dem").checked = false;
el("xsec-dem").checked = !!saved.xsecDem;
if (Number.isFinite(saved.fpDemIntervalMin)) {
  el("fp-dem-interval").value = String(clampDemIntervalMin(saved.fpDemIntervalMin));
}
if (saved.fpInheritMode === "agl") {
  if (el("fp-inherit-agl")) el("fp-inherit-agl").checked = true;
} else if (saved.fpInheritMode === "none") {
  if (el("fp-inherit-none")) el("fp-inherit-none").checked = true;
} else if (el("fp-inherit-amsl")) {
  el("fp-inherit-amsl").checked = true;
}
updateInheritHint();
if (!(savedTargets?.length >= 2) && el("fp-preset").value === "climbcruise") {
  profileTargets = cloneTargets(FP_PRESETS.climbcruise);
}
applyProfileUI();

updateHeightContext();

settingsReady = true;

// --- Startpunkt per Klick / Marker ziehen -----------------------------------
map.on("click", (e) => setStart(e.latlng.lat, e.latlng.lng));

function setStart(lat, lon, opts = {}) {
  state.start = { lat, lon };
  if (Object.prototype.hasOwnProperty.call(opts, "placeName")) {
    state.startPlace = opts.placeName ? String(opts.placeName).trim() || null : null;
  } else {
    // Kartenklick / Marker ziehen: kein Geocode-Text mehr gültig.
    state.startPlace = null;
    reversePlaceKey = null;
  }
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
  updateFilenamePreview();
}

initGeocode({ map, setStart, debounce, el });

// Modell-Geländehöhe + ICON-Levelhöhen am Start (privater OM-Host) und
// Isobaren-Geopotential von api.open-meteo.com (dort verfügbar).
function firstFiniteHourly(arr) {
  if (!arr) return null;
  if (!Array.isArray(arr)) return Number.isFinite(arr) ? arr : null;
  for (const x of arr) if (x != null && Number.isFinite(x)) return x;
  return null;
}

function hourlyTimeIndex(times, tSec) {
  if (!times?.length) return 0;
  let ti = 0;
  let best = Infinity;
  for (let i = 0; i < times.length; i++) {
    const dt = Math.abs(times[i] - tSec);
    if (dt < best) { best = dt; ti = i; }
  }
  return ti;
}

function probeDateRange(tSec) {
  return {
    day0: new Date((tSec - 3600) * 1000).toISOString().slice(0, 10),
    day1: new Date((tSec + 3600) * 1000).toISOString().slice(0, 10),
  };
}

async function fetchStartElevation({ soft = false } = {}) {
  const s = state.start;
  if (!s) {
    state.startElevation = null;
    state.modelLevelProbe = null;
    state.pressureLevelProbe = null;
    updateHeightContext();
    renderBar();
    return;
  }
  const modelKey = el("model").value;
  const model = MODELS[modelKey];
  const timeKey = String(Math.round(timebarPlayMs() / 3600e3));
  const gen = ++modelLevelProbeGen;
  if (!soft) {
    state.startElevation = null;
    state.modelLevelProbe = null;
    state.pressureLevelProbe = null;
    updateHeightContext();
    renderBar();
  }
  const tSec = Number.isFinite(+timeKey) ? +timeKey * 3600 : Math.floor(Date.now() / 3600e3) * 3600;
  const { day0, day1 } = probeDateRange(tSec);

  // Parallel: Modelllevel-Höhen (privat) + Isobaren-Geopotential (public).
  const heightJob = (async () => {
    const n = model.nLevels;
    const vars = [];
    for (let l = 1; l <= n; l++) vars.push(`height_agl_level${l}`);
    const params = new URLSearchParams({
      latitude: s.lat.toFixed(5),
      longitude: s.lon.toFixed(5),
      hourly: vars.join(","),
      models: model.apiModel,
      timeformat: "unixtime",
      start_date: day0,
      end_date: day1,
      cell_selection: "nearest",
    });
    const d = await (await fetch(`${modelForecastUrl(model)}?${params}`)).json();
    return d;
  })();

  const pressureJob = (async () => {
    const vars = OM_PRESSURE_LEVELS_HPA.map((p) => `geopotential_height_${p}hPa`);
    const params = new URLSearchParams({
      latitude: s.lat.toFixed(5),
      longitude: s.lon.toFixed(5),
      hourly: vars.join(","),
      models: model.apiModel,
      timeformat: "unixtime",
      start_date: day0,
      end_date: day1,
      cell_selection: "nearest",
    });
    const d = await (await fetch(`${OM_PUBLIC_FORECAST}?${params}`)).json();
    return d;
  })();

  try {
    const [dH, dP] = await Promise.all([
      heightJob.catch(() => null),
      pressureJob.catch(() => null),
    ]);
    if (gen !== modelLevelProbeGen || state.start !== s) return;

    if (dH && Number.isFinite(dH.elevation)) state.startElevation = dH.elevation;
    else if (dP && Number.isFinite(dP.elevation) && state.startElevation == null) {
      state.startElevation = dP.elevation;
    }

    if (dH?.hourly) {
      const hourly = dH.hourly;
      const ti = hourlyTimeIndex(hourly.time, tSec);
      const levels = [];
      for (let l = 1; l <= model.nLevels; l++) {
        const hArr = hourly[`height_agl_level${l}`];
        const hAgl = (Array.isArray(hArr) && Number.isFinite(hArr[ti]))
          ? hArr[ti]
          : firstFiniteHourly(hArr);
        if (!(hAgl > 0)) continue;
        levels.push({ n: l, hAgl });
      }
      state.modelLevelProbe = {
        modelKey, lat: s.lat, lon: s.lon, timeKey: String(timeKey), levels,
      };
    }

    if (dP?.hourly) {
      const hourly = dP.hourly;
      const ti = hourlyTimeIndex(hourly.time, tSec);
      const levels = [];
      for (const hPa of OM_PRESSURE_LEVELS_HPA) {
        const zArr = hourly[`geopotential_height_${hPa}hPa`];
        const zAmsl = (Array.isArray(zArr) && Number.isFinite(zArr[ti]))
          ? zArr[ti]
          : firstFiniteHourly(zArr);
        if (!Number.isFinite(zAmsl)) continue;
        levels.push({ hPa, zAmsl });
      }
      state.pressureLevelProbe = {
        modelKey, lat: s.lat, lon: s.lon, timeKey: String(timeKey), levels,
      };
    }

    updateHeightContext();
    renderBar();
  } catch {
    /* Anzeige bleibt leer */
  }
}

const fetchModelLevelsDebounced = debounce(() => {
  if (state.start) fetchStartElevation({ soft: true });
}, 300);

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

function timebarStartMs() {
  return timebar?.startMs() ?? (Number.isFinite(saved.tStartMs) ? saved.tStartMs : Date.now());
}

function timebarPlayMs() {
  return timebar?.playMs() ?? timebarStartMs();
}

function initTimebar() {
  timebar = createTimebar({
    el,
    launchWindowH: () => Math.min(12, Math.max(0, +el("launchwindow").value || 0)),
    setLaunchWindowH: (h) => {
      if (el("livemode").checked && h > 0) return;
      el("launchwindow").value = String(Math.min(12, Math.max(0, Math.round(h * 4) / 4)));
    },
    launchStepMin: () => Math.max(5, +el("launchstep").value || 15),
    durationH: () => Math.min(72, Math.max(0.25, +el("duration").value || 12)),
    setDurationH: (h) => {
      el("duration").value = String(Math.min(72, Math.max(0.25, Math.round(h * 4) / 4)));
    },
    direction: () => (+el("direction").value === -1 ? -1 : 1),
    fmtTime,
    onPlay: () => {
      updateTimeLabel();
      updateReachHint();
      fetchModelLevelsDebounced();
      if (state.launchWindow?.samples?.length >= 2) {
        morphAtStartMs(timebarPlayMs());
      }
      persist();
    },
    onBandCommit: () => {
      clearTimeout(bandCommitTimer);
      bandCommitTimer = setTimeout(() => {
        const w = Math.min(12, Math.max(0, +el("launchwindow").value || 0));
        if (w <= 0) {
          persist();
          return;
        }
        if (!el("useapi").checked || !state.start || !state.meta) {
          persist();
          return;
        }
        if (el("livemode").checked || el("flightprofile").checked) {
          persist();
          return;
        }
        const lw = state.launchWindow;
        const t0 = timebarStartMs();
        const t1 = timebar?.endMs?.() ?? t0;
        const stepMs = Math.max(5, +el("launchstep").value || 15) * 60e3;
        const mismatch = !lw?.samples?.length
          || Math.abs(lw.tStartMs - t0) > 500
          || Math.abs(lw.tEndMs - t1) > 500
          || Math.abs((lw.stepMs || 0) - stepMs) > 500;
        if (!mismatch) {
          persist();
          return;
        }
        clearLaunchWindow();
        void runTrajectories();
      }, 300);
    },
    onChange: () => {
      updateTimeLabel();
      updateReachHint();
      persist();
    },
  });
  timebar.bind();
}

// --- Zeitschieber aus meta.json des gewählten Modells -----------------------
async function loadMeta() {
  const model = MODELS[el("model").value];
  el("status").textContent = "Lade Modelllauf-Info …";
  el("status").className = "";
  try {
    const meta = await (await fetch(
      `${modelApiBase(model)}/data/${model.dataset}/static/meta.json`,
    )).json();
    // Der Server hält mehrere Tage Archiv (geprüft ≥5 d) — für Rückwärts-
    // trajektorien großzügiger Vorlauf; die echte Kante meldet der Integrator.
    const t0 = meta.last_run_initialisation_time - PAST_HOURS * 3600;
    const t1 = meta.data_end_time;
    state.meta = { t0, t1 };
    if (!timebar) initTimebar();
    timebar.setMeta(t0, t1, {
      tStartMs: Number.isFinite(saved.tStartMs) ? saved.tStartMs : undefined,
      playMs: Number.isFinite(saved.playMs) ? saved.playMs : undefined,
    });
    if (el("livemode").checked) timebar.setBand(timebar.playMs());
    // Clear one-shot restore so model switches keep the current playhead
    saved.tStartMs = timebar.startMs();
    saved.playMs = timebar.playMs();
    el("runinfo").textContent =
      ` · Lauf ${fmtTime(meta.last_run_initialisation_time * 1000)}, Daten bis ${fmtTime(t1 * 1000)}`;
    updateTimeLabel();
    updateReachHint();
    el("status").textContent = "";
    if (state.start) fetchStartElevation({ soft: true }); // Zeitfenster/Stunde kann sich geändert haben
  } catch (err) {
    el("status").textContent = `Modelllauf-Info nicht erreichbar: ${err.message}`;
    el("status").className = "error";
    state.meta = null;
  }
  updateRunButton();
}

function updateTimeLabel() {
  el("timelabel").textContent = fmtTime(timebarPlayMs());
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
  const dur = Math.min(72, Math.max(0.25, +el("duration").value || 12));
  const t0Ms = timebarStartMs();
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

el("direction").addEventListener("change", () => {
  updateDirectionLabels();
  updateHeightContext(); // „am Startort"/„am Zielort" hängt an der Richtung
  updateReachHint();
  timebar?.render();
});
el("model").addEventListener("change", () => {
  persist();
  loadMeta();
  updateWDetection();
  fetchStartElevation(); // Modellorographie + Level-Carets je Modell
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

/** Split a multi-start FeatureCollection into launch-window samples by start_time. */
function samplesFromLaunchGeoJSON(gj, ctx) {
  const byStart = new Map();
  for (const f of gj.features || []) {
    const st = f.properties?.start_time;
    if (!st) continue;
    if (!byStart.has(st)) byStart.set(st, []);
    byStart.get(st).push(f);
  }
  const keys = [...byStart.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  const samples = [];
  for (const st of keys) {
    const t0Ms = Date.parse(st);
    if (!Number.isFinite(t0Ms)) continue;
    const runs = runsFromApiGeoJSON(
      { type: "FeatureCollection", features: byStart.get(st) },
      { ...ctx, t0Ms },
    );
    if (runs.length) samples.push({ t0Ms, runs });
  }
  return samples;
}

// --- Launch window (throwaway 2D + 3D scrub) --------------------------------

function buildLaunchT0List(tStartMs, windowH, stepMin) {
  const tEndMs = tStartMs + windowH * 3600e3;
  const stepMs = Math.max(5, stepMin) * 60e3;
  const list = [];
  for (let t = tStartMs; t < tEndMs - 0.5; t += stepMs) list.push(t);
  if (!list.length || Math.abs(list[list.length - 1] - tEndMs) > 0.5) list.push(tEndMs);
  return list;
}

function clearLaunchWindow() {
  state.launchWindowGen += 1;
  state.launchWindow = null;
}

/** After a successful launch-window compute: align band + playhead to samples. */
function syncTimebarToLaunchWindow() {
  const lw = state.launchWindow;
  if (!lw || !timebar || lw.samples.length < 2) {
    clearLaunchWindow();
    return;
  }
  timebar.setBand(lw.tStartMs, lw.tEndMs, { syncField: true });
  timebar.setPlayMs(lw.tStartMs, { silent: true });
  morphAtStartMs(lw.tStartMs);
}

function paintMorphRuns(runs) {
  state.layers.clearLayers();
  state.pinLayers.clearLayers();
  state.runMapTracks.clear();
  for (const run of runs) {
    if ((run.r?.points || []).length < 2) continue;
    const g = L.layerGroup();
    drawCasing(run.r, g);
    // Markers need interactivity for met popups; onSelect stops line clicks from
    // bubbling to map.setStart (same as normal track select handler).
    drawTrajectory(run.r, run.color, run.label, run.dash, g, {
      onSelect: () => {},
    });
    g.addTo(state.layers);
    const key = runKey(run);
    const latlngs = run.r.points.map((p) => [p.lat, p.lon]);
    state.runMapTracks.set(key, {
      run,
      layer: g,
      bounds: latlngs.length >= 2 ? L.latLngBounds(latlngs) : null,
      parent: state.layers,
    });
  }
}

/** Lerp launch-window samples at tMs; does not touch lastRuns. */
function computeMorphRuns(tMs) {
  return computeMorphRunsAt(state.launchWindow?.samples, tMs);
}

function morphAtStartMs(tMs) {
  const runs = computeMorphRuns(tMs);
  if (!runs) return;
  paintMorphRuns(runs);
  if (view3dMod && !el("view3d").hidden) view3dMod.morphRuns(runs);
}

function buildTrajectoryApiParams({
  lat, lon, modelKey, t0Ms, t0ListMs, forecastHours, methods, direction,
  markerIntervalSec, mode, activeHeights, profile,
}) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    models: modelKey,
    timeformat: "iso8601",
    forecast_hours: String(forecastHours),
    vertical_motion: profile ? "height" : methods.join(","),
    direction: direction > 0 ? "forward" : "backward",
    marker_interval: String(markerIntervalSec / 60),
    met_extras: String(el("metextras").checked),
    format: "geojson",
    backend: apiBackend,
  });
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (t0ListMs?.length) {
    params.set("times", t0ListMs.map(iso).join(","));
  } else {
    params.set("time", iso(t0Ms));
  }
  if (profile) {
    params.set("profile_time", profile.map((w) => w.tSec).join(","));
    params.set("profile_height", profile.map((w) => w.hAgl).join(","));
    params.set("marker_interval_climbing", "10");
  } else if (mode === "amsl") {
    params.set("height_amsl", activeHeights.join(","));
  } else {
    params.set("height_agl", activeHeights.join(","));
  }
  return params;
}

async function fetchTrajectoryApi(params, { timeoutMs = 120000 } = {}) {
  const url = `${TRAJECTORY_API}/v1/trajectory?${params}`;
  if (DEBUG) console.debug("[traj] API", url);
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await resp.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Serverfehler ${resp.status}: ${body.slice(0, 180)}`);
  }
  if (!resp.ok || data?.error) {
    throw new Error(data?.reason || `HTTP ${resp.status}`);
  }
  return data;
}

async function runLaunchWindowViaApi({
  modelKey, lat, lon, methods, compareMode,
  activeHeights, markerIntervalSec, mode, direction, duration, t0Ms,
  windowH, stepMin,
}) {
  const gen = ++state.launchWindowGen;
  const t0List = buildLaunchT0List(t0Ms, windowH, stepMin);
  const n = t0List.length;
  if (n > 40) {
    setStatus(`Launch-Fenster: ${n} Starts (groß) — Start …`);
  } else {
    setStatus(`Launch-Fenster: lade ${n} Starts …`);
  }

  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  state.pinLayers.clearLayers();
  state.dimLayers.clearLayers();
  state.pinRuns.clear();
  state.pinKey = "";
  state.runMapTracks.clear();
  el("results").innerHTML = "";
  state.profileEdit = null;
  restoreStartMarkerVisibility();
  setDownloadEnabled(false);
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  showCrossSection(false);
  state.lastRuns = null;
  state.xsec = null;
  state.launchWindow = null;
  resetRunSelection();
  state.live = null;

  const forecastHours = duration;
  const wall0 = performance.now();
  // Multi-start batch can take a while; scale timeout with sample count.
  const timeoutMs = Math.min(600_000, 60_000 + n * 15_000);

  try {
    const params = buildTrajectoryApiParams({
      lat, lon, modelKey, t0ListMs: t0List, forecastHours, methods, direction,
      markerIntervalSec, mode, activeHeights, profile: null,
    });
    const data = await fetchTrajectoryApi(params, { timeoutMs });
    if (gen !== state.launchWindowGen) return;

    const samples = samplesFromLaunchGeoJSON(data, {
      mode, modelKey, direction, duration: forecastHours,
    });
    if (samples.length < 2) {
      throw new Error(
        samples.length
          ? "Launch-Fenster: API lieferte zu wenige Startzeiten"
          : "Launch-Fenster braucht mindestens 2 Starts",
      );
    }

    state.launchWindow = {
      tStartMs: samples[0].t0Ms,
      tEndMs: samples[samples.length - 1].t0Ms,
      stepMs: Math.max(5, stepMin) * 60e3,
      samples,
    };
    const first = samples[0];
    state.lastRuns = {
      runs: first.runs, modelKey, mode, t0Ms: first.t0Ms, duration: forecastHours, direction,
    };
    state.xsec = {
      runs: first.runs.map((run) => ({
        ...run,
        terrain: run.terrain || run.r.points.map(() => null),
      })),
      t0Ms: first.t0Ms,
      direction,
      overlay: compareMode,
    };
    el("results").innerHTML = "";
    for (const run of first.runs) reportResult(run.r, run.heightM, run.color, run.label, run);
    for (const k of [...state.hiddenRunKeys]) {
      if (!first.runs.some((r) => runKey(r) === k)) state.hiddenRunKeys.delete(k);
    }
    refreshMapTracklist();
    const g0 = first.runs[0]?.terrain?.find((g) => Number.isFinite(g));
    if (Number.isFinite(g0)) state.startElevation = g0;
    setDownloadEnabled(true);
    el("xsecbtn").disabled = false;
    el("view3dbtn").disabled = false;
    syncTimebarToLaunchWindow();
    const ms = performance.now() - wall0;
    setStatus(`Launch-Fenster: ${samples.length} Starts · ${fmtMs(ms)}`);
  } catch (err) {
    if (gen !== state.launchWindowGen) return;
    clearLaunchWindow();
    setStatus(`API-Fehler: ${err.message}`, true);
  } finally {
    if (gen === state.launchWindowGen) {
      state.running = false;
      updateRunButton();
    }
  }
}

async function runTrajectoriesViaApi({
  modelKey, lat, lon, methods, compareMode,
  activeHeights, markerIntervalSec, mode, direction, duration, t0Ms,
  heightProfile = null,
  profileRedraw = false,
  profileGen = null,
}) {
  clearLaunchWindow();
  const keepSiblings = profileRedraw && state.profileEdit?.active;
  state.running = true;
  updateRunButton();
  state.layers.clearLayers();
  state.pinLayers.clearLayers();
  state.pinRuns.clear();
  state.pinKey = "";
  state.runMapTracks.clear();
  if (!keepSiblings) {
    state.dimLayers.clearLayers();
    el("results").innerHTML = "";
    state.profileEdit = el("flightprofile").checked && heightProfile
      ? state.profileEdit
      : null;
    if (!state.profileEdit?.active) restoreStartMarkerVisibility();
  }
  setDownloadEnabled(false);
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  if (!keepSiblings) showCrossSection(false);
  if (!keepSiblings) {
    state.lastRuns = null;
    state.xsec = null;
    resetRunSelection();
  }
  state.live = null;
  setStatus(keepSiblings ? "API: aktualisiere Flugprofil …" : "API: lade Trajektorien …");

  const profile = heightProfile && heightProfile.length >= 2 ? heightProfile : null;
  const forecastHours = profile
    ? Math.min(duration, Math.max(1, Math.ceil(profile[profile.length - 1].tSec / 3600)))
    : duration;

  const params = buildTrajectoryApiParams({
    lat, lon, modelKey, t0Ms, forecastHours, methods, direction,
    markerIntervalSec, mode, activeHeights, profile,
  });

  const t0 = performance.now();
  try {
    const data = await fetchTrajectoryApi(params);
    const ms = performance.now() - t0;
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
      state.runMapTracks.clear();
      paintRunsAsMapTracks(runs, state.layers, pickable);
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
      for (const k of [...state.hiddenRunKeys]) {
        if (!runs.some((r) => runKey(r) === k)) state.hiddenRunKeys.delete(k);
      }
      refreshMapTracklist();
    }

    const g0 = (keepSiblings ? runs[0] : runs[0])?.terrain?.find((g) => Number.isFinite(g));
    if (Number.isFinite(g0)) state.startElevation = g0;
    setDownloadEnabled(true);
    el("xsecbtn").disabled = false;
    el("view3dbtn").disabled = false;
    if (view3dMod && !el("view3d").hidden) view3dMod.update(view3dData());
    setStatus(`API: ${keepSiblings ? "Profil" : `${runs.length} Trajektorie(n)`} · ${fmtMs(ms)}`);
    // Recalc profile Y-axis from new traj terrain immediately; DEM refresh redraws again.
    renderProfileSideView();
    refreshDemHiOverlay();
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
  const launchWindowH = Math.min(12, Math.max(0, +el("launchwindow").value || 0));
  const launchStepMin = Math.max(5, +el("launchstep").value || 15);

  if (launchWindowH > 0) {
    if (!el("useapi").checked) {
      return setStatus("Launch-Fenster braucht „API abrufen“.", true);
    }
    if (liveMode) {
      return setStatus("Launch-Fenster: Live-Modus ausschalten.", true);
    }
    if (profileOn) {
      return setStatus("Launch-Fenster: Flugprofil ausschalten.", true);
    }
  }

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
  const duration = Math.min(72, Math.max(0.25, +el("duration").value || 12));
  const t0Ms = timebarStartMs();

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
    if (launchWindowH > 0) {
      state.dimLayers.clearLayers();
      return runLaunchWindowViaApi({
        modelKey, lat, lon, methods, compareMode,
        activeHeights, markerIntervalSec, mode, direction, duration, t0Ms,
        windowH: launchWindowH, stepMin: launchStepMin,
      });
    }
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

  clearLaunchWindow();

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
    state.runMapTracks.clear();
  }
  setDownloadEnabled(false);
  el("xsecbtn").disabled = true;
  el("view3dbtn").disabled = true;
  const xsecWasOpen = !el("xsec").hidden;
  showCrossSection(false);
  state.lastRuns = null;
  state.xsec = null;
  resetRunSelection();
  refreshMapTracklist();
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
    // der aktiven Höhe lässt die Pins unangetastet (kein Flackern). Läufe als
    // einzeln schaltbare LayerGroups (Tracks-Panel).
    const pinKey = pinHeights.join(",");
    const pickable = mode === "agl" && !compareMode;
    const redrawPins = !scrub || pinKey !== state.pinKey;
    if (redrawPins) {
      state.pinLayers.clearLayers();
      state.pinKey = pinKey;
    }
    state.dimLayers.clearLayers();
    restoreStartMarkerVisibility();
    state.layers.clearLayers();
    // runMapTracks: aktive immer neu; Pins nur mitzeichnen/ersetzen wenn neu.
    if (redrawPins) {
      for (const key of [...state.runMapTracks.keys()]) {
        if (!activeRuns.some((r) => runKey(r) === key)) state.runMapTracks.delete(key);
      }
    } else {
      for (const run of activeRuns) state.runMapTracks.delete(runKey(run));
    }
    if (redrawPins) paintRunsAsMapTracks(pinRunList, state.pinLayers, pickable);
    paintRunsAsMapTracks(activeRuns, state.layers, pickable);

    // Alle sichtbaren Läufe (aktiv + Pins) nach Höhe sortiert — Ergebnisliste,
    // Querschnitt und 3D-Ansicht spiegeln so das gesamte Bild.
    const runs = [...activeRuns, ...pinRunList].sort((a, b) => a.heightM - b.heightM);
    for (const run of runs) reportResult(run.r, run.heightM, run.color, run.label, run);
    state.lastRuns = { runs, modelKey, mode, t0Ms, duration, direction };
    setDownloadEnabled(runs.length > 0);
    // Verwaiste hidden-Keys aufräumen; Tracklist aktualisieren.
    for (const k of [...state.hiddenRunKeys]) {
      if (!runs.some((r) => runKey(r) === k)) state.hiddenRunKeys.delete(k);
    }
    refreshMapTracklist();

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
    el("view3dbtn").disabled = !canOpen3d();
    if (view3dMod && !el("view3d").hidden && canOpen3d()) view3dMod.update(view3dData());
    // Scrub-Läufe sind sehr kurz und häufig — Zeit nur bei Full-Runs zeigen.
    if (!scrub) {
      setStatus(`${runs.length} Trajektorie(n) · ${fmtMs(performance.now() - t0)}`);
    } else {
      setStatus("");
    }
    if (!scrub) {
      renderProfileSideView();
      refreshDemHiOverlay();
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
    // Im Profil-Edit wählt der Klick den Kandidaten, sonst den Querschnitt.
    line.addEventListener("click", () => {
      if (state.profileEdit?.active) tryPickCandidate(run);
      else selectRun(run);
    });
    if (runKey(run) === state.selectedRunKey) line.classList.add("selected");
  }
  el("results").appendChild(line);
}

// --- Querschnitt ------------------------------------------------------------
function xsecMobile() {
  return window.matchMedia("(max-width: 700px), (max-height: 500px)").matches;
}

/** Automatische Höhe: ein Streifen je Lauf, bei Auswahl ein hoher. */
function xsecAutoHeight(data) {
  const sel = !!state.selectedRunKey && data.runs.length === 1;
  // Bei Auswahl ein einzelner, dafür hoher Streifen: er muss von Grund bis
  // Flughöhe reichen, sonst klebt das Gelände als Strich am unteren Rand.
  const h = sel
    ? Math.round(window.innerHeight * 0.42)
    : Math.min(110 * (data.overlay ? 2 : data.runs.length) + 62, Math.round(window.innerHeight * 0.55));
  return Math.max(h, 190);
}

/**
 * Größe und Lage des Panels festlegen. Gezogene Maße gewinnen, werden aber
 * immer auf das aktuelle Fenster geklemmt — damit bleibt das Panel auch nach
 * dem Verkleinern des Fensters erreichbar (Responsivität).
 */
function layoutCrossSection(data) {
  const box = el("xsec");
  if (!box || box.hidden) return;
  if (xsecMobile()) {
    // Mobil regelt das Stylesheet (volle Breite, feste Anteilshöhe).
    box.style.height = "";
    box.style.right = "";
    return;
  }
  const maxH = Math.max(XSEC_MIN_H, window.innerHeight - 2 * XSEC_EDGE);
  const wanted = xsecHeight ?? (data ? xsecAutoHeight(data) : XSEC_MIN_H);
  box.style.height = `${Math.min(maxH, Math.max(XSEC_MIN_H, wanted))}px`;

  const maxRight = Math.max(XSEC_EDGE, window.innerWidth - XSEC_EDGE - XSEC_MIN_W);
  const right = Math.min(maxRight, Math.max(XSEC_EDGE, xsecRight ?? XSEC_EDGE));
  box.style.right = `${right}px`;
  el("xsec-resize-n")?.setAttribute("aria-valuenow", String(Math.round(box.getBoundingClientRect().height)));
  el("xsec-resize-w")?.setAttribute("aria-valuenow", String(right));
}

/** Beschriftung zur jeweiligen Sicht (Auswahl oder alle Läufe). */
function sizeCrossSection(data) {
  const sel = !!state.selectedRunKey && data.runs.length === 1;
  layoutCrossSection(data);
  const dem = xsecDemEnabled() ? "DEM · " : "";
  el("xsec-hint").textContent = sel
    ? `Höhe über NN · ${dem}Modellgelände · Track ${data.runs[0].label}`
    : (data.overlay
      ? "Höhe über NN · Gelände entlang des Referenzpfads"
      : "Höhe über NN · Gelände entlang des jeweiligen Pfades");
}

function showCrossSection(show) {
  el("xsec").hidden = !show;
  el("xsecbtn").textContent = show ? "Querschnitt ausblenden" : "Querschnitt anzeigen";
  if (show && state.xsec) {
    attachDemHiToXsec();
    drawCrossSection();
    if (xsecDemEnabled()) ensureXsecDemForView();
  }
}

/** DEM für die gerade sichtbaren Läufe nachladen (Auswahl: nur diesen). */
function ensureXsecDemForView() {
  if (!state.xsec || el("xsec").hidden || !xsecDemEnabled()) return;
  const sel = selectedXsecRun();
  for (const run of sel ? [sel] : state.xsec.runs) ensureXsecDem(run);
}

/**
 * Track auswählen: der Querschnitt zeigt dann nur diesen Lauf mit DEM,
 * Modellgelände und Track. Erneutes Anklicken hebt die Auswahl auf.
 */
function selectRun(run) {
  const rk = run ? runKey(run) : null;
  state.selectedRunKey = state.selectedRunKey === rk ? null : rk;
  highlightSelectedRun();
  if (state.selectedRunKey && el("xsec").hidden) showCrossSection(true);
  else drawCrossSection();
  ensureXsecDemForView();
}

/**
 * Auswahl und DEM-Cache verwerfen — bei jedem Neurechnen, sonst zeigte ein
 * gleich benannter Lauf das Gelände des alten Pfades.
 */
function resetRunSelection() {
  state.selectedRunKey = null;
  for (const e of xsecDem.values()) e.abort?.abort();
  xsecDem.clear();
  setXsecDemStatus("");
}

function trackSelectHandler(run, pickable) {
  // Nur im laufenden Flugprofil-Edit wählt der Klick den Kandidaten; sonst
  // gehört er dem Querschnitt — wie in der Ergebnisliste.
  return () => {
    if (pickable && run.method === "height" && state.profileEdit?.active) tryPickCandidate(run);
    else selectRun(run);
  };
}

function highlightSelectedRun() {
  for (const line of el("results").querySelectorAll(".result-line")) {
    line.classList.toggle("selected", line.dataset.runKey === state.selectedRunKey);
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
// Zweispaltig: die rechte Spalte (Höhenbalken samt Beschriftungen) braucht
// rund 210 px, darum liegt das Minimum deutlich höher als bei einer Spalte.
const PANEL_W_MIN = 560;
const PANEL_W_MAX = 900;
const PANEL_W_DEFAULT = 620;

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
el("xsec-alt")?.addEventListener("change", () => {
  drawCrossSection();
  ensureXsecDemForView();
});
el("xsec-dem").addEventListener("change", () => {
  persist();
  if (!xsecDemEnabled()) setXsecDemStatus("");
  drawCrossSection();
  ensureXsecDemForView();
});
// Fenstergröße: Maße neu klemmen und den Streifen neu zeichnen.
window.addEventListener("resize", () => drawCrossSection());

/** Ziehgriffe des Querschnitts (oben Höhe, links Breite). */
(function initXsecResize() {
  const north = el("xsec-resize-n");
  const west = el("xsec-resize-w");
  if (!north || !west) return;
  north.setAttribute("aria-valuemin", String(XSEC_MIN_H));
  west.setAttribute("aria-valuemin", String(XSEC_EDGE));

  let drag = null;
  const box = () => el("xsec").getBoundingClientRect();

  north.addEventListener("pointerdown", (e) => {
    if (xsecMobile() || el("xsec").hidden) return;
    e.preventDefault();
    north.setPointerCapture(e.pointerId);
    document.body.classList.add("xsec-resizing-n");
    drag = { axis: "n", pointerId: e.pointerId, startY: e.clientY, start: box().height };
  });
  west.addEventListener("pointerdown", (e) => {
    if (xsecMobile() || el("xsec").hidden) return;
    e.preventDefault();
    west.setPointerCapture(e.pointerId);
    document.body.classList.add("xsec-resizing-w");
    drag = { axis: "w", pointerId: e.pointerId, startX: e.clientX, start: xsecRight ?? XSEC_EDGE };
  });

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.axis === "n") {
      // Nach oben ziehen → höheres Panel (es hängt am unteren Rand).
      xsecHeight = drag.start + (drag.startY - e.clientY);
    } else {
      // Nach rechts ziehen → größerer rechter Abstand → schmaleres Panel.
      xsecRight = drag.start + (e.clientX - drag.startX);
    }
    drawCrossSection();
  };
  const onEnd = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    document.body.classList.remove("xsec-resizing-n", "xsec-resizing-w");
    try {
      (drag.axis === "n" ? north : west).releasePointerCapture(e.pointerId);
    } catch { /* Griff schon freigegeben */ }
    drag = null;
    persist();
  };
  for (const h of [north, west]) {
    h.addEventListener("pointermove", onMove);
    h.addEventListener("pointerup", onEnd);
    h.addEventListener("pointercancel", onEnd);
  }

  north.addEventListener("keydown", (e) => {
    if (el("xsec").hidden || xsecMobile()) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 16;
    xsecHeight = box().height + (e.key === "ArrowUp" ? step : -step);
    drawCrossSection();
    persist();
  });
  west.addEventListener("keydown", (e) => {
    if (el("xsec").hidden || xsecMobile()) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 16;
    xsecRight = (xsecRight ?? XSEC_EDGE) + (e.key === "ArrowRight" ? step : -step);
    drawCrossSection();
    persist();
  });

  // Doppelklick auf einen Griff: zurück zur automatischen Größe.
  north.addEventListener("dblclick", () => {
    xsecHeight = null;
    drawCrossSection();
    persist();
  });
  west.addEventListener("dblclick", () => {
    xsecRight = null;
    drawCrossSection();
    persist();
  });
})();

// --- Flugspuren (GPX/KML/GeoJSON Overlays) ----------------------------------
const OVERLAY_COLORS = [
  "#c45c26", "#5c6bc0", "#00897b", "#8e24aa", "#f9a825", "#546e7a", "#d81b60", "#00838f",
];
let overlayIdSeq = 0;

/** @type {import("leaflet").Control | null} */
let mapTracklistCtl = null;
/** @type {HTMLElement | null} */
let mapTracklistBody = null;

function nextOverlayColor() {
  const used = new Set(state.overlays.map((o) => o.color));
  return OVERLAY_COLORS.find((c) => !used.has(c))
    || OVERLAY_COLORS[state.overlays.length % OVERLAY_COLORS.length];
}

/** Schwebendes Tracks-Panel (topright), analog HTML-Export. */
function ensureMapTracklistPanel() {
  if (mapTracklistCtl) return;
  mapTracklistBody = document.createElement("div");
  const Ctl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create("div", "map-tracks-panel");
      const head = L.DomUtil.create("div", "gv-panel-head", d);
      head.textContent = "Tracks";
      const wrap = L.DomUtil.create("div", "gv-panel-body", d);
      wrap.appendChild(mapTracklistBody);
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      head.addEventListener("dblclick", (e) => {
        e.preventDefault();
        d.classList.toggle("collapsed");
      });
      let drag = null;
      head.addEventListener("pointerdown", (e) => {
        const r = d.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId);
        d.style.position = "fixed";
        d.style.margin = "0";
      });
      head.addEventListener("pointermove", (e) => {
        if (!drag) return;
        d.style.left = `${e.clientX - drag.dx}px`;
        d.style.top = `${e.clientY - drag.dy}px`;
        d.style.right = "auto";
        d.style.bottom = "auto";
      });
      head.addEventListener("pointerup", (e) => {
        drag = null;
        try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      });
      return d;
    },
  });
  mapTracklistCtl = new Ctl({ position: "topright" });
  map.addControl(mapTracklistCtl);
}

function setMapTracklistVisible(on) {
  const elPanel = document.querySelector(".map-tracks-panel");
  if (elPanel) elPanel.style.display = on ? "" : "none";
}

/** Tracks-Panel aus Trajektorien + Flugspuren neu füllen. */
function refreshMapTracklist() {
  const runs = state.lastRuns?.runs || [];
  const overlays = state.overlays.filter((o) => o.coords?.length >= 2);
  if (!runs.length && !overlays.length) {
    setMapTracklistVisible(false);
    return;
  }
  ensureMapTracklistPanel();
  setMapTracklistVisible(true);
  const body = mapTracklistBody;
  body.innerHTML = "";

  for (const run of runs) {
    const key = runKey(run);
    const entry = state.runMapTracks.get(key);
    const row = document.createElement("div");
    row.className = "gv-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !state.hiddenRunKeys.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        state.hiddenRunKeys.delete(key);
        if (entry) entry.layer.addTo(entry.parent || state.layers);
      } else {
        state.hiddenRunKeys.add(key);
        if (entry) (entry.parent || state.layers).removeLayer(entry.layer);
      }
    });

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = run.color;

    const name = document.createElement("span");
    name.className = "gv-name";
    name.textContent = run.label;
    name.title = run.label;

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "gv-zoom";
    zoom.textContent = "⤢";
    zoom.title = "Auf diesen Track zoomen";
    zoom.addEventListener("click", () => {
      const b = entry?.bounds;
      if (b?.isValid?.()) map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
    });

    row.append(cb, chip, name, zoom);
    body.appendChild(row);
  }

  if (overlays.length) {
    const head = document.createElement("div");
    head.className = "gv-section";
    head.textContent = "Flugspuren";
    body.appendChild(head);

    for (const o of overlays) {
      const row = document.createElement("div");
      row.className = "gv-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = o.visible !== false;
      cb.addEventListener("change", () => {
        o.visible = cb.checked;
        if (o._mapLayer) {
          if (cb.checked) o._mapLayer.addTo(state.overlayLayers);
          else state.overlayLayers.removeLayer(o._mapLayer);
        } else {
          redrawOverlayMap();
        }
        // Side-Panel-Checkbox mitziehen
        const side = el("overlays-list")?.querySelector(`.overlay-card[data-id="${o.id}"] input[type="checkbox"]`);
        if (side && side.checked !== cb.checked) side.checked = cb.checked;
        refreshOverlays3d();
        updateView3dButton();
      });

      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.background = o.color;

      const name = document.createElement("span");
      name.className = "gv-name";
      name.textContent = o.name;
      if (o.note) name.title = o.note;

      const zoom = document.createElement("button");
      zoom.type = "button";
      zoom.className = "gv-zoom";
      zoom.textContent = "⤢";
      zoom.title = "Auf diese Flugspur zoomen";
      zoom.addEventListener("click", () => {
        const b = o._bounds;
        if (b?.isValid?.()) map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
      });

      row.append(cb, chip, name, zoom);
      body.appendChild(row);
    }
  }
}

function redrawOverlayMap() {
  state.overlayLayers.clearLayers();
  for (const o of state.overlays) {
    o._mapLayer = null;
    o._bounds = null;
    if (o.coords.length < 2) continue;
    const latlngs = o.coords.map((c) => [c.lat, c.lon]);
    const bounds = L.latLngBounds(latlngs);
    const group = L.layerGroup();
    const line = L.polyline(latlngs, {
      color: o.color,
      weight: 3.5,
      opacity: 0.9,
      dashArray: "6 4",
    }).bindTooltip(o.name, { sticky: true });
    if (o.note) {
      const esc = (s) => String(s).replace(/[<>&]/g, (ch) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
      line.bindPopup(`<strong>${esc(o.name)}</strong>` +
        `<div style="margin-top:4px;white-space:pre-wrap">${esc(o.note)}</div>`);
    }
    line.addTo(group);
    o._mapLayer = group;
    o._bounds = bounds;
    if (o.visible !== false) group.addTo(state.overlayLayers);
  }
  refreshMapTracklist();
}

function renderOverlaysList() {
  const host = el("overlays-list");
  if (!host) return;
  host.innerHTML = "";
  for (const o of state.overlays) {
    const card = document.createElement("div");
    card.className = "overlay-card";
    card.dataset.id = o.id;

    const head = document.createElement("div");
    head.className = "overlay-card-head";

    const vis = document.createElement("input");
    vis.type = "checkbox";
    vis.checked = o.visible !== false;
    vis.title = "Sichtbar";
    vis.addEventListener("change", () => {
      o.visible = vis.checked;
      redrawOverlayMap();
      refreshOverlays3d();
      updateView3dButton();
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = o.name;
    name.addEventListener("change", () => {
      o.name = name.value.trim() || o.sourceName || "Flugspur";
      redrawOverlayMap();
      renderOverlaysList();
      refreshOverlays3d();
    });

    const color = document.createElement("input");
    color.type = "color";
    color.value = o.color;
    color.addEventListener("input", () => {
      o.color = color.value;
      redrawOverlayMap();
      refreshOverlays3d();
    });

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "overlay-rm";
    rm.title = "Entfernen";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      state.overlays = state.overlays.filter((x) => x.id !== o.id);
      redrawOverlayMap();
      renderOverlaysList();
      refreshOverlays3d();
      updateView3dButton();
    });

    head.append(vis, name, color, rm);

    const note = document.createElement("textarea");
    note.placeholder = "Notiz…";
    note.value = o.note || "";
    note.addEventListener("change", () => {
      o.note = note.value;
      redrawOverlayMap();
      refreshOverlays3d();
    });

    card.append(head, note);
    host.appendChild(card);
  }
}

function refreshOverlays3d() {
  if (view3dMod && !el("view3d").hidden) view3dMod.update(view3dData());
}

async function importOverlayFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const newIds = [];
  const warnings = [];
  const { parseOverlayBytes } = await import("./overlays/parse.js");
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
      const id = `ov-${++overlayIdSeq}`;
      state.overlays.push({
        id,
        name: d.name,
        color: nextOverlayColor(),
        note: "",
        sourceName: d.sourceName,
        visible: true,
        coords: d.coords,
      });
      newIds.push(id);
    }
  }
  redrawOverlayMap();
  renderOverlaysList();
  updateView3dButton();
  if (newIds.length) {
    const added = state.overlays.filter((o) => newIds.includes(o.id));
    const bounds = L.latLngBounds(added.flatMap((o) => o.coords.map((c) => [c.lat, c.lon])));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    await openOrRefresh3d({ flyToOverlayIds: newIds });
    setStatus(`${newIds.length} Flugspur(en) geladen`);
  } else {
    setStatus(warnings[0] || "Keine Flugspuren in der Datei.", true);
  }
  if (warnings.length && newIds.length) console.warn("Overlay-Import:", warnings);
}

el("overlay-add")?.addEventListener("click", () => el("overlay-file")?.click());
el("overlay-file")?.addEventListener("change", async (e) => {
  const input = e.target;
  try {
    await importOverlayFiles(input.files);
  } finally {
    input.value = "";
  }
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
    runs: state.lastRuns?.runs || [],
    start: state.start,
    modelElev: state.xsec?.runs?.[0]?.terrain?.[0] ?? state.startElevation,
    overlays: state.overlays,
  };
}

/** Prefer current launch-window morph for open/show; lastRuns otherwise. */
function view3dDisplayData() {
  const base = view3dData();
  if (state.launchWindow?.samples?.length >= 2) {
    const runs = computeMorphRuns(timebarPlayMs());
    if (runs?.length) return { ...base, runs };
  }
  return base;
}

function canOpen3d() {
  return (state.lastRuns?.runs?.length > 0) || state.overlays.some((o) => o.visible !== false);
}

function updateView3dButton() {
  el("view3dbtn").disabled = !canOpen3d() && el("view3d").hidden;
  if (!el("view3d").hidden) el("view3dbtn").disabled = false;
}

function hide3D() {
  el("view3d").hidden = true;
  el("view3dbtn").textContent = "3D-Ansicht";
  updateView3dButton();
}

/** 3D öffnen/aktualisieren; nach Import auf neue Spuren zoomen. */
async function openOrRefresh3d({ flyToOverlayIds } = {}) {
  if (!canOpen3d() && !(flyToOverlayIds?.length)) return;
  el("view3dbtn").disabled = true;
  setStatus("Lade 3D-Ansicht …");
  try {
    view3dMod ??= await import("./view3d.js");
    el("view3d").hidden = false;
    layoutView3d();
    await view3dMod.show(view3dDisplayData(), { flyToOverlayIds });
    el("view3dbtn").textContent = "3D-Ansicht schließen";
    setStatus("");
  } catch (err) {
    hide3D();
    setStatus(`3D-Ansicht: ${err.message}`, true);
  } finally {
    updateView3dButton();
  }
}

el("view3dbtn").addEventListener("click", async () => {
  if (!el("view3d").hidden) return hide3D();
  if (!canOpen3d()) return;
  await openOrRefresh3d();
});
el("v3d-close").addEventListener("click", hide3D);

// --- Export-Einstellungen: Dialog ------------------------------------------
function applyExportOptsUI() {
  for (const [id, fmt, key, kind] of EXPORT_FIELDS) {
    const node = el(id);
    if (!node) continue;
    const v = exportOpts[fmt][key];
    if (kind === "bool") node.checked = !!v;
    else node.value = String(v);
  }
}

function readExportOptsUI() {
  for (const [id, fmt, key, kind] of EXPORT_FIELDS) {
    const node = el(id);
    if (!node) continue;
    if (kind === "bool") exportOpts[fmt][key] = !!node.checked;
    else if (kind === "num") {
      const n = Number(node.value);
      if (Number.isFinite(n)) exportOpts[fmt][key] = n;
    } else exportOpts[fmt][key] = node.value;
  }
}

/** Nur den Abschnitt des gewählten Formats zeigen. */
function showExportSection(fmt) {
  for (const sec of document.querySelectorAll("#ex-modal .ex-sec")) {
    sec.hidden = sec.dataset.fmt !== fmt;
  }
}

function openExportModal() {
  showExportSection(el("downloadfmt").value);
  applyFilenamePatternUI();
  updateFilenamePreview();
  el("ex-modal").hidden = false;
}

function closeExportModal() {
  el("ex-modal").hidden = true;
}

function applyFilenamePatternUI() {
  const inp = el("ex-filename-pattern");
  if (inp) inp.value = filenamePattern;
}

function readFilenamePatternUI() {
  const inp = el("ex-filename-pattern");
  if (!inp) return;
  filenamePattern = inp.value.trim() || DEFAULT_FILENAME_PATTERN;
  if (inp.value.trim() !== filenamePattern) inp.value = filenamePattern;
}

function filenameCtxSync() {
  const modelKey = el("model")?.value || state.lastRuns?.modelKey || "icon_d2";
  const model = MODELS[modelKey];
  const t0Ms = state.lastRuns?.t0Ms ?? timebarStartMs();
  return {
    t0Ms: Number.isFinite(t0Ms) ? t0Ms : Date.now(),
    place: state.startPlace,
    lat: state.start?.lat,
    lon: state.start?.lon,
    durationH: state.lastRuns?.duration ?? (+el("duration")?.value || 12),
    direction: state.lastRuns?.direction ?? (+el("direction")?.value || 1),
    modelLabel: model?.label || modelKey,
  };
}

async function updateFilenamePreview() {
  const preview = el("ex-filename-preview");
  if (!preview) return;
  // Vorschau: fehlenden Ortsnamen per Reverse-Geocode nachziehen (nicht nur beim Download).
  if (!state.startPlace && state.start) scheduleReversePlaceForFilename();
  try {
    const { buildExportFilename } = await import("./export/filename.ts");
    const key = DOWNLOAD_FORMATS[el("downloadfmt")?.value] ? el("downloadfmt").value : "html";
    const ext = DOWNLOAD_FORMATS[key]?.ext || "html";
    const name = buildExportFilename(filenamePattern, filenameCtxSync(), ext);
    preview.textContent = `Vorschau: ${name}`;
  } catch {
    preview.textContent = "";
  }
}

/** @type {ReturnType<typeof setTimeout> | null} */
let reversePlaceTimer = null;
/** Letzter Versuch: „lat,lon“ (4 Nachkommastellen). */
let reversePlaceKey = null;

function scheduleReversePlaceForFilename() {
  if (!state.start || state.startPlace) return;
  const key = `${state.start.lat.toFixed(4)},${state.start.lon.toFixed(4)}`;
  if (reversePlaceKey === key) return; // schon versucht / läuft
  clearTimeout(reversePlaceTimer);
  reversePlaceTimer = setTimeout(() => {
    void (async () => {
      if (!state.start || state.startPlace) return;
      const k = `${state.start.lat.toFixed(4)},${state.start.lon.toFixed(4)}`;
      reversePlaceKey = k;
      await resolveExportPlaceName();
      if (state.startPlace) updateFilenamePreview();
    })();
  }, 350);
}

/** Ort auflösen: Geocode-Text → Reverse → Koordinaten im Builder. */
async function resolveExportPlaceName() {
  if (state.startPlace) return state.startPlace;
  if (!state.start) return null;
  try {
    const name = await reversePlaceName(state.start.lat, state.start.lon);
    if (name) {
      state.startPlace = name;
      persist();
      return name;
    }
  } catch {
    /* Fallback über lat/lon im Filename-Builder */
  }
  return null;
}

async function buildDownloadFilename(ext) {
  readFilenamePatternUI();
  await resolveExportPlaceName();
  const { buildExportFilename } = await import("./export/filename.ts");
  return buildExportFilename(filenamePattern, filenameCtxSync(), ext);
}

el("exportcfg").addEventListener("click", openExportModal);
el("ex-modal-close").addEventListener("click", closeExportModal);
el("ex-modal").addEventListener("click", (e) => {
  if (e.target === el("ex-modal")) closeExportModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("ex-modal").hidden) closeExportModal();
});
el("ex-modal").addEventListener("input", (e) => {
  const id = e.target?.id || "";
  if (id === "ex-filename-pattern") {
    readFilenamePatternUI();
    persist();
    updateFilenamePreview();
    return;
  }
  if (id.startsWith("ex-share-")) {
    // Owner/Repo: abgeleitete Pages-Basis mitziehen, solange nicht custom.
    if ((id === "ex-share-owner" || id === "ex-share-repo") && !shareGithub.pagesBaseCustom) {
      const o = el("ex-share-owner").value.trim() || SHARE_GITHUB_DEFAULTS.owner;
      const r = el("ex-share-repo").value.trim() || SHARE_GITHUB_DEFAULTS.repo;
      el("ex-share-pagesbase").value = defaultSharePagesBase(o, r);
    }
    if (id === "ex-share-pagesbase") {
      const o = el("ex-share-owner").value.trim() || SHARE_GITHUB_DEFAULTS.owner;
      const r = el("ex-share-repo").value.trim() || SHARE_GITHUB_DEFAULTS.repo;
      const auto = defaultSharePagesBase(o, r);
      const typed = el("ex-share-pagesbase").value.trim();
      shareGithub.pagesBaseCustom = !!(typed && typed !== auto && typed !== auto.replace(/\/$/, ""));
    }
    readShareGithubUI();
    persist();
    return;
  }
  readExportOptsUI();
  persist();
});
el("ex-modal").addEventListener("change", (e) => {
  const id = String(e.target?.id || "");
  if (id === "ex-filename-pattern") {
    readFilenamePatternUI();
    persist();
    updateFilenamePreview();
    return;
  }
  if (id.startsWith("ex-share-")) {
    readShareGithubUI();
    persist();
    return;
  }
  readExportOptsUI();
  persist();
});
el("ex-reset").addEventListener("click", () => {
  const fmt = el("downloadfmt").value;
  exportOpts[fmt] = { ...EXPORT_DEFAULTS[fmt] };
  filenamePattern = DEFAULT_FILENAME_PATTERN;
  applyExportOptsUI();
  applyFilenamePatternUI();
  updateFilenamePreview();
  persist();
});
el("downloadfmt").addEventListener("change", () => {
  showExportSection(el("downloadfmt").value);
  updateFilenamePreview();
  persist();
});


// --- Export (GeoJSON / GPX / KML / HTML) ------------------------------------
const DOWNLOAD_FORMATS = {
  geojson: {
    ext: "geojson", type: "application/geo+json",
    build: (d, ctx) => JSON.stringify(buildGeoJSON(d, ctx)),
  },
  gpx: { ext: "gpx", type: "application/gpx+xml", build: buildGPX },
  kml: { ext: "kml", type: "application/vnd.google-earth.kml+xml", build: buildKML },
  // Eigenständige Leaflet-Karte; Modul wird erst beim Export geladen, damit
  // der eingebettete Leaflet-Text nicht im Hauptbündel liegt.
  html: { ext: "html", type: "text/html;charset=utf-8", build: null, lazy: true },
};

// Wiederherstellung erst hier: sie liest DOWNLOAD_FORMATS, das oben in der
// zeitlichen Totzone läge. `persist()` ist zu diesem Zeitpunkt bereits scharf,
// setzt aber dieselben Werte — daher unschädlich.
if (DOWNLOAD_FORMATS[saved.downloadFmt]) el("downloadfmt").value = saved.downloadFmt;
applyExportOptsUI();
applyShareGithubUI();
applyFilenamePatternUI();
showExportSection(el("downloadfmt").value);
if (saved.start && Number.isFinite(saved.start.lat) && Number.isFinite(saved.start.lon)) {
  setStart(saved.start.lat, saved.start.lon, {
    placeName: saved.startPlace || null,
  });
}
updateFilenamePreview();
for (const id of ["duration", "direction", "model"]) {
  el(id)?.addEventListener("change", updateFilenamePreview);
  el(id)?.addEventListener("input", updateFilenamePreview);
}

/** @type {typeof import("./export/html.ts") | null} */
let htmlExportMod = null;

/** Alles, was die Bauer über `state.lastRuns` hinaus brauchen. */
function exportCtx(key) {
  return {
    xsec: state.xsec,
    opts: exportOpts[key] || {},
    unitState: { ...unitState },
    markerFields: kmlMarkerFields,
    trackName,
    start: state.start,
    modelElev: state.xsec?.runs?.[0]?.terrain?.[0] ?? state.startElevation,
    overlays: state.overlays
      .filter((o) => o.visible !== false && o.coords?.length >= 2)
      .map((o) => ({
        name: o.name,
        color: o.color,
        note: o.note || "",
        visible: true,
        coords: o.coords.map((c) => [c.lat, c.lon, c.z]),
      })),
    launchWindow: state.launchWindow?.samples?.length >= 2
      ? {
        tStartMs: state.launchWindow.tStartMs,
        tEndMs: state.launchWindow.tEndMs,
        stepMs: state.launchWindow.stepMs,
        samples: state.launchWindow.samples,
      }
      : null,
  };
}

el("download").addEventListener("click", async () => {
  if (!state.lastRuns) return;
  const key = DOWNLOAD_FORMATS[el("downloadfmt").value] ? el("downloadfmt").value : "geojson";
  const fmt = DOWNLOAD_FORMATS[key];
  const ctx = exportCtx(key);
  let text;
  if (fmt.lazy) {
    setDownloadEnabled(false);
    setStatus("Baue HTML-Karte …");
    try {
      htmlExportMod ??= await import("./export/html.ts");
      text = htmlExportMod.buildHTML(state.lastRuns, ctx);
      setStatus("");
    } catch (err) {
      setStatus(`HTML-Export: ${err?.message || err}`, true);
      return;
    } finally {
      setDownloadEnabled(true);
    }
  } else {
    text = fmt.build(state.lastRuns, ctx);
  }
  const blob = new Blob([text], { type: fmt.type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = await buildDownloadFilename(fmt.ext);
  a.click();
  URL.revokeObjectURL(a.href);
});

el("sharehtml").addEventListener("click", async () => {
  if (!state.lastRuns) return;
  readShareGithubUI();
  readFilenamePatternUI();
  if (!shareGithub.token.trim()) {
    setStatus("Teilen: GitHub-PAT in den Export-Einstellungen setzen.", true);
    openExportModal();
    showExportSection("html");
    return;
  }
  if (!shareGithub.owner.trim() || !shareGithub.repo.trim()) {
    setStatus("Teilen: Owner und Repo setzen.", true);
    openExportModal();
    return;
  }
  setDownloadEnabled(false);
  setStatus("Baue HTML und lade zu GitHub hoch …");
  try {
    htmlExportMod ??= await import("./export/html.ts");
    const { shareHtml, waitForPagesUrl } = await import("./export/shareGithub.ts");
    const html = htmlExportMod.buildHTML(state.lastRuns, exportCtx("html"));
    const filename = await buildDownloadFilename("html");
    const pagesBase = shareGithub.pagesBaseCustom && shareGithub.pagesBase
      ? shareGithub.pagesBase
      : defaultSharePagesBase(shareGithub.owner, shareGithub.repo);
    const { pagesUrl } = await shareHtml({
      html,
      filename,
      token: shareGithub.token,
      owner: shareGithub.owner,
      repo: shareGithub.repo,
      branch: shareGithub.branch,
      pagesBase,
      unique: true,
    });
    try {
      await navigator.clipboard.writeText(pagesUrl);
    } catch {
      /* Clipboard optional */
    }
    setStatus(`Geteilt — Link kopiert. Warte auf GitHub Pages … ${pagesUrl}`);
    const ready = await waitForPagesUrl(pagesUrl, { timeoutMs: 90_000, intervalMs: 3_000 });
    if (ready) setStatusWithLink("Pages bereit — Link kopiert: ", pagesUrl);
    else {
      setStatus(
        `Hochgeladen; Pages noch nicht erreichbar (oft 1–2 min). Link: ${pagesUrl}`,
        true,
      );
    }
  } catch (err) {
    setStatus(`Teilen: ${err?.message || err}`, true);
  } finally {
    setDownloadEnabled(true);
  }
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

function buildGeoJSON({ runs, modelKey, mode, t0Ms, duration, direction }, ctx = {}) {
  const prec = Number.isFinite(ctx.opts?.precision) ? ctx.opts.precision : 5;
  const f = 10 ** prec;
  const rd = (x) => Math.round(x * f) / f;
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
function buildGPX({ runs, modelKey, t0Ms, direction }, ctx = {}) {
  const iso = (ms) => new Date(ms).toISOString();
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Windtrajektorien"' +
      ' xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpx_style="http://www.topografix.com/GPX/gpx_style/0/2"' +
      ' xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3">',
    `  <metadata><name>Trajektorien ${xmlEsc(modelKey)}</name><time>${iso(t0Ms)}</time></metadata>`,
  ];
  // Das GPX-Schema verlangt <wpt> vor <trk> — daher zuerst.
  if (ctx.opts?.markersAsWaypoints) {
    for (const run of runs) {
      for (const m of run.r.markers || []) {
        if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
        const ele = Number.isFinite(m.z) ? `<ele>${Math.round(m.z)}</ele>` : "";
        const hhmm = new Date(m.tMs).toISOString().slice(11, 16);
        out.push(`  <wpt lat="${m.lat.toFixed(6)}" lon="${m.lon.toFixed(6)}">${ele}` +
          `<time>${iso(m.tMs)}</time>` +
          `<name>${xmlEsc(`${run.label} ${hhmm}`)}</name></wpt>`);
      }
    }
  }
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

/** Marker detail rows (label + value). ASCII ExtendedData keys for BalloonStyle $[…]. */
function kmlMarkerFields(m, label) {
  const dir = (Math.atan2(-(m.u || 0), -(m.v || 0)) * 180 / Math.PI + 360) % 360;
  return [
    { key: "Zeit", label: "Zeit", value: fmtTime(m.tMs) },
    { key: "Serie", label: "Serie", value: label },
    Number.isFinite(m.z) ? { key: "Hoehe_NN", label: "Höhe NN", value: fmtHeight(m.z) } : null,
    Number.isFinite(m.u) && Number.isFinite(m.v)
      ? { key: "Wind", label: "Wind", value: `${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°` }
      : null,
    Number.isFinite(m.met?.t) ? { key: "T", label: "T", value: `${m.met.t.toFixed(1)} °C` } : null,
    Number.isFinite(m.met?.td) ? { key: "Td", label: "Td", value: `${m.met.td.toFixed(1)} °C` } : null,
    Number.isFinite(m.met?.rh) ? { key: "RH", label: "RH", value: `${Math.round(m.met.rh)} %` } : null,
    Number.isFinite(m.met?.p) ? { key: "p", label: "p", value: `${m.met.p.toFixed(0)} hPa` } : null,
    { key: "Position", label: "Position", value: `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E` },
  ].filter((r) => r && r.value != null && r.value !== "");
}

/** ExtendedData + plain description. Android shows <description>; Web uses BalloonStyle
 *  ($[description] in <pre>) and/or ExtendedData — HTML tables/br are stripped on GE Web. */
function kmlMarkerDetails(m, label) {
  const fields = kmlMarkerFields(m, label);
  const ext = fields.map((f) =>
    `        <Data name="${xmlEsc(f.key)}"><value>${xmlEsc(f.value)}</value></Data>`);
  const description = fields.map((f) => `${f.label}: ${f.value}`).join("\n");
  return { ext, description };
}

/** Stable Style id from track color (#rrggbb → hex without #). */
function kmlStyleId(hex) {
  return `m-${String(hex).replace("#", "").toLowerCase()}`;
}

/** KML — Folder per track: LineString + clickable marker Point Placemarks
 *  (description + ExtendedData + BalloonStyle). Earth Web rejects Region/Lod. */
function buildKML({ runs, modelKey, direction }, ctx = {}) {
  const o = {
    markers: true, iconScale: 1.6, labelScale: 0.7, lineWidth: 3,
    clampToGround: false, hideLabels: true, ...ctx.opts,
  };
  const labelScale = o.hideLabels ? 0 : o.labelScale;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>Trajektorien ${xmlEsc(modelKey)}</name>`,
  ];
  // Shared IconStyle per color (referenced by marker Placemarks).
  const seenColors = new Set();
  for (const run of runs) {
    const id = kmlStyleId(run.color);
    if (seenColors.has(id)) continue;
    seenColors.add(id);
    out.push(`    <Style id="${id}">`);
    out.push("      <IconStyle>");
    out.push(`        <color>${kmlColor(run.color)}</color>`);
    // Larger hit target for Google Earth Web / mobile tap.
    out.push(`        <scale>${o.iconScale}</scale>`);
    out.push("        <Icon>");
    out.push("          <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>");
    out.push("        </Icon>");
    out.push("      </IconStyle>");
    out.push(`      <LabelStyle><scale>${labelScale}</scale></LabelStyle>`);
    // <pre> keeps newlines; GE Web collapses plain description whitespace otherwise.
    out.push("      <BalloonStyle>");
    out.push("        <text><![CDATA[<b>$[name]</b><pre>$[description]</pre>]]></text>");
    out.push("      </BalloonStyle>");
    out.push("    </Style>");
  }

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
    const name = trackName(run, direction);
    const styleId = kmlStyleId(run.color);

    out.push("    <Folder>");
    out.push(`      <name>${xmlEsc(name)}</name>`);
    out.push("      <Placemark>");
    out.push(`        <name>${xmlEsc(name)}</name>`);
    out.push(`        <Style><LineStyle><color>${kmlColor(run.color)}</color><width>${o.lineWidth}</width></LineStyle></Style>`);
    out.push("        <LineString>");
    out.push(`          <altitudeMode>${has3d && !o.clampToGround ? "absolute" : "clampToGround"}</altitudeMode>`);
    out.push("          <tessellate>1</tessellate>");
    out.push(`          <coordinates>${coords}</coordinates>`);
    out.push("        </LineString>");
    out.push("      </Placemark>");

    for (const m of o.markers ? (run.r.markers || []) : []) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
      const zPart = Number.isFinite(m.z) ? `,${Math.round(m.z)}` : "";
      const altMode = Number.isFinite(m.z) && !o.clampToGround ? "absolute" : "clampToGround";
      const hhmm = new Date(m.tMs).toISOString().slice(11, 16);
      const markName = Number.isFinite(m.z) ? `${hhmm} / ${fmtHeight(m.z)}` : hhmm;
      const { ext, description } = kmlMarkerDetails(m, run.label);
      out.push("      <Placemark>");
      out.push(`        <name>${xmlEsc(markName)}</name>`);
      out.push(`        <description><![CDATA[${description}]]></description>`);
      out.push(`        <styleUrl>#${styleId}</styleUrl>`);
      if (ext.length) {
        out.push("        <ExtendedData>");
        out.push(...ext);
        out.push("        </ExtendedData>");
      }
      out.push("        <Point>");
      out.push(`          <altitudeMode>${altMode}</altitudeMode>`);
      out.push(`          <coordinates>${m.lon.toFixed(6)},${m.lat.toFixed(6)}${zPart}</coordinates>`);
      out.push("        </Point>");
      out.push("      </Placemark>");
    }
    out.push("    </Folder>");
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

/** Status line with a clickable URL (new tab). */
function setStatusWithLink(prefix, url, { isError = false } = {}) {
  const box = el("status");
  box.className = isError ? "error" : "";
  box.replaceChildren();
  if (prefix) box.append(document.createTextNode(prefix));
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = url;
  a.className = "status-link";
  box.appendChild(a);
}

loadMeta();
