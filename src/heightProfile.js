/** Starthöhen-Profil: Knöpfe → 1–8 Höhen auf dem 50-m-Raster. */

export const HP_MAX = 8;
export const HP_SAVED_MAX = 20;

export function snap100(m) {
  return Math.round(m / 100) * 100;
}

function snap50(m) {
  return Math.round(m / 50) * 50;
}

/** 0 means ground at the start. AGL stays 0; AMSL uses local elevation. */
export function resolveFloor(floorKnob, mode, startElevation) {
  const knob = snap100(Math.max(0, Number(floorKnob) || 0));
  if (knob > 0) return Math.max(0, knob);
  if (mode === "amsl" && Number.isFinite(startElevation) && startElevation > 0) {
    return Math.max(0, snap100(startElevation));
  }
  return 0;
}

/**
 * Shared marker: nBelow points strictly below it, the marker itself, then the rest
 * up to the ceiling. Ends stay put; interiors snap to 50 m and nudge off duplicates.
 * @returns {{ alts: number[], warning: string|null, resolved: {floor:number,ceiling:number,marker:number,n:number,nBelow:number} }}
 */
export function fillHeightProfile(knobs, { mode = "agl", startElevation = null, barMax = 10000 } = {}) {
  let n = Math.round(Number(knobs?.n) || 1);
  n = Math.min(HP_MAX, Math.max(1, n));
  let nBelow = n === 1 ? 0 : Math.round(Number(knobs?.nBelow) || 0);
  nBelow = Math.min(n - 1, Math.max(0, nBelow));
  const nAbove = n - nBelow - 1;

  let ceiling = snap100(Number(knobs?.ceiling) || 1500);
  ceiling = Math.min(barMax, Math.max(0, ceiling));
  let floor = resolveFloor(knobs?.floor, mode, startElevation);
  if (floor > ceiling) floor = ceiling;

  const markerMin = nBelow === 0 ? floor : Math.min(ceiling, floor + 100);
  const markerMax = nAbove === 0 ? ceiling : Math.max(markerMin, ceiling - 100);
  let marker = snap100(Number(knobs?.marker) || markerMin);
  marker = Math.min(markerMax, Math.max(markerMin, marker));

  const lower = placeBand(floor, marker, nBelow + 1);
  const upper = nAbove > 0 ? placeBand(marker, ceiling, nAbove + 1).slice(1) : [];
  const alts = [...new Set([...lower, ...upper])].sort((a, b) => a - b).slice(0, HP_MAX);
  const warning = alts.length < n
    ? `Nur ${alts.length} von ${n} Höhen — der Bereich ist zu eng für das 50-m-Raster.`
    : null;
  return { alts, warning, resolved: { floor, ceiling, marker, n, nBelow } };
}

function placeBand(lo, hi, count) {
  if (count <= 1) return [hi];
  const used = new Set();
  const out = [];
  for (let i = 0; i < count; i++) {
    const end = i === 0 || i === count - 1;
    let v = end ? (i === 0 ? lo : hi) : snap50(lo + (hi - lo) * (i / (count - 1)));
    if (!end) v = nudgeFree(v, lo, hi, used);
    if (v == null) continue;
    if (used.has(v)) continue;
    used.add(v);
    out.push(v);
  }
  return out;
}

function nudgeFree(v, lo, hi, used) {
  if (v > lo && v < hi && !used.has(v)) return v;
  for (let step = 50; lo + step < hi; step += 50) {
    const up = v + step;
    const down = v - step;
    if (up > lo && up < hi && !used.has(up)) return up;
    if (down > lo && down < hi && !used.has(down)) return down;
  }
  return null;
}
