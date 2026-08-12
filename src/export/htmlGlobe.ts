/**
 * 3D-Pane der exportierten HTML-Karte (Cesium von CDN als globales `Cesium`).
 * Bewusst ohne npm-Import von `cesium`, damit das IIFE-Bündel schlank bleibt.
 */

import type { Payload, PopupRow } from "./htmlPayload";
import {
  hasCamera,
  isImageryKind,
  readViewState,
  writeViewState,
  throttle,
  type CameraState,
  type ImageryKind,
} from "./htmlUrl";

declare const Cesium: any;

const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

let viewer: any = null;
let zOffset = 0;
let terrainKind = "flat";
let lastData: Payload | null = null;
let flew = false;
let currentImagery: ImageryKind = "esri";

function esc(s: string) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function setNote(msg: string, isError = false) {
  const note = document.getElementById("ex-globe-note");
  if (!note) return;
  note.textContent = msg;
  note.classList.toggle("error", isError);
}

function exaggeration() {
  const inp = document.getElementById("ex-globe-exagg") as HTMLInputElement | null;
  return Math.max(1, +(inp?.value || 1));
}

function imageryLayers(kind: ImageryKind) {
  if (kind === "osm") {
    return [new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })];
  }
  if (kind === "opentopo") {
    return [
      new Cesium.UrlTemplateImageryProvider({
        url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        subdomains: ["a", "b", "c"],
        maximumLevel: 17,
        credit: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)",
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

function setImagery(kind: ImageryKind) {
  if (!viewer) return;
  currentImagery = kind;
  viewer.imageryLayers.removeAll();
  for (const p of imageryLayers(kind)) viewer.imageryLayers.addImageryProvider(p);
  viewer.scene.requestRender();
}

function resolveImagery(urlImagery: ImageryKind | undefined, fallback: string | undefined): ImageryKind {
  if (isImageryKind(urlImagery)) return urlImagery;
  if (isImageryKind(fallback)) return fallback;
  return "esri";
}

function markerDescription(name: string, rows: PopupRow[]) {
  const body = rows
    .map((r) => `<tr><td style="padding-right:6px;color:#52514e">${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
    .join("");
  return `<div style="font-variant-numeric:tabular-nums"><strong>${esc(name)}</strong>` +
    `<table style="border-collapse:collapse;margin-top:3px">${body}</table></div>`;
}

function createViewer() {
  viewer = new Cesium.Viewer("globe", {
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
  viewer.screenSpaceEventHandler.setInputAction((click: { position: unknown }) => {
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

  for (const p of imageryLayers(currentImagery)) viewer.imageryLayers.addImageryProvider(p);

  const pushCamera = () => {
    const cam = readCamera();
    if (cam) {
      writeViewState({
        view: "3d",
        camera: cam,
        exagg: exaggeration(),
        imagery: currentImagery,
      });
    }
  };
  // Live in der Adresszeile während Drehen/Zoomen; moveEnd schreibt den Endstand.
  viewer.camera.changed.addEventListener(throttle(pushCamera, 200));
  viewer.camera.moveEnd.addEventListener(pushCamera);
}

function readCamera(): CameraState | null {
  if (!viewer) return null;
  const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  if (!carto || !Number.isFinite(carto.longitude) || !Number.isFinite(carto.height)) return null;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    h: carto.height,
    heading: Cesium.Math.toDegrees(viewer.camera.heading),
    pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    roll: Cesium.Math.toDegrees(viewer.camera.roll),
  };
}

function applyCamera(cam: CameraState) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.h),
    orientation: {
      heading: Cesium.Math.toRadians(cam.heading),
      pitch: Cesium.Math.toRadians(cam.pitch),
      roll: Cesium.Math.toRadians(cam.roll),
    },
  });
  viewer.scene.requestRender();
}

async function setTerrainReearth() {
  let provider = new Cesium.EllipsoidTerrainProvider();
  terrainKind = "flat";
  setNote("");
  try {
    provider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    terrainKind = "reearth";
  } catch (err: any) {
    setNote(`Gelände nicht verfügbar (${err?.message || err}) — Darstellung flach.`, true);
  }
  viewer.terrainProvider = provider;
  viewer.scene.requestRender();
}

async function recalibrate() {
  zOffset = 0;
  if (!lastData || terrainKind === "flat") return;
  const { start, modelElev } = lastData;
  if (!start || !Number.isFinite(modelElev as number)) return;
  try {
    const pos = [Cesium.Cartographic.fromDegrees(start.lon, start.lat)];
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pos);
    if (Number.isFinite(pos[0].height)) {
      zOffset = pos[0].height - (modelElev as number);
      setNote(`Höhenabgleich ${zOffset >= 0 ? "+" : ""}${Math.round(zOffset)} m (Geoid/Modellorographie)`);
    }
  } catch {
    /* Abgleich ist Komfort */
  }
}

function redraw() {
  if (!viewer || !lastData) return;
  const f = exaggeration();
  viewer.scene.verticalExaggeration = f;
  viewer.entities.removeAll();
  const H = (z: number) => (z + zOffset) * f;

  for (const run of lastData.runs) {
    const pts = run.pts.filter((p) => Number.isFinite(p[2] as number));
    if (pts.length < 2) continue;
    const positions = pts.map((p) =>
      Cesium.Cartesian3.fromDegrees(p[1], p[0], H(p[2] as number)));
    const color = Cesium.Color.fromCssColorString(run.color);
    const material = run.dash
      ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 16 })
      : new Cesium.PolylineOutlineMaterialProperty({
          color, outlineColor: Cesium.Color.WHITE.withAlpha(0.85), outlineWidth: 1.5,
        });
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
    for (const m of run.markers) {
      if (!Number.isFinite(m.z as number)) continue;
      viewer.entities.add({
        name: run.label,
        position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, H(m.z as number)),
        point: {
          pixelSize: 10,
          color: Cesium.Color.WHITE,
          outlineColor: color,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: markerDescription(run.name, m.rows),
      });
    }
  }

  for (const o of lastData.overlays || []) {
    if (o.visible === false || !o.coords?.length || o.coords.length < 2) continue;
    const hasZ = o.coords.some((c) => Number.isFinite(c[2] as number));
    const color = Cesium.Color.fromCssColorString(o.color || "#c45c26");
    const material = new Cesium.PolylineOutlineMaterialProperty({
      color,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
      outlineWidth: 1,
    });
    if (hasZ) {
      const pts = o.coords.filter((c) => Number.isFinite(c[2] as number));
      if (pts.length < 2) continue;
      const positions = pts.map((c) =>
        Cesium.Cartesian3.fromDegrees(c[1], c[0], H(c[2] as number)));
      viewer.entities.add({
        name: o.name,
        description: o.note
          ? `<div><strong>${esc(o.name)}</strong><br>${esc(o.note)}</div>`
          : undefined,
        polyline: { positions, width: 4, material, clampToGround: false },
      });
    } else {
      const positions = o.coords.map((c) =>
        Cesium.Cartesian3.fromDegrees(c[1], c[0], 0));
      viewer.entities.add({
        name: o.name,
        description: o.note
          ? `<div><strong>${esc(o.name)}</strong><br>${esc(o.note)}</div>`
          : undefined,
        polyline: { positions, width: 4, material, clampToGround: true },
      });
    }
  }
  viewer.scene.requestRender();
}

function flyToAll() {
  if (viewer && viewer.entities.values.length) {
    void viewer.flyTo(viewer.entities).then(() => {
      const cam = readCamera();
      if (cam) {
        writeViewState({
          view: "3d",
          camera: cam,
          exagg: exaggeration(),
          imagery: currentImagery,
        });
      }
    });
  }
}

function wireExagg() {
  const inp = document.getElementById("ex-globe-exagg") as HTMLInputElement | null;
  const label = document.getElementById("ex-globe-exagg-label");
  if (!inp || !label) return;
  const sync = () => {
    label.textContent = `×${inp.value}`;
    writeViewState({ view: "3d", exagg: +inp.value, imagery: currentImagery });
    redraw();
  };
  inp.addEventListener("input", sync);
}

function wireImagery() {
  const sel = document.getElementById("ex-globe-imagery") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = currentImagery;
  sel.addEventListener("change", () => {
    const kind = isImageryKind(sel.value) ? sel.value : "esri";
    setImagery(kind);
    writeViewState({ view: "3d", imagery: kind });
  });
}

/**
 * Erzeugt bzw. aktualisiert die Cesium-Ansicht. Cesium muss bereits geladen sein.
 */
export async function initGlobe(data: Payload): Promise<void> {
  lastData = data;
  const url = readViewState();
  currentImagery = resolveImagery(url.imagery, data.opts.defaultImagery);
  const inp = document.getElementById("ex-globe-exagg") as HTMLInputElement | null;
  if (inp && !viewer) {
    const ex = url.exagg ?? data.opts.exaggeration ?? 3;
    inp.value = String(ex);
    const label = document.getElementById("ex-globe-exagg-label");
    if (label) label.textContent = `×${inp.value}`;
  }
  if (!viewer) {
    createViewer();
    wireExagg();
    wireImagery();
    await setTerrainReearth();
  } else {
    setImagery(currentImagery);
    const sel = document.getElementById("ex-globe-imagery") as HTMLSelectElement | null;
    if (sel) sel.value = currentImagery;
  }
  await recalibrate();
  redraw();
  if (!flew) {
    flew = true;
    if (hasCamera(url)) applyCamera(url.camera);
    else flyToAll();
  }
  writeViewState({
    view: "3d",
    exagg: exaggeration(),
    imagery: currentImagery,
    ...(hasCamera(url) ? { camera: url.camera } : {}),
  });
  // Pane war ggf. hidden beim ersten Paint — Größe nachziehen.
  try {
    viewer.resize();
    viewer.scene.requestRender();
  } catch {
    /* ignore */
  }
}

export function resizeGlobe() {
  if (!viewer) return;
  try {
    viewer.resize();
    viewer.scene.requestRender();
  } catch {
    /* ignore */
  }
}
