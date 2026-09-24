/**
 * Side-by-side globe for track-import. One polyline per track.
 * Click picks the nearest vertex in screen pixels and pins the 2D HUD.
 */

import { cardinalFromDeg, metricsAt } from "../src/overlays/sample.js";
import { INSPECT_MAX_PX } from "../src/overlays/inspectControl.js";

const COLORS = ["#c45c26", "#2a6fdb", "#1f8a4c", "#8a3ffc", "#b45309", "#0f766e"];
/** Same quantized-mesh DEM as the trajectories 3D view (ellipsoid heights). */
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

/**
 * @param {HTMLElement} container
 * @param {{ onPin?: (trackId: string|null, index: number|null) => void }} [opts]
 */
export async function mountTrackGlobe(container, opts = {}) {
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
  viewer.scene.globe.depthTestAgainstTerrain = true;
  let terrainKind = "flat";
  /** GPS height is above the geoid; the mesh is ellipsoid height. */
  let zOffset = 0;
  let calKey = "";
  try {
    viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL);
    terrainKind = "reearth";
  } catch (err) {
    console.warn("Gelände nicht verfügbar — Darstellung flach.", err);
  }
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
    const hasZ = c.z != null && Number.isFinite(c.z);
    const z = hasZ ? c.z + zOffset : 0;
    return Cesium.Cartesian3.fromDegrees(c.lon, c.lat, z);
  }

  function firstHeight(list) {
    for (const track of list) {
      if (track.visible === false) continue;
      for (const c of track.coords || []) {
        if (c.z != null && Number.isFinite(c.z)) return c;
      }
    }
    return null;
  }

  async function calibrate(list) {
    const c = firstHeight(list);
    const key = c ? `${c.lat},${c.lon},${c.z}` : "";
    if (key === calKey) return;
    calKey = key;
    zOffset = 0;
    if (!c || terrainKind !== "reearth") return;
    try {
      const pos = [Cesium.Cartographic.fromDegrees(c.lon, c.lat)];
      await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pos);
      if (Number.isFinite(pos[0].height)) zOffset = pos[0].height - c.z;
    } catch {
      /* Track stays at the GPS height if the mesh sample fails. */
    }
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

  function showAt(trackId, index) {
    pin = trackId == null || index == null ? null : { trackId, index };
    placePin();
    viewer.scene.requestRender();
  }

  viewer.screenSpaceEventHandler.setInputAction((click) => {
    const hit = nearest(click.position);
    pin = hit ? { trackId: hit.track.id, index: hit.index } : null;
    placePin();
    viewer.scene.requestRender();
    opts.onPin?.(pin ? pin.trackId : null, pin ? pin.index : null);
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
    const lon = (west + east) / 2;
    const lat = (south + north) / 2;
    const span = Math.max(east - west, north - south, 0.02);
    const range = Math.max(8000, span * 111000 * 1.6);
    const center = Cesium.Cartesian3.fromDegrees(lon, lat, 1200);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, range * 0.25), {
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), range),
    });
  }

  return {
    /**
     * @param {object[]} next
     * @param {{ fly?: boolean }} [opts]
     */
    async setTracks(next, trackOpts = {}) {
      tracks = next || [];
      if (pin && !trackById(pin.trackId)) pin = null;
      await calibrate(tracks);
      draw(tracks);
      placePin();
      if (trackOpts.fly) flyTo(tracks);
    },
    showAt,
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
