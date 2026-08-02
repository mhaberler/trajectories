import * as Cesium from "cesium";
import { MartiniTerrainProvider, rgbTerrainToGrid, createQuantizedMeshData } from "@macrostrat/cesium-martini";
import Martini from "@mapbox/martini";
import { PMTiles } from "pmtiles";
import { fmtHeight, fmtWind } from "./units.js";

// 3D-Ansicht (CesiumJS): zeichnet die zuletzt berechneten Trajektorien als
// Höhenlinien mit halbtransparenter Wand zum Boden über gestreamtem Gelände.
// Cesium + Martini werden per Vite gebündelt und erst beim ersten Öffnen
// nachgeladen (dynamic import aus app.js); die 2D-App bleibt leicht.
//
// Gelände:
//  - Re:Earth (frei; quantized-mesh, Mapterhorn-DEM mit EGM2008)
//  - MapTerhorn Martini (Terrarium DEM via planet.pmtiles, client-side mesh)
//  - Cesium World Terrain (braucht Ion-Token)
//  - flach (Ellipsoid) als Fallback
//
// Kartengrundlagen: Esri hybrid, OSM, VersaTiles Satellit (getrennt wählbar).
//
// Höhenbezug: Die Trajektorien führen Meter über NN (Geoid), Cesium rechnet
// in Höhen über dem WGS84-Ellipsoid (~45-50 m Unterschied in den Alpen).
// Der Versatz wird am Startpunkt kalibriert: Cesium-Geländehöhe minus
// Modellorographie — das gleicht Geoid-Undulation und Modell-vs.-Realgelände
// in einem Schritt aus.
//
// Überhöhung: scene.verticalExaggeration wirkt nur auf das Gelände, nicht
// auf Entities — die Trajektorienhöhen werden deshalb mit demselben Faktor
// selbst skaliert, damit beide zusammenpassen.

const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";
const MAPTERHORN_PMTILES_URL = "https://download.mapterhorn.com/planet.pmtiles";
const VERSATILES_SAT_URL = "https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}";
const STORAGE_KEY = "trajectories.view3d.v1";

const el = (id) => document.getElementById(id);

let viewer = null;
let lastData = null;   // { runs, start, modelElev }
let zOffset = 0;       // Ellipsoid/Geoid/Modell-Abgleich (m), am Startpunkt kalibriert
let terrainKind = "flat"; // tatsächlich aktive Quelle (nach evtl. Fallback)
let calKey = null;     // wofür zOffset gilt: Startpunkt + Geländequelle
let wired = false;
let martiniProvider = null;

const prefs = loadPrefs();

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* Speichern ist Komfort, nie Fehlerquelle */
  }
}

// ─── MapTerhorn Terrarium via PMTiles + Martini (from flightreviewer) ───────

class PMTilesHeightmapResource {
  constructor({ url, tileSize = 512, maxZoom = 12, credit }) {
    this.pmtiles = new PMTiles(url);
    this.tileSize = tileSize;
    this.maxZoom = maxZoom;
    this.credit = credit;
    this._canvasQueue = [];
  }

  _getCanvas() {
    let ref = this._canvasQueue.pop();
    if (!ref) {
      const canvas = document.createElement("canvas");
      canvas.width = this.tileSize;
      canvas.height = this.tileSize;
      ref = { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
    }
    return ref;
  }

  async getTilePixels(coords) {
    const resp = await this.pmtiles.getZxy(coords.z, coords.x, coords.y);
    if (!resp?.data) return undefined;
    const bitmap = await createImageBitmap(new Blob([resp.data], { type: "image/webp" }));
    const ref = this._getCanvas();
    ref.context.drawImage(bitmap, 0, 0, this.tileSize, this.tileSize);
    const pixels = ref.context.getImageData(0, 0, this.tileSize, this.tileSize);
    ref.context.clearRect(0, 0, this.tileSize, this.tileSize);
    this._canvasQueue.push(ref);
    bitmap.close();
    return pixels;
  }

  getTileDataAvailable({ z }) {
    return z <= this.maxZoom;
  }
}

function terrariumDecode(r, g, b, _a) {
  return (r * 256 + g + b / 256) - 32768;
}

const martiniCache = {};

class TerrariumTerrainDecoder {
  constructor() {
    this.inProgress = 0;
    this.maxRequests = 6;
  }

  requestTileGeometry(coords, processFunction) {
    if (this.inProgress > this.maxRequests) return undefined;
    this.inProgress += 1;
    return processFunction(coords).finally(() => { this.inProgress -= 1; });
  }

  decodeTerrain(params) {
    const { imageData, tileSize = 256, errorLevel, maxVertexDistance } = params;
    const arr = new Uint8Array(imageData);
    const pixels = {
      shape: [tileSize, tileSize, 4],
      get(x, y, c) { return arr[(y * tileSize + x) * 4 + c]; },
    };
    const terrain = rgbTerrainToGrid(pixels, terrariumDecode);
    martiniCache[tileSize] = martiniCache[tileSize] || new Martini(tileSize + 1);
    const tile = martiniCache[tileSize].createTile(terrain);
    const mesh = tile.getMesh(errorLevel, Math.min(maxVertexDistance, tileSize));
    return Promise.resolve(createQuantizedMeshData(tile, mesh, tileSize, terrain));
  }
}

async function setupMartiniTerrain() {
  if (martiniProvider) return martiniProvider;
  const resource = new PMTilesHeightmapResource({
    url: MAPTERHORN_PMTILES_URL,
    tileSize: 512,
    maxZoom: 12,
  });
  const decoder = new TerrariumTerrainDecoder();
  martiniProvider = new MartiniTerrainProvider({ resource, decoder });
  return martiniProvider;
}

// Kartengrundlagen; Satellit ist in 3D der Standard, weil das stilisierte
// OSM-Raster über steilem, überhöhtem Gelände stark verzerrt.
function imageryLayers(kind) {
  if (kind === "osm") {
    return [new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })];
  }
  if (kind === "versatiles") {
    return [
      new Cesium.UrlTemplateImageryProvider({
        url: VERSATILES_SAT_URL,
        maximumLevel: 12,
        credit: new Cesium.Credit("Copernicus Sentinel-2 via VersaTiles", true),
      }),
    ];
  }
  return [
    new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19,
      credit: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community",
    }),
    new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19,
    }),
  ];
}

function setImagery(kind) {
  viewer.imageryLayers.removeAll();
  for (const p of imageryLayers(kind)) viewer.imageryLayers.addImageryProvider(p);
  viewer.scene.requestRender();
}

function initViewer() {
  viewer = new Cesium.Viewer(el("v3d-globe"), {
    // Eigene Grundkarte statt der Ion-Standardkarte, damit ohne Token keine
    // Ion-Zugriffe anfallen.
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    infoBox: true,
    selectionIndicator: true,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });
  viewer.scene.globe.depthTestAgainstTerrain = true;
  // Prefer markers over walls/polylines (Entity has no allowPicking).
  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const hits = viewer.scene.drillPick(click.position, 12);
    let marker = null;
    for (const h of hits) {
      const e = h.id;
      if (e && e.description) {
        marker = e;
        break;
      }
    }
    viewer.selectedEntity = marker;
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  const img = ["esri", "osm", "versatiles"].includes(prefs.imagery) ? prefs.imagery : "esri";
  setImagery(img);
}

// --- Kamera-Knöpfe: Orbit um den Geländepunkt in der Bildmitte --------------
// Trackpad-/Touch-Bedienung ohne Maustasten; Drehen/Kippen/Zoomen kreisen um
// den Punkt, den man gerade ansieht, nicht um die Kamera selbst.
function orbit(dHeading, dPitch, rangeFactor = 1) {
  const scene = viewer.scene;
  const cam = viewer.camera;
  const ray = cam.getPickRay(new Cesium.Cartesian2(
    scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2));
  const center = ray && scene.globe.pick(ray, scene);
  if (!center) return;
  const range = Cesium.Cartesian3.distance(cam.position, center) * rangeFactor;
  const pitch = Math.min(-0.05, Math.max(-Math.PI / 2 + 0.01, cam.pitch + dPitch));
  cam.lookAt(center, new Cesium.HeadingPitchRange(cam.heading + dHeading, pitch, range));
  cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
  scene.requestRender();
}

/** Öffnet die Ansicht und zeichnet die Läufe (Modul wird lazy geladen). */
export async function show(data) {
  if (!viewer) {
    initViewer();
    wireControls();
    await setTerrain(prefs.terrain || "reearth");
  }
  await update(data);
  flyToAll();
}

/** Zeichnet neue Läufe nach (Live-Modus, Neuberechnung bei offener Ansicht). */
export async function update(data) {
  lastData = data;
  const key = `${data.start?.lat},${data.start?.lon}|${terrainKind}`;
  if (key !== calKey) {
    calKey = key;
    await recalibrate();
  }
  redraw();
}

async function setTerrain(kind) {
  let provider = new Cesium.EllipsoidTerrainProvider();
  terrainKind = "flat";
  setNote("");
  try {
    if (kind === "reearth") {
      provider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
      terrainKind = "reearth";
    } else if (kind === "mapterhorn") {
      provider = await setupMartiniTerrain();
      terrainKind = "mapterhorn";
    } else if (kind === "ion") {
      const token = (prefs.ionToken || "").trim();
      if (!token) throw new Error("Ion-Token fehlt");
      Cesium.Ion.defaultAccessToken = token;
      provider = await Cesium.createWorldTerrainAsync();
      terrainKind = "ion";
    }
  } catch (err) {
    setNote(`Gelände nicht verfügbar (${err.message}) — Darstellung flach.`, true);
  }
  viewer.terrainProvider = provider;
  calKey = null; // Abgleich gilt je Geländequelle
  viewer.scene.requestRender();
}

/** Versatz Modellhöhe(NN) -> Cesium-Ellipsoidhöhe, am Startpunkt bestimmt. */
async function recalibrate() {
  zOffset = 0;
  if (!lastData || terrainKind === "flat") return;
  const { start, modelElev } = lastData;
  if (!start || !Number.isFinite(modelElev)) return;
  try {
    const pos = [Cesium.Cartographic.fromDegrees(start.lon, start.lat)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pos);
    if (Number.isFinite(pos[0].height)) {
      zOffset = pos[0].height - modelElev;
      setNote(`Höhenabgleich ${zOffset >= 0 ? "+" : ""}${Math.round(zOffset)} m (Geoid/Modellorographie)`);
    }
  } catch {
    /* Abgleich ist Komfort; ohne ihn stimmt die Szene bis auf die Geoid-Undulation */
  }
}

function exaggeration() {
  return Math.max(1, +el("v3d-exagg").value || 1);
}

function redraw() {
  if (!viewer || !lastData) return;
  const f = exaggeration();
  viewer.scene.verticalExaggeration = f;
  viewer.entities.removeAll();
  const H = (z) => (z + zOffset) * f;

  for (const run of lastData.runs) {
    const pts = run.r.points.filter((p) => Number.isFinite(p.z));
    if (pts.length < 2) continue;
    const positions = pts.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, H(p.z)));
    const color = Cesium.Color.fromCssColorString(run.color);
    // Strichlierung wie in 2D als Zweitkodierung der Methode; durchgezogene
    // Linien bekommen die weiße Kontrastkante (Pendant zur 2D-Unterlage).
    const material = run.dash
      ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 16 })
      : new Cesium.PolylineOutlineMaterialProperty({
          color, outlineColor: Cesium.Color.WHITE.withAlpha(0.85), outlineWidth: 1.5,
        });
    // Polyline/wall ignored by LEFT_CLICK drillPick (Entity has no
    // allowPicking); only markers carry description → infoBox.
    viewer.entities.add({
      name: run.label,
      polyline: { positions, width: 5, material },
    });
    viewer.entities.add({
      wall: {
        positions,
        minimumHeights: pts.map(() => 0),
        material: color.withAlpha(0.12),
      },
    });
    for (const m of run.r.markers) {
      if (!Number.isFinite(m.z)) continue;
      viewer.entities.add({
        name: `${fmtTime(m.tMs)} — ${run.label}`,
        position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, H(m.z)),
        point: {
          pixelSize: 10,
          color: Cesium.Color.WHITE,
          outlineColor: color,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: markerHtml(m, run.label),
      });
    }
  }
  viewer.scene.requestRender();
}

function markerHtml(m, label) {
  const dir = (Math.atan2(-m.u, -m.v) * 180 / Math.PI + 360) % 360;
  const rows = [
    `<strong>${fmtTime(m.tMs)}</strong>`,
    label,
    `Höhe: ${fmtHeight(m.z)} NN`,
    `Wind: ${fmtWind(Math.hypot(m.u, m.v))} aus ${Math.round(dir)}°`,
    m.met && Number.isFinite(m.met.t) ? `T: ${m.met.t.toFixed(1)} °C` : null,
    m.met && Number.isFinite(m.met.td) ? `Td: ${m.met.td.toFixed(1)} °C` : null,
    m.met && Number.isFinite(m.met.rh) ? `RH: ${Math.round(m.met.rh)} %` : null,
    m.met && Number.isFinite(m.met.p) ? `p: ${m.met.p.toFixed(0)} hPa` : null,
    `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E`,
  ];
  return `<div style="font-variant-numeric:tabular-nums">${rows.filter(Boolean).join("<br>")}</div>`;
}

function flyToAll() {
  if (viewer && viewer.entities.values.length) viewer.flyTo(viewer.entities);
}

function setNote(msg, isError = false) {
  const note = el("v3d-note");
  note.textContent = msg;
  note.classList.toggle("error", isError);
}

function wireControls() {
  if (wired) return;
  wired = true;

  const ex = el("v3d-exagg");
  const exLabel = el("v3d-exagg-label");
  if (Number.isFinite(prefs.exaggeration)) ex.value = prefs.exaggeration;
  exLabel.textContent = `×${ex.value}`;
  ex.addEventListener("input", () => {
    exLabel.textContent = `×${ex.value}`;
    redraw();
  });
  ex.addEventListener("change", () => savePrefs({ exaggeration: +ex.value }));

  const sel = el("v3d-terrain");
  const token = el("v3d-token");
  if (["reearth", "mapterhorn", "ion", "flat"].includes(prefs.terrain)) sel.value = prefs.terrain;
  token.value = prefs.ionToken || "";
  token.hidden = sel.value !== "ion";
  const applyTerrain = async () => {
    await setTerrain(sel.value);
    if (lastData) await update(lastData);
  };
  sel.addEventListener("change", () => {
    token.hidden = sel.value !== "ion";
    savePrefs({ terrain: sel.value });
    applyTerrain();
  });
  token.addEventListener("change", () => {
    savePrefs({ ionToken: token.value.trim() });
    if (sel.value === "ion") applyTerrain();
  });

  const imagery = el("v3d-imagery");
  if (["esri", "osm", "versatiles"].includes(prefs.imagery)) imagery.value = prefs.imagery;
  imagery.addEventListener("change", () => {
    savePrefs({ imagery: imagery.value });
    setImagery(imagery.value);
  });

  el("v3d-center").addEventListener("click", flyToAll);
  const deg = Math.PI / 180;
  const cam = {
    "v3d-cam-in": () => orbit(0, 0, 0.7),
    "v3d-cam-out": () => orbit(0, 0, 1 / 0.7),
    "v3d-cam-tiltdown": () => orbit(0, 12 * deg),
    "v3d-cam-tiltup": () => orbit(0, -12 * deg),
    "v3d-cam-left": () => orbit(-20 * deg, 0),
    "v3d-cam-right": () => orbit(20 * deg, 0),
  };
  for (const [id, fn] of Object.entries(cam)) el(id).addEventListener("click", fn);
}

function fmtTime(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}
