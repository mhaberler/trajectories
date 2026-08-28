/**
 * Panel time bar (Original): Fenster squares, Start triangle, Dauer round tip.
 * Snap to Launch-Schritt; flight hatch from selected start.
 */

const HOUR_MS = 3600e3;
const MIN_VIEWPORT_MS = 6 * HOUR_MS;
const BAND_GRAB_PX = 40;
const MAX_LAUNCH_WINDOW_H = 12;
const DRAG_THRESHOLD_PX = 5;
const DBLCLICK_MS = 450;

/**
 * @param {object} opts
 * @param {(id: string) => HTMLElement | null} opts.el
 * @param {() => number} opts.launchWindowH
 * @param {(h: number) => void} opts.setLaunchWindowH
 * @param {() => number} opts.launchStepMin
 * @param {() => number} [opts.durationH]
 * @param {(h: number) => void} [opts.setDurationH]
 * @param {() => number} [opts.maxDurationH]
 * @param {() => number} [opts.direction]
 * @param {(ms: number) => string} opts.fmtTime
 * @param {() => void} [opts.onPlay]
 * @param {() => void} [opts.onBandCommit]
 * @param {() => void} [opts.onChange]
 */
export function createTimebar(opts) {
  const {
    el, launchWindowH, setLaunchWindowH, launchStepMin,
    durationH = () => 12,
    setDurationH = () => {},
    maxDurationH = () => 72,
    direction = () => 1,
    fmtTime, onPlay, onBandCommit, onChange,
  } = opts;

  const m = {
    meta0: 0, meta1: 1,
    v0: 0, v1: 1,
    tStart: 0, tEnd: 0,
    playMs: 0,
  };

  let ready = false;
  /** @type {null | Record<string, any>} */
  let drag = null;
  let suppressField = false;
  /** @type {null | { v0: number, v1: number }} */
  let savedZoom = null;
  let lastTapTs = 0;
  let lastTapX = 0;

  const track = () => el("timebar-track");
  const band = () => el("timebar-band");
  const playhead = () => el("timebar-playhead");
  const needle = () => el("timebar-needle");
  const ticks = () => el("timebar-ticks");
  const metaShade = () => el("timebar-meta-shade");
  const reachShade = () => el("timebar-reach-shade");
  const tipWinStart = () => el("timebar-tip-win-start");
  const tipWinEnd = () => el("timebar-tip-win-end");
  const tipDur = () => el("timebar-tip-dur");
  const lblWinStart = () => el("timebar-lbl-win-start");
  const lblWinEnd = () => el("timebar-lbl-win-end");
  const lblDur = () => el("timebar-lbl-dur");

  function clamp(x, a, b) {
    return Math.min(b, Math.max(a, x));
  }

  function stepMs() {
    return Math.max(5, +launchStepMin() || 15) * 60e3;
  }

  function snapStep(ms) {
    const s = stepMs();
    return Math.round(ms / s) * s;
  }

  function snapDurH(h) {
    return Math.max(0.25, Math.round(h * 4) / 4);
  }

  function clampDurH(h) {
    const cap = Math.max(0.25, +maxDurationH() || 72);
    return snapDurH(Math.min(cap, Math.max(0.25, h)));
  }

  function windowMs() {
    return Math.max(0, m.tEnd - m.tStart);
  }

  function minBandMs() {
    return stepMs();
  }

  function maxBandMs() {
    return MAX_LAUNCH_WINDOW_H * HOUR_MS;
  }

  function xToMs(clientX) {
    const tr = track();
    if (!tr) return m.playMs;
    const r = tr.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return m.v0 + clamp(f, 0, 1) * (m.v1 - m.v0);
  }

  function msToFrac(ms) {
    const span = m.v1 - m.v0;
    if (span <= 0) return 0;
    return clamp((ms - m.v0) / span, 0, 1);
  }

  function placePct(node, ms) {
    if (!node) return;
    node.style.left = `${msToFrac(ms) * 100}%`;
  }

  function placeShade(node, a, b) {
    if (!node) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const vis0 = Math.max(lo, m.v0);
    const vis1 = Math.min(hi, m.v1);
    if (!(vis1 > vis0) || m.v1 - m.v0 <= 0) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    const left = msToFrac(vis0) * 100;
    const right = msToFrac(vis1) * 100;
    node.style.left = `${left}%`;
    node.style.width = `${Math.max(0.15, right - left)}%`;
  }

  function fmtTipTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}Z`;
  }

  function fmtDurLabel(h) {
    const r = Math.round(h * 4) / 4;
    return `${String(r).replace(/\.0$/, "")}h`;
  }

  function writeLaunchWindowField() {
    const h = Math.min(MAX_LAUNCH_WINDOW_H, Math.max(0, windowMs() / HOUR_MS));
    const rounded = Math.round(h * 4) / 4;
    suppressField = true;
    setLaunchWindowH(rounded);
    suppressField = false;
  }

  function writeDurationField(h) {
    suppressField = true;
    setDurationH(snapDurH(h));
    suppressField = false;
  }

  function syncWindowFromInputs() {
    const hRaw = Math.max(0, launchWindowH());
    const h = Math.min(MAX_LAUNCH_WINDOW_H, Math.round(hRaw * 4) / 4);
    m.tStart = clamp(snapStep(m.tStart), m.meta0, m.meta1);
    if (h <= 0) {
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
    } else {
      const w = Math.max(minBandMs(), h * HOUR_MS);
      m.tEnd = clamp(m.tStart + w, m.tStart + minBandMs(), m.meta1);
      if (m.tEnd - m.tStart < w * 0.99) {
        m.tStart = clamp(m.tEnd - w, m.meta0, m.meta1);
        m.tStart = snapStep(m.tStart);
        m.tEnd = clamp(m.tStart + w, m.tStart + minBandMs(), m.meta1);
      }
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
    }
  }

  function moveWindowToStart(tStart) {
    const w = windowMs() > 0 ? Math.min(maxBandMs(), Math.max(minBandMs(), windowMs())) : 0;
    if (w <= 0 || launchWindowH() <= 0) {
      m.tStart = clamp(snapStep(tStart), m.meta0, m.meta1);
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
      return;
    }
    let ns = snapStep(tStart);
    ns = clamp(ns, m.meta0, m.meta1 - w);
    m.tStart = ns;
    m.tEnd = ns + w;
    m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
  }

  function renderTicks() {
    const host = ticks();
    if (!host) return;
    host.replaceChildren();
    if (m.v1 - m.v0 <= 0) return;
    const d0 = new Date(m.v0);
    d0.setUTCHours(0, 0, 0, 0);
    let t = d0.getTime();
    if (t < m.v0) t += 86400e3;
    for (; t <= m.v1; t += 86400e3) {
      const tick = document.createElement("div");
      tick.className = "timebar-tick";
      tick.style.left = `${msToFrac(t) * 100}%`;
      const lab = document.createElement("span");
      lab.className = "timebar-tick-label";
      const dd = new Date(t);
      const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][dd.getUTCDay()];
      lab.textContent = `${wd} ${dd.getUTCDate()}`;
      tick.appendChild(lab);
      host.appendChild(tick);
    }
  }

  function renderShades() {
    placeShade(metaShade(), m.meta0, m.meta1);

    const durH = clampDurH(+durationH() || 12);
    const dir = +direction() === -1 ? -1 : 1;
    const durMs = durH * HOUR_MS;
    const reach0 = dir > 0 ? m.playMs : m.playMs - durMs;
    const reach1 = dir > 0 ? m.playMs + durMs : m.playMs;
    placeShade(reachShade(), reach0, reach1);
  }

  function stackedTipHtml(timeOrDur, sub) {
    return `<b>${timeOrDur}</b><span class="timebar-tip-sub">${sub}</span>`;
  }

  function labelsOverlap(a, b, pad = 4) {
    if (!a || !b || a.hidden || b.hidden) return false;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    if (ra.width <= 0 || rb.width <= 0) return false;
    return !(ra.right + pad <= rb.left || rb.right + pad <= ra.left);
  }

  /** Priority start > Dauer > end — hide lower priority when colliding. */
  function resolveTipLabelCollisions() {
    const start = lblWinStart();
    const end = lblWinEnd();
    const dur = lblDur();
    // Drop end first (lowest priority)
    if (labelsOverlap(start, end) && end) end.hidden = true;
    if (labelsOverlap(dur, end) && end && !end.hidden) end.hidden = true;
    // Then Dauer vs remaining visible labels
    if (labelsOverlap(start, dur) && dur) dur.hidden = true;
    if (labelsOverlap(dur, end) && dur && end && !end.hidden) dur.hidden = true;
  }

  function renderTips() {
    const showWin = launchWindowH() > 0 && windowMs() >= minBandMs() * 0.5;
    const durH = clampDurH(+durationH() || 12);
    const dir = +direction() === -1 ? -1 : 1;
    const durEnd = m.playMs + dir * durH * HOUR_MS;

    for (const node of [tipWinStart(), tipWinEnd(), lblWinStart(), lblWinEnd()]) {
      if (node) node.hidden = !showWin;
    }
    if (showWin) {
      placePct(tipWinStart(), m.tStart);
      placePct(tipWinEnd(), m.tEnd);
      placePct(lblWinStart(), m.tStart);
      placePct(lblWinEnd(), m.tEnd);
      if (lblWinStart()) {
        lblWinStart().innerHTML = stackedTipHtml(fmtTipTime(m.tStart), "start");
      }
      if (lblWinEnd()) {
        lblWinEnd().innerHTML = stackedTipHtml(fmtTipTime(m.tEnd), "end");
      }
    }

    placePct(tipDur(), durEnd);
    placePct(lblDur(), durEnd);
    if (lblDur()) {
      lblDur().innerHTML = stackedTipHtml(fmtDurLabel(durH), "Dauer");
    }
    if (tipDur()) tipDur().hidden = false;
    if (lblDur()) lblDur().hidden = false;

    // Measure after layout; hide crowded labels.
    resolveTipLabelCollisions();
  }

  function isFullViewport() {
    return (m.v0 <= m.meta0 + 1) && (m.v1 >= m.meta1 - 1);
  }

  function render() {
    if (!ready) return;
    const tr = track();
    const b = band();
    const ph = playhead();
    const nd = needle();
    if (!tr || !b || !ph) return;

    const wMs = windowMs();
    const showBand = launchWindowH() > 0 && wMs >= minBandMs() * 0.5;
    const playFrac = msToFrac(m.playMs) * 100;

    if (showBand) {
      b.hidden = false;
      const left = msToFrac(m.tStart) * 100;
      const right = msToFrac(m.tEnd) * 100;
      b.style.left = `${left}%`;
      b.style.width = `${Math.max(0.5, right - left)}%`;
    } else {
      b.hidden = true;
    }

    ph.style.left = `${playFrac}%`;
    if (nd) nd.style.left = `${playFrac}%`;
    renderTicks();
    renderShades();
    renderTips();

    const resetBtn = el("timebar-reset");
    if (resetBtn) {
      const canRestore = !!(savedZoom && savedZoom.v1 > savedZoom.v0
        && !(savedZoom.v0 <= m.meta0 + 1 && savedZoom.v1 >= m.meta1 - 1));
      if (!ready) {
        resetBtn.hidden = true;
      } else if (!isFullViewport()) {
        resetBtn.hidden = false;
        resetBtn.textContent = "Ganzer Zeitraum";
        resetBtn.title = "Ansicht auf den gesamten Modellzeitraum";
      } else if (canRestore) {
        resetBtn.hidden = false;
        resetBtn.textContent = "Zurück zoomen";
        resetBtn.title = "Letzte Zoomstufe wiederherstellen";
      } else {
        resetBtn.hidden = true;
      }
    }

    const root = el("timebar");
    if (root) {
      root.dataset.v0 = String(Math.round(m.v0));
      root.dataset.v1 = String(Math.round(m.v1));
      root.dataset.meta0 = String(Math.round(m.meta0));
      root.dataset.meta1 = String(Math.round(m.meta1));
    }

    const label = el("timelabel");
    if (label) label.textContent = fmtTime(m.playMs);
  }

  function emitChange() {
    onChange?.();
  }

  function ensureVisibleBand() {
    const wMs = windowMs();
    if (wMs <= 0 || isFullViewport()) return;
    const tr = track();
    const width = tr?.getBoundingClientRect().width || 1;
    const bandPx = (wMs / (m.v1 - m.v0)) * width;
    if (bandPx >= BAND_GRAB_PX) return;
    const center = (m.tStart + m.tEnd) / 2;
    const needSpan = Math.max(MIN_VIEWPORT_MS, (wMs * width) / (BAND_GRAB_PX * 1.5));
    m.v0 = clamp(center - needSpan / 2, m.meta0, m.meta1);
    m.v1 = clamp(center + needSpan / 2, m.meta0, m.meta1);
    if (m.v1 - m.v0 < needSpan) {
      if (m.v0 <= m.meta0 + 1) m.v1 = Math.min(m.meta1, m.v0 + needSpan);
      else m.v0 = Math.max(m.meta0, m.v1 - needSpan);
    }
  }

  function resetViewport() {
    if (!isFullViewport()) savedZoom = { v0: m.v0, v1: m.v1 };
    m.v0 = m.meta0;
    m.v1 = m.meta1;
    render();
  }

  function toggleViewportZoom() {
    if (!ready) return;
    if (!isFullViewport()) {
      savedZoom = { v0: m.v0, v1: m.v1 };
      m.v0 = m.meta0;
      m.v1 = m.meta1;
      render();
      return;
    }
    if (savedZoom && savedZoom.v1 > savedZoom.v0
      && !(savedZoom.v0 <= m.meta0 + 1 && savedZoom.v1 >= m.meta1 - 1)) {
      m.v0 = clamp(savedZoom.v0, m.meta0, m.meta1);
      m.v1 = clamp(savedZoom.v1, m.meta0, m.meta1);
      if (m.v1 - m.v0 < MIN_VIEWPORT_MS) {
        const mid = (m.v0 + m.v1) / 2;
        m.v0 = clamp(mid - MIN_VIEWPORT_MS / 2, m.meta0, m.meta1);
        m.v1 = Math.min(m.meta1, m.v0 + MIN_VIEWPORT_MS);
      }
      render();
    }
  }

  function zoomBy(factor, centerMs) {
    const span = m.v1 - m.v0;
    if (span <= 0) return;
    const newSpan = clamp(span * factor, MIN_VIEWPORT_MS, m.meta1 - m.meta0);
    if (Math.abs(newSpan - span) < 1) return;
    const center = Number.isFinite(centerMs) ? centerMs : (m.v0 + m.v1) / 2;
    const leftFrac = span > 0 ? (center - m.v0) / span : 0.5;
    m.v0 = clamp(center - leftFrac * newSpan, m.meta0, m.meta1);
    m.v1 = clamp(m.v0 + newSpan, m.meta0, m.meta1);
    if (m.v1 - m.v0 < newSpan) m.v0 = Math.max(m.meta0, m.v1 - newSpan);
    lastTapTs = 0;
    render();
  }

  function setMeta(meta0Sec, meta1Sec, restore = {}) {
    m.meta0 = meta0Sec * 1000;
    m.meta1 = meta1Sec * 1000;
    if (m.meta1 <= m.meta0) m.meta1 = m.meta0 + HOUR_MS;
    m.v0 = m.meta0;
    m.v1 = m.meta1;
    savedZoom = null;

    const prefer = Number.isFinite(restore.tStartMs) ? restore.tStartMs : m.tStart;
    const want = Number.isFinite(prefer) && prefer > 0 ? prefer : snapStep(Date.now());
    m.tStart = clamp(snapStep(want), m.meta0, m.meta1);
    syncWindowFromInputs();
    if (Number.isFinite(restore.playMs)) {
      m.playMs = clamp(restore.playMs, m.tStart, m.tEnd || m.tStart);
    } else {
      m.playMs = m.tStart;
    }
    ready = true;
    ensureVisibleBand();
    render();
    emitChange();
  }

  function startMs() { return m.tStart; }
  function playMs() { return m.playMs; }
  function endMs() { return m.tEnd; }

  function setPlayMs(ms, { silent = false } = {}) {
    m.playMs = clamp(ms, m.tStart, m.tEnd || m.tStart);
    render();
    if (!silent) {
      onPlay?.();
      emitChange();
    }
  }

  function setBand(tStart, _tEnd, { syncField = true } = {}) {
    m.tStart = clamp(snapStep(tStart), m.meta0, m.meta1);
    syncWindowFromInputs();
    if (syncField) writeLaunchWindowField();
    ensureVisibleBand();
    render();
    emitChange();
  }

  function onLaunchWindowInput() {
    if (suppressField) return;
    syncWindowFromInputs();
    ensureVisibleBand();
    render();
    emitChange();
  }

  function hitTestTrack(clientX) {
    const tr = track();
    if (!tr) return "track";
    const r = tr.getBoundingClientRect();
    const x = clientX - r.left;
    const w = r.width || 1;
    if (launchWindowH() > 0 && windowMs() > 0) {
      const left = msToFrac(m.tStart) * w;
      const right = msToFrac(m.tEnd) * w;
      if (x >= left && x <= right) return "band";
    }
    return "track";
  }

  function beginDrag(e, mode) {
    drag = {
      mode,
      originX: e.clientX,
      originY: e.clientY,
      tStart0: m.tStart,
      tEnd0: m.tEnd,
      play0: m.playMs,
      dur0: clampDurH(+durationH() || 12),
      v0: m.v0,
      v1: m.v1,
      moved: false,
      pointerId: e.pointerId,
    };
  }

  function activateDrag() {
    if (!drag || drag.moved) return;
    drag.moved = true;
    try {
      track()?.setPointerCapture?.(drag.pointerId);
    } catch { /* ignore */ }
  }

  function noteTapForDblClick(clientX) {
    const now = performance.now();
    if (now - lastTapTs < DBLCLICK_MS && Math.abs(clientX - lastTapX) < 24) {
      lastTapTs = 0;
      toggleViewportZoom();
      return true;
    }
    lastTapTs = now;
    lastTapX = clientX;
    return false;
  }

  function onPlayPointerDown(e) {
    if (!ready || e.button !== 0) return;
    e.stopPropagation();
    beginDrag(e, "play");
  }

  function onTipPointerDown(e) {
    if (!ready || e.button !== 0) return;
    const tip = e.currentTarget?.dataset?.tip;
    if (!tip) return;
    e.stopPropagation();
    beginDrag(e, tip);
  }

  function onTrackPointerDown(e) {
    if (!ready || e.button !== 0) return;
    const mode = hitTestTrack(e.clientX);
    beginDrag(e, mode === "band" ? "band" : "pan");
    if (!drag) return;
    if (mode === "track" && launchWindowH() <= 0) {
      drag.mode = "play";
      drag.clickSnap = snapStep(xToMs(e.clientX));
      drag.play0 = drag.clickSnap;
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dist = Math.hypot(e.clientX - drag.originX, e.clientY - (drag.originY ?? 0));
    if (!drag.moved) {
      if (dist < DRAG_THRESHOLD_PX) return;
      activateDrag();
      lastTapTs = 0;
    }
    const dx = e.clientX - drag.originX;
    const width = track()?.getBoundingClientRect().width || 1;
    const dMs = (dx / width) * (drag.v1 - drag.v0);
    const dir = +direction() === -1 ? -1 : 1;

    if (drag.mode === "play") {
      if (launchWindowH() > 0) {
        m.playMs = clamp(drag.play0 + dMs, m.tStart, m.tEnd);
      } else {
        const base = Number.isFinite(drag.clickSnap) ? drag.clickSnap : drag.play0;
        const t = clamp(base + dMs, m.meta0, m.meta1);
        m.playMs = t;
        m.tStart = t;
        m.tEnd = t;
      }
      render();
      onPlay?.();
    } else if (drag.mode === "band") {
      moveWindowToStart(drag.tStart0 + dMs);
      render();
    } else if (drag.mode === "win-start") {
      let ns = snapStep(drag.tStart0 + dMs);
      const maxStart = drag.tEnd0 - minBandMs();
      const minStart = Math.max(m.meta0, drag.tEnd0 - maxBandMs());
      ns = clamp(ns, minStart, maxStart);
      m.tStart = ns;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "win-end") {
      let ne = snapStep(drag.tEnd0 + dMs);
      const minEnd = drag.tStart0 + minBandMs();
      const maxEnd = Math.min(m.meta1, drag.tStart0 + maxBandMs());
      ne = clamp(ne, minEnd, maxEnd);
      m.tEnd = ne;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "dur-end") {
      const tip0 = drag.play0 + dir * drag.dur0 * HOUR_MS;
      const tip = tip0 + dMs;
      let h = dir > 0 ? (tip - m.playMs) / HOUR_MS : (m.playMs - tip) / HOUR_MS;
      h = clampDurH(h);
      writeDurationField(h);
      render();
      emitChange();
    } else if (drag.mode === "pan") {
      const span = drag.v1 - drag.v0;
      let nv0 = drag.v0 - dMs;
      nv0 = clamp(nv0, m.meta0, m.meta1 - span);
      m.v0 = nv0;
      m.v1 = nv0 + span;
      render();
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    const mode = drag.mode;
    const moved = drag.moved;
    const clickSnap = drag.clickSnap;
    const originX = drag.originX;
    drag = null;
    try {
      track()?.releasePointerCapture?.(e.pointerId);
    } catch { /* ignore */ }

    if (!moved) {
      if (mode === "play" && Number.isFinite(clickSnap) && launchWindowH() <= 0) {
        const t = clamp(snapStep(clickSnap), m.meta0, m.meta1);
        m.tStart = t;
        m.tEnd = t;
        m.playMs = t;
        render();
        onPlay?.();
        emitChange();
      }
      noteTapForDblClick(originX);
      return;
    }

    if (mode === "play") {
      if (launchWindowH() > 0) {
        m.playMs = clamp(snapStep(m.playMs), m.tStart, m.tEnd);
      } else {
        const t = clamp(snapStep(m.playMs), m.meta0, m.meta1);
        m.playMs = t;
        m.tStart = t;
        m.tEnd = t;
      }
      render();
      onPlay?.();
      emitChange();
    } else if (mode === "band" || mode === "win-start" || mode === "win-end") {
      m.tStart = snapStep(m.tStart);
      m.tEnd = snapStep(m.tEnd);
      if (m.tEnd - m.tStart < minBandMs() && launchWindowH() > 0) {
        m.tEnd = Math.min(m.meta1, m.tStart + minBandMs());
      }
      m.playMs = clamp(snapStep(m.playMs), m.tStart, m.tEnd);
      writeLaunchWindowField();
      ensureVisibleBand();
      render();
      onBandCommit?.();
    } else if (mode === "dur-end") {
      emitChange();
    }
  }

  function onWheel(e) {
    if (!ready) return;
    e.preventDefault();
    e.stopPropagation();
    zoomBy(e.deltaY > 0 ? 1.15 : 1 / 1.15, xToMs(e.clientX));
  }

  function bind() {
    const tr = track();
    const root = el("timebar");
    if (!tr || !root) return;
    tr.addEventListener("pointerdown", onTrackPointerDown);
    root.title = "Mausrad: zoomen · Doppelklick: ganzer Zeitraum / zurück";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    root.addEventListener("wheel", onWheel, { passive: false });

    playhead()?.addEventListener("pointerdown", onPlayPointerDown);
    tipWinStart()?.addEventListener("pointerdown", onTipPointerDown);
    tipWinEnd()?.addEventListener("pointerdown", onTipPointerDown);
    tipDur()?.addEventListener("pointerdown", onTipPointerDown);

    el("timebar-zoom-in")?.addEventListener("click", (e) => {
      e.preventDefault();
      zoomBy(1 / 1.35, (m.v0 + m.v1) / 2);
    });
    el("timebar-zoom-out")?.addEventListener("click", (e) => {
      e.preventDefault();
      zoomBy(1.35, (m.v0 + m.v1) / 2);
    });
    el("timebar-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      lastTapTs = 0;
      toggleViewportZoom();
    });
  }

  return {
    setMeta,
    startMs,
    playMs,
    endMs,
    setPlayMs,
    setBand,
    resetViewport,
    onLaunchWindowInput,
    render,
    bind,
    snapshot() {
      return { tStartMs: m.tStart, playMs: m.playMs, v0: m.v0, v1: m.v1 };
    },
    hourValue() {
      return Math.round(m.playMs / HOUR_MS);
    },
  };
}
