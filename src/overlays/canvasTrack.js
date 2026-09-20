/**
 * One Leaflet canvas layer per overlay track (dense IGC-safe).
 * Inspect always uses the full `coords` array; drawing may stride.
 */

import { speedKmh } from "./sample.js";

export const DISPLAY_CAP = 8000;

export function displayStride(n, cap = DISPLAY_CAP) {
  if (!(n > cap)) return 1;
  return Math.ceil(n / cap);
}

/**
 * @param {{ lat: number, lon: number, z?: number|null, t?: number }[]} coords
 * @param {{
 *   colorForSegment?: (i: number, a: object, b: object) => string,
 *   color?: string,
 *   weight?: number,
 *   opacity?: number,
 *   dashArray?: string,
 * }} opts
 */
export function createCanvasTrack(coords, opts = {}) {
  const CanvasTrack = L.Layer.extend({
    initialize(pts, options) {
      this._coords = pts;
      this._opts = {
        color: "#c45c26",
        weight: 3.5,
        opacity: 0.9,
        dashArray: null,
        colorForSegment: null,
        ...options,
      };
    },

    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create("canvas", "overlay-canvas-track");
      this._canvas.style.pointerEvents = "none";
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on("moveend viewreset zoom", this._redraw, this);
      this._redraw();
    },

    onRemove(map) {
      map.off("moveend viewreset zoom", this._redraw, this);
      L.DomUtil.remove(this._canvas);
      this._canvas = null;
      this._map = null;
    },

    _redraw() {
      const map = this._map;
      const canvas = this._canvas;
      if (!map || !canvas) return;
      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(size.x * dpr));
      canvas.height = Math.max(1, Math.round(size.y * dpr));
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);

      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = this._opts.opacity;
      ctx.lineWidth = this._opts.weight;

      const dash = parseDash(this._opts.dashArray);
      if (dash) ctx.setLineDash(dash);
      else ctx.setLineDash([]);

      const pts = this._coords;
      const n = pts?.length || 0;
      if (n < 2) return;
      const stride = displayStride(n);
      const colorFn = this._opts.colorForSegment;
      const fallback = this._opts.color;

      let prev = map.latLngToContainerPoint([pts[0].lat, pts[0].lon]);
      for (let i = 0; i < n - 1; ) {
        const nextI = Math.min(n - 1, i + stride);
        const a = pts[i];
        const b = pts[nextI];
        const p = map.latLngToContainerPoint([b.lat, b.lon]);
        ctx.strokeStyle = colorFn ? colorFn(i, a, b) : fallback;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        prev = p;
        i = nextI;
      }
    },
  });

  return new CanvasTrack(coords, opts);
}

function parseDash(dashArray) {
  if (!dashArray) return null;
  if (Array.isArray(dashArray)) return dashArray;
  const parts = String(dashArray).trim().split(/[\s,]+/).map(Number).filter((n) => n > 0);
  return parts.length ? parts : null;
}

/** Color helper for speed/altitude modes (track-import). */
export function segmentValue(mode, a, b) {
  if (mode === "speed") return speedKmh(a, b);
  const z = b.z ?? a.z;
  return z != null && Number.isFinite(z) ? z : null;
}
