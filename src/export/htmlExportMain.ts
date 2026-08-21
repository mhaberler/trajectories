/**
 * Einstieg des exportierten HTML-Viewers (IIFE): 2D Leaflet + lazy 3D Cesium.
 */

import { initViewer, type ViewerApi } from "./htmlViewer";
import { initGlobe, morphRuns as globeMorphRuns, resizeGlobe, syncGlobe, flyToTracks } from "./htmlGlobe";
import { CESIUM_CDN_BASE, type Payload, type PayloadRun } from "./htmlPayload";
import { hasCamera, readViewState, writeViewState } from "./htmlUrl";
import {
  computeMorphPayloadRuns,
  nearestSampleIndex,
} from "../launchMorph.js";

let mapApi: ViewerApi | null = null;
let globeReady = false;
let globeLoading: Promise<void> | null = null;
let payload: Payload | null = null;
let playMs = 0;
let lastMorphRuns: PayloadRun[] | null = null;

function runKey(run: PayloadRun) {
  return `${run.heightM}|${run.method}`;
}

function filterRunsByMap(runs: PayloadRun[]): PayloadRun[] {
  const vis = mapApi?.getVisibility();
  if (!vis) return runs;
  const runSet = new Set(vis.runKeys);
  return runs.filter((r) => runSet.has(runKey(r)));
}

/** Payload for Cesium: current morph pose + only tracks/overlays visible in 2D. */
function payloadForGlobe(): Payload {
  if (!payload) throw new Error("no payload");
  const runs = lastMorphRuns ?? payload.runs;
  const vis = mapApi?.getVisibility();
  if (!vis) return { ...payload, runs };
  const overlaySet = new Set(vis.overlayNames);
  return {
    ...payload,
    runs: filterRunsByMap(runs),
    overlays: (payload.overlays || []).filter((o) => overlaySet.has(o.name)),
  };
}

function pushGlobeFromMap() {
  if (!globeReady) return;
  syncGlobe(payloadForGlobe());
}

function loadCesium(): Promise<void> {
  if ((window as any).Cesium) return Promise.resolve();
  return new Promise((resolve, reject) => {
    (window as any).CESIUM_BASE_URL = CESIUM_CDN_BASE;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${CESIUM_CDN_BASE}Widgets/widgets.css`;
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = `${CESIUM_CDN_BASE}Cesium.js`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Cesium-CDN nicht erreichbar"));
    document.head.appendChild(s);
  });
}

function setToggleActive(view: "2d" | "3d") {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".gv-view-btn")) {
    btn.classList.toggle("active", btn.dataset.view === view);
  }
}

function fmtScrubTime(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function applyMorphAt(tMs: number) {
  const lw = payload?.launchWindow;
  if (!lw?.samples?.length) return;
  playMs = Math.min(lw.tEndMs, Math.max(lw.tStartMs, tMs));
  const runs = computeMorphPayloadRuns(lw.samples, playMs);
  if (!runs) return;
  lastMorphRuns = runs;
  mapApi?.morphRuns(runs);
  // Position-only morph while 3D is open — full syncGlobe would cancel the camera.
  if (globeReady) globeMorphRuns(filterRunsByMap(runs));

  const ni = nearestSampleIndex(lw.samples, playMs);
  if (ni >= 0) mapApi?.setProfileXsec(lw.samples[ni].xsec);

  const timeEl = document.getElementById("scrub-time");
  if (timeEl) timeEl.textContent = fmtScrubTime(playMs);
  const play = document.getElementById("scrub-play");
  const track = document.getElementById("scrub-track");
  if (play && track && lw.tEndMs > lw.tStartMs) {
    const frac = (playMs - lw.tStartMs) / (lw.tEndMs - lw.tStartMs);
    play.style.left = `${Math.min(1, Math.max(0, frac)) * 100}%`;
  }
}

function wireScrub() {
  const lw = payload?.launchWindow;
  const box = document.getElementById("launch-scrub");
  const track = document.getElementById("scrub-track");
  if (!lw || !box || !track || lw.samples.length < 2) return;
  box.hidden = false;
  playMs = lw.playMs0 ?? lw.tStartMs;
  const band = document.getElementById("scrub-band");
  if (band) {
    band.style.left = "0";
    band.style.right = "0";
  }

  const msFromClientX = (clientX: number) => {
    const r = track.getBoundingClientRect();
    const frac = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return lw.tStartMs + Math.min(1, Math.max(0, frac)) * (lw.tEndMs - lw.tStartMs);
  };

  const onPtr = (e: PointerEvent) => {
    applyMorphAt(msFromClientX(e.clientX));
  };
  track.addEventListener("pointerdown", (e) => {
    track.setPointerCapture(e.pointerId);
    onPtr(e);
  });
  track.addEventListener("pointermove", (e) => {
    if (!track.hasPointerCapture(e.pointerId)) return;
    onPtr(e);
  });

  applyMorphAt(playMs);
}

async function showView(view: "2d" | "3d") {
  const pane2d = document.getElementById("view-2d");
  const pane3d = document.getElementById("view-3d");
  if (!pane2d || !pane3d || !payload) return;
  setToggleActive(view);
  if (view === "2d") {
    pane2d.hidden = false;
    pane3d.hidden = true;
    if (!mapApi) mapApi = initViewer(payload);
    if (lastMorphRuns) mapApi.morphRuns(lastMorphRuns);
    writeViewState({ view: "2d", camera: null });
    requestAnimationFrame(() => {
      mapApi?.invalidateSize();
      requestAnimationFrame(() => mapApi?.invalidateSize());
    });
    return;
  }
  pane2d.hidden = true;
  pane3d.hidden = false;
  writeViewState({ view: "3d" });
  const note = document.getElementById("ex-globe-note");
  try {
    if (!globeReady) {
      if (!globeLoading) {
        if (note) {
          note.textContent = "Lade Cesium …";
          note.classList.remove("error");
        }
        globeLoading = loadCesium().then(async () => {
          await initGlobe(payloadForGlobe());
          globeReady = true;
        });
      }
      await globeLoading;
      // Do not syncGlobe here: initGlobe already used payloadForGlobe and started
      // flyTo — a redraw would cancel the camera at globe scale.
    } else {
      pushGlobeFromMap();
      flyToTracks();
      resizeGlobe();
    }
  } catch (err: any) {
    if (note) {
      note.textContent = `3D nicht verfügbar: ${err?.message || err}`;
      note.classList.add("error");
    }
  }
}

/**
 * Startet die exportierte Seite: Toggle verdrahten, Startansicht öffnen.
 */
export function initExport(data: Payload) {
  payload = data;
  lastMorphRuns = null;
  playMs = data.launchWindow?.playMs0 ?? data.meta.t0Ms;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".gv-view-btn")) {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view === "3d" ? "3d" : "2d";
      void showView(v);
    });
  }
  const url = readViewState();
  const profile = url.profile !== undefined ? url.profile : !!data.opts.profile;
  writeViewState({ profile });
  let start: "2d" | "3d" = data.opts.defaultView === "3d" ? "3d" : "2d";
  if (url.view === "2d" || url.view === "3d") start = url.view;
  else if (hasCamera(url)) start = "3d";

  // 2D zuerst, damit Scrub/Morph eine Viewer-API haben; bei 3D-Start danach umschalten.
  void (async () => {
    await showView("2d");
    wireScrub();
    if (start === "3d") await showView("3d");
  })();
}

(window as any).initExport = initExport;
// Rückwärtskompatibel, falls jemand nur die 2D-API erwartet.
(window as any).initViewer = (data: Payload) => {
  payload = data;
  mapApi = initViewer(data);
};
