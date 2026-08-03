/**
 * Expand marker target altitudes + climb/descent rates into a piecewise-linear
 * AGL(t) polyline for GET /v1/trajectory profile_time / profile_height.
 *
 * Input waypoints: { tSec, targetAgl, rate: 'jump' | number(m/s) }
 * - jump: steep line across the full gap from previous height to target
 * - rate: hold previous height, then back-timed ramp to hit target by tSec
 *         (clamped if the gap is too short for the requested rate)
 */

const EPS_SEC = 1e-3;

/**
 * @typedef {{ tSec: number, targetAgl: number, rate?: 'jump' | number }} ProfileTarget
 * @typedef {{ tSec: number, hAgl: number }} ProfilePoint
 */

/**
 * @param {ProfileTarget[]} targets
 * @returns {ProfilePoint[]}
 */
export function expandProfile(targets) {
  if (!Array.isArray(targets) || targets.length < 2) {
    throw new Error("expandProfile requires at least two waypoints");
  }
  const sorted = targets
    .map((w) => ({
      tSec: +w.tSec,
      targetAgl: Math.max(0, +w.targetAgl),
      rate: w.rate === "jump" || w.rate == null ? "jump" : +w.rate,
    }))
    .sort((a, b) => a.tSec - b.tSec);

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].tSec <= sorted[i - 1].tSec) {
      throw new Error("profile times must be strictly increasing");
    }
  }

  /** @type {ProfilePoint[]} */
  const out = [{ tSec: sorted[0].tSec, hAgl: sorted[0].targetAgl }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const h0 = out[out.length - 1].hAgl;
    const hi = cur.targetAgl;
    const tPrev = prev.tSec;
    const ti = cur.tSec;
    const dh = hi - h0;

    if (Math.abs(dh) < 1e-9 || cur.rate === "jump" || !(cur.rate > 0)) {
      pushPoint(out, ti, hi);
      continue;
    }

    const need = Math.abs(dh) / cur.rate;
    const gap = ti - tPrev;
    const tStart = Math.max(tPrev, ti - Math.min(need, gap));
    if (tStart > tPrev + EPS_SEC) {
      pushPoint(out, tStart, h0);
    }
    pushPoint(out, ti, hi);
  }

  return dedupeStrict(out).map((p) => ({
    tSec: Math.round(p.tSec * 1000) / 1000,
    hAgl: Math.round(p.hAgl * 10) / 10,
  }));
}

/**
 * Step/hold polyline for the side-view "target" line.
 * @param {ProfileTarget[]} targets
 * @returns {ProfilePoint[]}
 */
export function targetStepPolyline(targets) {
  if (!Array.isArray(targets) || targets.length < 2) return [];
  const sorted = [...targets].sort((a, b) => a.tSec - b.tSec);
  /** @type {ProfilePoint[]} */
  const pts = [{ tSec: sorted[0].tSec, hAgl: sorted[0].targetAgl }];
  for (let i = 1; i < sorted.length; i++) {
    const prevH = sorted[i - 1].targetAgl;
    const t = sorted[i].tSec;
    const h = sorted[i].targetAgl;
    pts.push({ tSec: t, hAgl: prevH });
    pts.push({ tSec: t, hAgl: h });
  }
  return pts;
}

/**
 * @param {ProfilePoint[]} pts
 * @param {number} tSec
 * @param {number} hAgl
 */
function pushPoint(pts, tSec, hAgl) {
  const last = pts[pts.length - 1];
  if (last && Math.abs(last.tSec - tSec) < EPS_SEC && Math.abs(last.hAgl - hAgl) < 1e-6) {
    return;
  }
  if (last && tSec <= last.tSec + EPS_SEC) {
    // Keep strictly increasing times for the API.
    pts.push({ tSec: last.tSec + 1, hAgl });
    return;
  }
  pts.push({ tSec, hAgl });
}

/**
 * @param {ProfilePoint[]} pts
 * @returns {ProfilePoint[]}
 */
function dedupeStrict(pts) {
  if (pts.length < 2) return pts;
  /** @type {ProfilePoint[]} */
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const last = out[out.length - 1];
    if (p.tSec <= last.tSec) {
      out.push({ tSec: last.tSec + 1, hAgl: p.hAgl });
    } else if (Math.abs(p.hAgl - last.hAgl) < 1e-9 && i < pts.length - 1) {
      // Skip intermediate duplicates of height at distinct times only if
      // followed by another hold — keep corners that change height.
      out.push(p);
    } else {
      out.push(p);
    }
  }
  return out;
}
