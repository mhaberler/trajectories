/**
 * Normalize Flugprofil waypoints into a piecewise-linear AGL(t) polyline
 * for GET /v1/trajectory profile_time / profile_height.
 *
 * Input: { tSec, targetAgl } — climb/descent is implicit via Δh/Δt between points.
 */

const EPS_SEC = 1e-3;

/**
 * @typedef {{ tSec: number, targetAgl: number }} ProfileTarget
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
    pushPoint(out, sorted[i].tSec, sorted[i].targetAgl);
  }

  return dedupeStrict(out).map((p) => ({
    tSec: Math.round(p.tSec * 1000) / 1000,
    hAgl: Math.round(p.hAgl * 10) / 10,
  }));
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
    } else {
      out.push(p);
    }
  }
  return out;
}
