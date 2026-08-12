/**
 * Einstieg des exportierten HTML-Viewers (IIFE): 2D Leaflet + lazy 3D Cesium.
 */

import { initViewer } from "./htmlViewer";
import { initGlobe, resizeGlobe } from "./htmlGlobe";
import { CESIUM_CDN_BASE, type Payload } from "./htmlPayload";

declare const L: any;

let mapApi: { invalidateSize: () => void } | null = null;
let globeReady = false;
let globeLoading: Promise<void> | null = null;
let payload: Payload | null = null;

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

async function showView(view: "2d" | "3d") {
  const pane2d = document.getElementById("view-2d");
  const pane3d = document.getElementById("view-3d");
  if (!pane2d || !pane3d || !payload) return;
  setToggleActive(view);
  if (view === "2d") {
    pane2d.hidden = false;
    pane3d.hidden = true;
    if (!mapApi) mapApi = initViewer(payload);
    // Nach Show/Init: Layout (Flex) neu messen — sonst Tiles ohne Pfade
    // bzw. Pfade mit veralteter Viewport-Größe.
    requestAnimationFrame(() => {
      mapApi?.invalidateSize();
      requestAnimationFrame(() => mapApi?.invalidateSize());
    });
    return;
  }
  pane2d.hidden = true;
  pane3d.hidden = false;
  const note = document.getElementById("ex-globe-note");
  try {
    if (!globeReady) {
      if (!globeLoading) {
        if (note) {
          note.textContent = "Lade Cesium …";
          note.classList.remove("error");
        }
        globeLoading = loadCesium().then(async () => {
          await initGlobe(payload!);
          globeReady = true;
        });
      }
      await globeLoading;
    } else {
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
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".gv-view-btn")) {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view === "3d" ? "3d" : "2d";
      void showView(v);
    });
  }
  const start = data.opts.defaultView === "3d" ? "3d" : "2d";
  void showView(start);
}

(window as any).initExport = initExport;
// Rückwärtskompatibel, falls jemand nur die 2D-API erwartet.
(window as any).initViewer = (data: Payload) => {
  payload = data;
  mapApi = initViewer(data);
};
