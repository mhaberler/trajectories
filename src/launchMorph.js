/**
 * Pure launch-window morph: resample + lerp between precomputed start samples.
 * Used by the app (2D/3D scrub) and the HTML export viewer.
 */

export const LAUNCH_RESAMPLE_N = 64;

export function morphKey(run) {
  return `${run.heightM}|${run.method}`;
}

/** Resample track points by relative elapsed time (hold end if short). */
export function resampleTrack(points, n = LAUNCH_RESAMPLE_N) {
  if (!points?.length) return [];
  if (points.length === 1) {
    return Array.from({ length: n }, () => ({ ...points[0] }));
  }
  const t0 = points[0].tMs;
  const t1 = points[points.length - 1].tMs;
  const span = Math.abs(t1 - t0) || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const frac = k / (n - 1);
    const target = t0 + Math.sign(t1 - t0 || 1) * frac * span;
    let i = 0;
    if (t1 >= t0) {
      while (i < points.length - 2 && points[i + 1].tMs < target) i++;
    } else {
      while (i < points.length - 2 && points[i + 1].tMs > target) i++;
    }
    const a = points[i];
    const b = points[i + 1] || a;
    const den = (b.tMs - a.tMs) || 1;
    const w = Math.min(1, Math.max(0, (target - a.tMs) / den));
    out.push({
      lat: a.lat + w * (b.lat - a.lat),
      lon: a.lon + w * (b.lon - a.lon),
      z: Number.isFinite(a.z) && Number.isFinite(b.z) ? a.z + w * (b.z - a.z) : (a.z ?? b.z ?? null),
      tMs: target,
    });
  }
  return out;
}

function lerpNum(a, b, alpha) {
  if (Number.isFinite(a) && Number.isFinite(b)) return a + alpha * (b - a);
  return Number.isFinite(a) ? a : (Number.isFinite(b) ? b : null);
}

/** Markers keyed by elapsed ms from track start, sorted. */
function markersByRel(marks, t0) {
  return (marks || [])
    .filter((m) => Number.isFinite(m?.tMs) && Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map((m) => ({
      rel: m.tMs - t0,
      lat: m.lat,
      lon: m.lon,
      z: m.z,
      u: m.u,
      v: m.v,
      met: m.met || null,
      rows: m.rows || null,
    }))
    .sort((a, b) => a.rel - b.rel);
}

/** Sample marker list at a relative elapsed time (hold ends; lerp between). */
function sampleMarkerAtRel(sorted, rel) {
  if (!sorted.length) return null;
  if (rel <= sorted[0].rel) return sorted[0];
  const last = sorted[sorted.length - 1];
  if (rel >= last.rel) return last;
  let i = 0;
  while (i < sorted.length - 2 && sorted[i + 1].rel < rel) i++;
  const a = sorted[i];
  const b = sorted[i + 1];
  const w = (rel - a.rel) / ((b.rel - a.rel) || 1);
  return {
    rel,
    lat: a.lat + w * (b.lat - a.lat),
    lon: a.lon + w * (b.lon - a.lon),
    z: lerpNum(a.z, b.z, w),
    u: lerpNum(a.u, b.u, w),
    v: lerpNum(a.v, b.v, w),
    met: lerpMet(a.met, b.met, w),
    rows: a.rows || b.rows || null,
  };
}

function lerpMet(ma, mb, alpha) {
  if (!ma && !mb) return null;
  if (!ma) return mb;
  if (!mb) return ma;
  return {
    t: lerpNum(ma.t, mb.t, alpha),
    td: lerpNum(ma.td, mb.td, alpha),
    rh: lerpNum(ma.rh, mb.rh, alpha),
    p: lerpNum(ma.p, mb.p, alpha),
  };
}

/**
 * Morph markers between two tracks: grid = A's relative times; sample B at
 * the same elapsed offset; lerp fields. `outT0` is absolute start for tooltips.
 */
export function lerpMarkers(marksA, marksB, t0A, t0B, alpha, outT0) {
  const A = markersByRel(marksA, t0A);
  const B = markersByRel(marksB, t0B);
  if (!A.length) return [];
  return A.map((a) => {
    const b = B.length ? (sampleMarkerAtRel(B, a.rel) || a) : a;
    return {
      lat: a.lat + alpha * (b.lat - a.lat),
      lon: a.lon + alpha * (b.lon - a.lon),
      z: lerpNum(a.z, b.z, alpha),
      tMs: outT0 + a.rel,
      u: lerpNum(a.u, b.u, alpha),
      v: lerpNum(a.v, b.v, alpha),
      met: lerpMet(a.met, b.met, alpha),
      rows: a.rows || b.rows || null,
    };
  });
}

function trackStartMs(run) {
  const p0 = run?.r?.points?.[0]?.tMs;
  if (Number.isFinite(p0)) return p0;
  const m0 = run?.r?.markers?.[0]?.tMs;
  return Number.isFinite(m0) ? m0 : 0;
}

export function lerpRuns(runsA, runsB, alpha) {
  const mapB = new Map(runsB.map((r) => [morphKey(r), r]));
  const out = [];
  for (const a of runsA) {
    const b = mapB.get(morphKey(a));
    if (!b) continue;
    const pa = resampleTrack(a.r.points);
    const pb = resampleTrack(b.r.points);
    const points = pa.map((p, i) => {
      const q = pb[i] || pb[pb.length - 1];
      return {
        lat: p.lat + alpha * (q.lat - p.lat),
        lon: p.lon + alpha * (q.lon - p.lon),
        z: Number.isFinite(p.z) && Number.isFinite(q.z)
          ? p.z + alpha * (q.z - p.z)
          : (p.z ?? q.z ?? null),
        tMs: p.tMs + alpha * (q.tMs - p.tMs),
      };
    });
    const t0A = trackStartMs(a);
    const t0B = trackStartMs(b);
    const outT0 = t0A + alpha * (t0B - t0A);
    const markers = lerpMarkers(a.r.markers, b.r.markers, t0A, t0B, alpha, outT0);
    out.push({
      ...a,
      r: { points, markers, status: a.r.status, reason: a.r.reason },
    });
  }
  return out;
}

/**
 * Lerp launch-window samples at tMs.
 * @param {{ t0Ms: number, runs: object[] }[]} samples
 * @param {number} tMs
 * @returns {object[] | null}
 */
export function computeMorphRuns(samples, tMs) {
  if (!samples?.length) return null;
  let i = 0;
  while (i < samples.length - 2 && samples[i + 1].t0Ms <= tMs) i++;
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  const den = (b.t0Ms - a.t0Ms) || 1;
  const alpha = Math.min(1, Math.max(0, (tMs - a.t0Ms) / den));
  if (a === b) {
    return a.runs.map((r) => ({
      ...r,
      r: {
        ...r.r,
        points: resampleTrack(r.r.points),
        markers: (r.r.markers || []).map((m) => ({ ...m })),
      },
    }));
  }
  return lerpRuns(a.runs, b.runs, alpha);
}

/** Index of sample whose t0Ms is closest to tMs (for profile snap). */
export function nearestSampleIndex(samples, tMs) {
  if (!samples?.length) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i].t0Ms - tMs);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Convert compact PayloadRun[] to morph run shape. */
export function payloadRunsToMorph(runs) {
  return (runs || []).map((run) => ({
    heightM: run.heightM,
    method: run.method,
    label: run.label,
    color: run.color,
    dash: run.dash,
    name: run.name,
    r: {
      points: (run.pts || []).map(([lat, lon, z, tMs]) => ({ lat, lon, z, tMs })),
      markers: (run.markers || []).map((m) => ({
        lat: m.lat,
        lon: m.lon,
        z: m.z,
        tMs: m.tMs,
        u: m.u ?? null,
        v: m.v ?? null,
        met: m.met ?? null,
        rows: m.rows || null,
      })),
    },
  }));
}

/** Convert morph runs back to PayloadRun[]. */
export function morphRunsToPayload(runs) {
  return (runs || []).map((run) => ({
    heightM: run.heightM,
    method: run.method,
    label: run.label,
    color: run.color,
    dash: run.dash,
    name: run.name,
    pts: (run.r?.points || []).map((p) => [p.lat, p.lon, p.z, p.tMs]),
    markers: (run.r?.markers || []).map((m) => ({
      lat: m.lat,
      lon: m.lon,
      z: m.z,
      tMs: m.tMs,
      rows: m.rows || [],
    })),
  }));
}

/**
 * Morph payload launch samples at tMs → PayloadRun[].
 * @param {{ t0Ms: number, runs: object[] }[]} samples  samples with PayloadRun[]
 */
export function computeMorphPayloadRuns(samples, tMs) {
  if (!samples?.length) return null;
  const morphSamples = samples.map((s) => ({
    t0Ms: s.t0Ms,
    runs: payloadRunsToMorph(s.runs),
  }));
  const morphed = computeMorphRuns(morphSamples, tMs);
  return morphed ? morphRunsToPayload(morphed) : null;
}
