/**
 * Side-by-side globe for track-import. One polyline per track.
 * Click picks the nearest vertex in screen pixels and pins the 2D HUD.
 */

import { cardinalFromDeg, metricsAt } from "../src/overlays/sample.js";
import { INSPECT_MAX_PX } from "../src/overlays/inspectControl.js";

const COLORS = ["#c45c26", "#2a6fdb", "#1f8a4c", "#8a3ffc", "#b45309", "#0f766e"];

/**
 * @param {HTMLElement} container
 */
export async function mountTrackGlobe(container) {
  const Cesium = await import("cesium");
  import("cesium/Build/Cesium/Widgets/widgets.css").catch(() => {});

  const viewer = new Cesium.Viewer(container, {
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
    infoBox: false,
    selectionIndicator: false,
  });
  viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({
    url: "https://tile.openstreetmap.org/",
  }));
  const fit = () => {
    viewer.resize();
    viewer.scene.requestRender();
  };
  requestAnimationFrame(fit);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(container);

  const pinEl = document.createElement("div");
  pinEl.id = "globe-pin";
  pinEl.hidden = true;
  const hudEl = document.createElement("div");
  hudEl.id = "globe-hud";
  hudEl.className = "inspect-hud";
  hudEl.hidden = true;
  container.append(pinEl, hudEl);

  /** @type {{ trackId: string, index: number }|null} */
  let pin = null;
  /** @type {object[]} */
  let tracks = [];

  function cartesian(c) {
    const z = c.z != null && Number.isFinite(c.z) ? c.z : 0;
    return Cesium.Cartesian3.fromDegrees(c.lon, c.lat, z);
  }

  function trackById(id) {
    return tracks.find((t) => t.id === id && t.visible !== false);
  }

  function placePin() {
    if (!pin) {
      pinEl.hidden = true;
      hudEl.hidden = true;
      return;
    }
    const track = trackById(pin.trackId);
    const m = track && metricsAt(track.coords, pin.index);
    if (!m) {
      pin = null;
      pinEl.hidden = true;
      hudEl.hidden = true;
      return;
    }
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, cartesian(m));
    if (!win) {
      pinEl.hidden = true;
      hudEl.hidden = true;
      return;
    }
    const camDeg = Cesium.Math.toDegrees(viewer.camera.heading);
    const chevron = m.headingDeg != null && Number.isFinite(m.headingDeg)
      ? `<div class="inspect-chevron" style="transform:rotate(${m.headingDeg - camDeg}deg)"></div>`
      : "";
    pinEl.innerHTML = `<div class="inspect-pin">${chevron}</div>`;
    pinEl.hidden = false;
    pinEl.style.left = `${win.x}px`;
    pinEl.style.top = `${win.y}px`;
    hudEl.innerHTML = formatHud(track.name, m);
    hudEl.hidden = false;
    hudEl.style.left = `${win.x}px`;
    hudEl.style.top = `${win.y}px`;
  }

  function nearest(windowPos) {
    let best = null;
    for (const track of tracks) {
      if (track.visible === false) continue;
      const coords = track.coords || [];
      for (let i = 0; i < coords.length; i++) {
        const win = Cesium.SceneTransforms.worldToWindowCoordinates(
          viewer.scene,
          cartesian(coords[i]),
        );
        if (!win) continue;
        const dist = Math.hypot(win.x - windowPos.x, win.y - windowPos.y);
        if (dist > INSPECT_MAX_PX) continue;
        if (!best || dist < best.dist) best = { track, index: i, dist };
      }
    }
    return best;
  }

  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const hit = nearest(click.position);
    pin = hit ? { trackId: hit.track.id, index: hit.index } : null;
    placePin();
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  viewer.scene.preRender.addEventListener(placePin);

  function draw(list) {
    viewer.entities.removeAll();
    list.forEach((track, i) => {
      if (track.visible === false) return;
      const coords = track.coords || [];
      if (coords.length < 2) return;
      viewer.entities.add({
        polyline: {
          positions: coords.map(cartesian),
          width: 4,
          material: Cesium.Color.fromCssColorString(COLORS[i % COLORS.length]),
          clampToGround: false,
        },
      });
    });
    viewer.scene.requestRender();
  }

  function flyTo(list) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const track of list) {
      if (track.visible === false) continue;
      for (const c of track.coords || []) {
        west = Math.min(west, c.lon);
        east = Math.max(east, c.lon);
        south = Math.min(south, c.lat);
        north = Math.max(north, c.lat);
      }
    }
    if (!Number.isFinite(west)) return;
    const pad = Math.max(0.02, (east - west) * 0.15, (north - south) * 0.15);
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west - pad, south - pad, east + pad, north + pad),
    });
  }

  return {
    /**
     * @param {object[]} next
     * @param {{ fly?: boolean }} [opts]
     */
    setTracks(next, opts = {}) {
      tracks = next || [];
      if (pin && !trackById(pin.trackId)) pin = null;
      draw(tracks);
      placePin();
      if (opts.fly) flyTo(tracks);
    },
  };
}

function formatHud(name, m) {
  const rows = [`<div class="inspect-hud-name">${esc(name || "Spur")}</div>`];
  if (m.t != null) rows.push(`<div><span>Zeit</span><b>${esc(fmtTime(m.t))}</b></div>`);
  rows.push(`<div><span>Geschw.</span><b>${fmtSpeed(m.speedKmh)}</b></div>`);
  rows.push(`<div><span>Höhe</span><b>${fmtAlt(m.z)}</b></div>`);
  rows.push(`<div><span>Richtung</span><b>${fmtHeading(m)}</b></div>`);
  return rows.join("");
}

function fmtTime(t) {
  try {
    return new Date(t).toISOString().replace(".000Z", "Z");
  } catch {
    return "—";
  }
}

function fmtSpeed(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} km/h`;
}

function fmtAlt(z) {
  if (z == null || !Number.isFinite(z)) return "—";
  return `${Math.round(z)} m`;
}

function fmtHeading(m) {
  if (m.headingDeg == null || !Number.isFinite(m.headingDeg)) return "—";
  const card = m.cardinal || cardinalFromDeg(m.headingDeg);
  return `${Math.round(m.headingDeg)}°${card ? ` ${card}` : ""}`;
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch]));
}
