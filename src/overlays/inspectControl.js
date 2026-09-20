/**
 * Tap/click pin inspect: nearest overlay vertex + HUD (speed, altitude, heading).
 */

import { cardinalFromDeg, metricsAt, nearestTrackPoint } from "./sample.js";

export const INSPECT_MAX_PX = 32;

/**
 * @param {import("leaflet").Map} map
 * @param {{ getTracks: () => object[], hudHost?: HTMLElement | null, bindClick?: boolean }} opts
 */
export function mountTrackInspect(map, opts) {
  const pinLayer = L.layerGroup().addTo(map);
  let pin = null; // { trackId, index }

  const Hud = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-control inspect-hud");
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      this._el = div;
      div.hidden = true;
      return div;
    },
  });
  const hudCtl = new Hud({ position: "topright" }).addTo(map);
  const hudEl = opts.hudHost || hudCtl._el;

  function clear() {
    pin = null;
    pinLayer.clearLayers();
    if (hudEl) {
      hudEl.hidden = true;
      hudEl.innerHTML = "";
    }
  }

  function renderPin() {
    pinLayer.clearLayers();
    if (!pin || !hudEl) return;
    const tracks = opts.getTracks() || [];
    const track = tracks.find((t) => t.id === pin.trackId);
    if (!track || track.visible === false) {
      clear();
      return;
    }
    const m = metricsAt(track.coords, pin.index);
    if (!m) {
      clear();
      return;
    }
    L.circleMarker([m.lat, m.lon], {
      radius: 7,
      color: "#111",
      weight: 2,
      fillColor: "#fff",
      fillOpacity: 1,
      interactive: false,
      pane: "markerPane",
    }).addTo(pinLayer);
    if (m.headingDeg != null) {
      const icon = L.divIcon({
        className: "inspect-chevron-wrap",
        html: `<div class="inspect-chevron" style="transform:rotate(${m.headingDeg}deg)"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      L.marker([m.lat, m.lon], { icon, interactive: false, keyboard: false }).addTo(pinLayer);
    }
    hudEl.hidden = false;
    hudEl.innerHTML = formatHud(track.name, m);
  }

  /** @returns {boolean} true if a track was pinned */
  function handleClick(e) {
    const hit = nearestTrackPoint(opts.getTracks(), e.latlng, map, INSPECT_MAX_PX);
    if (!hit) {
      clear();
      return false;
    }
    pin = { trackId: hit.track.id, index: hit.index };
    renderPin();
    return true;
  }

  const bound = opts.bindClick !== false;
  if (bound) map.on("click", handleClick);

  return {
    clear,
    refresh: renderPin,
    handleClick,
    destroy() {
      if (bound) map.off("click", handleClick);
      clear();
      map.removeControl(hudCtl);
      map.removeLayer(pinLayer);
    },
  };
}

function formatHud(name, m) {
  const rows = [];
  rows.push(`<div class="inspect-hud-name">${esc(name || "Spur")}</div>`);
  if (m.t != null) {
    rows.push(`<div><span>Zeit</span><b>${esc(fmtTime(m.t))}</b></div>`);
  }
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
  if (Math.abs(z) >= 1000) return `${(z / 1000).toFixed(2)} km`;
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
