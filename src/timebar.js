/**
 * Panel time bar: meta-range viewport, optional launch-window band, playhead.
 * Times are UTC milliseconds since epoch.
 * Band start/end snap to whole UTC hours; morph playhead stays continuous.
 */

const HOUR_MS = 3600e3;
const MIN_VIEWPORT_MS = 6 * HOUR_MS;
const BAND_GRAB_PX = 40;
const EDGE_HIT_PX = 10;
/** Max launch-window width (integer hours). */
const MAX_LAUNCH_WINDOW_H = 12;

/** @typedef {{
 *   meta0: number, meta1: number,
 *   v0: number, v1: number,
 *   tStart: number, tEnd: number,
 *   playMs: number,
 * }} TimebarModel */

function snapHour(ms) {
  return Math.round(ms / HOUR_MS) * HOUR_MS;
}

/**
 * @param {object} opts
 * @param {(id: string) => HTMLElement | null} opts.el
 * @param {() => number} opts.launchWindowH
 * @param {(h: number) => void} opts.setLaunchWindowH
 * @param {() => number} opts.launchStepMin
 * @param {(ms: number) => string} opts.fmtTime
 * @param {() => void} [opts.onPlay]
 * @param {() => void} [opts.onBandCommit]
 * @param {() => void} [opts.onChange]
 */
export function createTimebar(opts) {
  const {
    el, launchWindowH, setLaunchWindowH, fmtTime,
    onPlay, onBandCommit, onChange,
  } = opts;

  /** @type {TimebarModel} */
  const m = {
    meta0: 0,
    meta1: 1,
    v0: 0,
    v1: 1,
    tStart: 0,
    tEnd: 0,
    playMs: 0,
  };

  let ready = false;
  /** @type {null | { mode: string, originX: number, tStart0: number, tEnd0: number, play0: number, v0: number, v1: number }} */
  let drag = null;
  let suppressBandCommit = false;

  const track = () => el("timebar-track");
  const band = () => el("timebar-band");
  const playhead = () => el("timebar-playhead");
  const needle = () => el("timebar-needle");
  const scrub = () => el("timebar-scrub");
  const ticks = () => el("timebar-ticks");
  const callouts = () => el("timebar-callouts");
  const callStart = () => el("timebar-callout-start");
  const callEnd = () => el("timebar-callout-end");

  function windowMs() {
    return Math.max(0, m.tEnd - m.tStart);
  }

  /** Min band width: whole UTC hour (forecast interval). */
  function minBandMs() {
    return HOUR_MS;
  }

  function clamp(x, a, b) {
    return Math.min(b, Math.max(a, x));
  }

  function clampHour(ms) {
    const lo = hourLo();
    const hi = hourHi();
    if (hi < lo) return clamp(snapHour(ms), m.meta0, m.meta1);
    return clamp(snapHour(ms), lo, hi);
  }

  function hourLo() {
    return Math.ceil(m.meta0 / HOUR_MS) * HOUR_MS;
  }

  function hourHi() {
    return Math.floor(m.meta1 / HOUR_MS) * HOUR_MS;
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

  function syncWindowFromInputs() {
    const hRaw = Math.max(0, launchWindowH());
    const h = Math.min(MAX_LAUNCH_WINDOW_H, Math.round(hRaw));
    m.tStart = clampHour(m.tStart);
    if (h <= 0) {
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
    } else {
      const w = Math.max(1, h) * HOUR_MS;
      m.tEnd = clamp(m.tStart + w, m.tStart + minBandMs(), hourHi());
      if (m.tEnd - m.tStart < w) {
        m.tStart = clampHour(m.tEnd - w);
        m.tEnd = clamp(m.tStart + w, m.tStart + minBandMs(), hourHi());
      }
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
    }
  }

  function writeLaunchWindowField() {
    const h = Math.min(MAX_LAUNCH_WINDOW_H, Math.round(windowMs() / HOUR_MS));
    suppressBandCommit = true;
    setLaunchWindowH(h);
    suppressBandCommit = false;
  }

  function snapBandInPlace() {
    if (launchWindowH() <= 0 || windowMs() < HOUR_MS * 0.5) {
      m.tStart = clampHour(m.tStart);
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
      return;
    }
    const wHours = Math.min(
      MAX_LAUNCH_WINDOW_H,
      Math.max(1, Math.round(windowMs() / HOUR_MS)),
    );
    m.tStart = clampHour(m.tStart);
    let end = m.tStart + wHours * HOUR_MS;
    const hi = hourHi();
    if (end > hi) {
      end = hi;
      m.tStart = clampHour(end - wHours * HOUR_MS);
      end = m.tStart + Math.max(1, Math.round((Math.min(hi, m.tStart + wHours * HOUR_MS) - m.tStart) / HOUR_MS)) * HOUR_MS;
      if (end > hi) end = hi;
      if (end - m.tStart < HOUR_MS) {
        m.tStart = clampHour(hi - HOUR_MS);
        end = m.tStart + HOUR_MS;
      }
    }
    m.tEnd = end;
    m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
  }

  function fmtShort(ms) {
    const d = new Date(ms);
    const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getUTCDay()];
    const day = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    return `${wd} ${day} · ${hh}:00Z`;
  }

  function renderTicks() {
    const host = ticks();
    if (!host) return;
    host.replaceChildren();
    const span = m.v1 - m.v0;
    if (span <= 0) return;
    const d0 = new Date(m.v0);
    d0.setUTCHours(0, 0, 0, 0);
    let t = d0.getTime();
    if (t < m.v0) t += 86400e3;
    for (; t <= m.v1; t += 86400e3) {
      const frac = msToFrac(t);
      const tick = document.createElement("div");
      tick.className = "timebar-tick";
      tick.style.left = `${frac * 100}%`;
      const lab = document.createElement("span");
      lab.className = "timebar-tick-label";
      const dd = new Date(t);
      const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][dd.getUTCDay()];
      lab.textContent = `${wd} ${dd.getUTCDate()}`;
      tick.appendChild(lab);
      host.appendChild(tick);
    }
  }

  function render() {
    if (!ready) return;
    const tr = track();
    const b = band();
    const ph = playhead();
    const nd = needle();
    const co = callouts();
    if (!tr || !b || !ph) return;

    const wMs = windowMs();
    const showBand = wMs >= minBandMs() * 0.5 && launchWindowH() > 0;
    const playFrac = msToFrac(m.playMs) * 100;

    if (showBand) {
      b.hidden = false;
      if (co) co.hidden = false;
      const left = msToFrac(m.tStart) * 100;
      const right = msToFrac(m.tEnd) * 100;
      b.style.left = `${left}%`;
      b.style.width = `${Math.max(0.5, right - left)}%`;
      if (callStart()) {
        callStart().textContent = fmtShort(m.tStart);
        callStart().style.left = `${left}%`;
      }
      if (callEnd()) {
        const hrs = Math.round(wMs / HOUR_MS);
        callEnd().textContent = `${fmtShort(m.tEnd)} (${hrs}h)`;
        callEnd().style.left = `${right}%`;
      }
    } else {
      b.hidden = true;
      if (co) co.hidden = true;
    }

    ph.style.left = `${playFrac}%`;
    if (nd) nd.style.left = `${playFrac}%`;
    renderTicks();

    const resetBtn = el("timebar-reset");
    if (resetBtn) resetBtn.hidden = !ready || isFullViewport();

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

  function isFullViewport() {
    return (m.v0 <= m.meta0 + 1) && (m.v1 >= m.meta1 - 1);
  }

  function ensureVisibleBand() {
    // Never shrink the default full-meta viewport. Only refine when the user
    // has already zoomed in and the band is hard to grab.
    const wMs = windowMs();
    if (wMs <= 0) return;
    if (isFullViewport()) return;
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

  /** Reset viewport to the full available forecast / archive span. */
  function resetViewport() {
    m.v0 = m.meta0;
    m.v1 = m.meta1;
    render();
  }

  /**
   * @param {number} meta0Sec unix seconds
   * @param {number} meta1Sec unix seconds
   * @param {{ tStartMs?: number, playMs?: number }} [restore]
   */
  function setMeta(meta0Sec, meta1Sec, restore = {}) {
    m.meta0 = meta0Sec * 1000;
    m.meta1 = meta1Sec * 1000;
    if (m.meta1 <= m.meta0) m.meta1 = m.meta0 + HOUR_MS;
    m.v0 = m.meta0;
    m.v1 = m.meta1;

    const prefer = Number.isFinite(restore.tStartMs) ? restore.tStartMs : m.tStart;
    const want = Number.isFinite(prefer) && prefer > 0
      ? prefer
      : snapHour(Date.now());
    m.tStart = clampHour(want);
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

  function startMs() {
    return m.tStart;
  }

  function playMs() {
    return m.playMs;
  }

  function endMs() {
    return m.tEnd;
  }

  function setPlayMs(ms, { silent = false } = {}) {
    m.playMs = clamp(ms, m.tStart, m.tEnd || m.tStart);
    render();
    if (!silent) {
      onPlay?.();
      emitChange();
    }
  }

  function setBand(tStart, tEnd, { syncField = true } = {}) {
    m.tStart = clampHour(tStart);
    let end = clamp(snapHour(tEnd), m.tStart, hourHi());
    const maxEnd = m.tStart + MAX_LAUNCH_WINDOW_H * HOUR_MS;
    if (end > maxEnd) end = Math.min(hourHi(), maxEnd);
    m.tEnd = end;
    if (m.tEnd > m.tStart && m.tEnd - m.tStart < minBandMs()) {
      m.tEnd = Math.min(hourHi(), m.tStart + minBandMs());
    }
    m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
    if (syncField) writeLaunchWindowField();
    ensureVisibleBand();
    render();
    emitChange();
  }

  /** Called when #launchwindow changes from outside. */
  function onLaunchWindowInput() {
    if (suppressBandCommit) return;
    syncWindowFromInputs();
    ensureVisibleBand();
    render();
    emitChange();
  }

  /** Track hits only: band / edges / pan (playhead is under-scrub). */
  function hitTestTrack(clientX) {
    const tr = track();
    if (!tr) return "track";
    const r = tr.getBoundingClientRect();
    const x = clientX - r.left;
    const w = r.width || 1;
    if (launchWindowH() > 0 && windowMs() > 0) {
      const left = msToFrac(m.tStart) * w;
      const right = msToFrac(m.tEnd) * w;
      if (Math.abs(x - left) <= EDGE_HIT_PX) return "edge-l";
      if (Math.abs(x - right) <= EDGE_HIT_PX) return "edge-r";
      if (x >= left && x <= right) return "band";
    }
    return "track";
  }

  function beginDrag(e, mode) {
    const tr = track();
    if (!tr) return;
    try {
      tr.setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    drag = {
      mode,
      originX: e.clientX,
      tStart0: m.tStart,
      tEnd0: m.tEnd,
      play0: m.playMs,
      v0: m.v0,
      v1: m.v1,
    };
    // Do not preventDefault here — it suppresses click/dblclick in browsers.
  }

  function onPlayPointerDown(e) {
    if (!ready || e.button !== 0) return;
    e.stopPropagation();
    beginDrag(e, "play");
  }

  function onScrubPointerDown(e) {
    if (!ready || e.button !== 0) return;
    if (e.target === playhead()) return;
    const t = xToMs(e.clientX);
    if (launchWindowH() > 0) {
      m.playMs = clamp(t, m.tStart, m.tEnd);
      render();
      onPlay?.();
      beginDrag(e, "play");
      if (drag) {
        drag.play0 = m.playMs;
        drag.originX = e.clientX;
      }
    } else {
      const snapped = clampHour(t);
      m.tStart = snapped;
      m.tEnd = snapped;
      m.playMs = snapped;
      render();
      onPlay?.();
      emitChange();
      beginDrag(e, "play");
      if (drag) {
        drag.play0 = m.playMs;
        drag.originX = e.clientX;
      }
    }
  }

  function onTrackPointerDown(e) {
    if (!ready || e.button !== 0) return;
    // Second click of a double-click: reset viewport instead of starting a drag.
    if (e.detail >= 2) {
      resetViewport();
      return;
    }
    const mode = e.target?.dataset?.edge === "l" ? "edge-l"
      : e.target?.dataset?.edge === "r" ? "edge-r"
      : hitTestTrack(e.clientX);
    beginDrag(e, mode);
    if (!drag) return;
    if (mode === "track" && launchWindowH() <= 0) {
      const snapped = clampHour(xToMs(e.clientX));
      m.tStart = snapped;
      m.tEnd = snapped;
      m.playMs = snapped;
      render();
      onPlay?.();
      emitChange();
      drag.mode = "play";
      drag.play0 = m.playMs;
    } else if (mode === "track") {
      drag.mode = "pan";
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const tr = track();
    const width = tr?.getBoundingClientRect().width || 1;
    const dMs = (dx / width) * (drag.v1 - drag.v0);

    if (drag.mode === "play") {
      if (launchWindowH() > 0) {
        // Continuous morph scrub within band
        m.playMs = clamp(drag.play0 + dMs, m.tStart, m.tEnd);
      } else {
        // Single start: snap to forecast hours while dragging
        const snapped = clampHour(drag.play0 + dMs);
        m.playMs = snapped;
        m.tStart = snapped;
        m.tEnd = snapped;
      }
      render();
      onPlay?.();
    } else if (drag.mode === "band") {
      const w = Math.min(drag.tEnd0 - drag.tStart0, MAX_LAUNCH_WINDOW_H * HOUR_MS);
      let ns = snapHour(drag.tStart0 + dMs);
      ns = clamp(ns, hourLo(), hourHi() - w);
      m.tStart = ns;
      m.tEnd = ns + w;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "edge-l") {
      const minStart = Math.max(hourLo(), drag.tEnd0 - MAX_LAUNCH_WINDOW_H * HOUR_MS);
      let ns = snapHour(drag.tStart0 + dMs);
      ns = clamp(ns, minStart, drag.tEnd0 - minBandMs());
      m.tStart = ns;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "edge-r") {
      const maxEnd = Math.min(hourHi(), drag.tStart0 + MAX_LAUNCH_WINDOW_H * HOUR_MS);
      let ne = snapHour(drag.tEnd0 + dMs);
      ne = clamp(ne, drag.tStart0 + minBandMs(), maxEnd);
      m.tEnd = ne;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
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
    drag = null;
    try {
      track()?.releasePointerCapture?.(e.pointerId);
    } catch { /* ignore */ }
    if (mode === "band" || mode === "edge-l" || mode === "edge-r") {
      snapBandInPlace();
      writeLaunchWindowField();
      ensureVisibleBand();
      render();
      onBandCommit?.();
    } else if (mode === "play" && launchWindowH() <= 0) {
      const snapped = clampHour(m.playMs);
      m.playMs = snapped;
      m.tStart = snapped;
      m.tEnd = snapped;
      render();
      emitChange();
    }
  }

  function onWheel(e) {
    if (!ready) return;
    // Zoom whenever the pointer is over the timebar. Ctrl/Meta still works;
    // bare wheel over the bar zooms instead of scrolling the panel.
    e.preventDefault();
    e.stopPropagation();
    const span = m.v1 - m.v0;
    if (span <= 0) return;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const newSpan = clamp(span * factor, MIN_VIEWPORT_MS, m.meta1 - m.meta0);
    if (Math.abs(newSpan - span) < 1) return;
    const center = xToMs(e.clientX);
    const leftFrac = span > 0 ? (center - m.v0) / span : 0.5;
    m.v0 = clamp(center - leftFrac * newSpan, m.meta0, m.meta1);
    m.v1 = clamp(m.v0 + newSpan, m.meta0, m.meta1);
    if (m.v1 - m.v0 < newSpan) m.v0 = Math.max(m.meta0, m.v1 - newSpan);
    render();
  }

  function onTrackDblClick(e) {
    if (!ready) return;
    e.preventDefault();
    resetViewport();
  }

  function bind() {
    const tr = track();
    const root = el("timebar");
    if (!tr || !root) return;
    tr.addEventListener("pointerdown", onTrackPointerDown);
    tr.addEventListener("dblclick", onTrackDblClick);
    tr.title = "Mausrad: zoomen · Doppelklick: ganzer Zeitraum";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    // Listen on the whole timebar so wheel works over band, scrub, and callouts.
    root.addEventListener("wheel", onWheel, { passive: false });
    band()?.querySelectorAll(".timebar-edge").forEach((edge) => {
      edge.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        onTrackPointerDown(e);
      });
    });
    playhead()?.addEventListener("pointerdown", onPlayPointerDown);
    scrub()?.addEventListener("pointerdown", onScrubPointerDown);
    el("timebar-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      resetViewport();
    });
  }

  function snapshot() {
    return {
      tStartMs: m.tStart,
      playMs: m.playMs,
      v0: m.v0,
      v1: m.v1,
    };
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
    snapshot,
    /** @deprecated compat: hour index for old callers */
    hourValue() {
      return Math.round(m.playMs / HOUR_MS);
    },
  };
}
