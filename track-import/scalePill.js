/**
 * Pill colorbar: gradient bar with unit + value labels on top.
 * Same DOM can sit in a panel, an L.Control, or a Cesium HTML overlay.
 */

/**
 * @param {number} min
 * @param {number} max
 * @param {number} [count]
 * @returns {number[]}
 */
export function niceTicks(min, max, count = 4) {
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
  const last = ticks[ticks.length - 1];
  if (Math.abs(last - max) > step * 1e-6) ticks.push(max);
  if (ticks[0] !== min && Math.abs(ticks[0] - min) > step * 1e-6) ticks.unshift(min);
  return ticks;
}

function formatTick(v) {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v));
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  return String(+v.toPrecision(3));
}

/**
 * @param {HTMLElement} host
 * @param {{ compact?: boolean }} [opts]
 */
export function mountScalePill(host, opts = {}) {
  const root = document.createElement("div");
  root.className = "scale-pill" + (opts.compact ? " compact" : "");

  const unitEl = document.createElement("span");
  unitEl.className = "scale-pill-unit";

  const ticksEl = document.createElement("div");
  ticksEl.className = "scale-pill-ticks";

  root.append(unitEl, ticksEl);
  host.replaceChildren(root);

  return {
    root,
    /**
     * @param {{ unit: string, max: number, gradientCss: string, ticks?: number[], vertical?: boolean }} s
     */
    set(s) {
      const max = s.max > 0 ? s.max : 1;
      const vertical = !!s.vertical;
      root.classList.toggle("vertical", vertical);
      root.style.background = s.gradientCss || "#888";
      unitEl.textContent = s.unit || "";
      const ticks = Array.isArray(s.ticks) && s.ticks.length
        ? s.ticks
        : niceTicks(0, max, 4);
      ticksEl.replaceChildren();
      for (const v of ticks) {
        const t = document.createElement("span");
        t.className = "scale-pill-tick";
        t.textContent = formatTick(v);
        const frac = Math.min(1, Math.max(0, v / max));
        t.style.left = "";
        t.style.top = "";
        if (vertical) {
          t.style.top = `${(1 - frac) * 100}%`;
        } else {
          t.style.left = `${frac * 100}%`;
        }
        if (frac < 0.08) t.classList.add("start");
        else if (frac > 0.92) t.classList.add("end");
        ticksEl.appendChild(t);
      }
    },
    destroy() {
      host.replaceChildren();
    },
  };
}
