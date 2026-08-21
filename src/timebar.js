/**
 * Panel time bar: meta-range viewport, optional launch-window band, playhead.
 * Times are UTC milliseconds since epoch.
 */

const MIN_VIEWPORT_MS = 6 * 3600e3;
const BAND_GRAB_PX = 40;
const EDGE_HIT_PX = 10;

/** @typedef {{
 *   meta0: number, meta1: number,
 *   v0: number, v1: number,
 *   tStart: number, tEnd: number,
 *   playMs: number,
 * }} TimebarModel */

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
    el, launchWindowH, setLaunchWindowH, launchStepMin, fmtTime,
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

  const root = () => el("timebar");
  const track = () => el("timebar-track");
  const band = () => el("timebar-band");
  const playhead = () => el("timebar-playhead");
  const ticks = () => el("timebar-ticks");
  const callouts = () => el("timebar-callouts");
  const callStart = () => el("timebar-callout-start");
  const callEnd = () => el("timebar-callout-end");

  function windowMs() {
    return Math.max(0, m.tEnd - m.tStart);
  }

  function minBandMs() {
    return Math.max(60e3, launchStepMin() * 60e3);
  }

  function clamp(x, a, b) {
    return Math.min(b, Math.max(a, x));
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
    const h = Math.max(0, launchWindowH());
    if (h <= 0) {
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
    } else {
      const w = h * 3600e3;
      m.tEnd = clamp(m.tStart + w, m.tStart + minBandMs(), m.meta1);
      if (m.tEnd - m.tStart < w * 0.99) {
        m.tStart = clamp(m.tEnd - w, m.meta0, m.meta1);
      }
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
    }
  }

  function writeLaunchWindowField() {
    const h = windowMs() / 3600e3;
    const rounded = Math.round(h * 4) / 4;
    suppressBandCommit = true;
    setLaunchWindowH(rounded);
    suppressBandCommit = false;
  }

  function fmtShort(ms) {
    const d = new Date(ms);
    const wd = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getUTCDay()];
    const day = d.getUTCDate();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${wd} ${day} · ${hh}:${mm}Z`;
  }

  function renderTicks() {
    const host = ticks();
    if (!host) return;
    host.replaceChildren();
    const span = m.v1 - m.v0;
    if (span <= 0) return;
    // Day boundaries in viewport
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
    const co = callouts();
    if (!tr || !b || !ph) return;

    const wMs = windowMs();
    const showBand = wMs >= minBandMs() * 0.5 && launchWindowH() > 0;

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
        const hrs = (wMs / 3600e3).toFixed(wMs % 3600e3 === 0 ? 0 : 1);
        callEnd().textContent = `${fmtShort(m.tEnd)} (${hrs}h)`;
        callEnd().style.left = `${right}%`;
      }
    } else {
      b.hidden = true;
      if (co) co.hidden = true;
    }

    ph.style.left = `${msToFrac(m.playMs) * 100}%`;
    renderTicks();

    const label = el("timelabel");
    if (label) label.textContent = fmtTime(m.playMs);
  }

  function emitChange() {
    onChange?.();
  }

  function ensureVisibleBand() {
    const wMs = windowMs();
    if (wMs <= 0) return;
    const tr = track();
    const width = tr?.getBoundingClientRect().width || 1;
    const bandPx = (wMs / (m.v1 - m.v0)) * width;
    if (bandPx >= BAND_GRAB_PX) return;
    // Zoom viewport around band center so band is ~BAND_GRAB_PX * 1.5 wide
    const center = (m.tStart + m.tEnd) / 2;
    const needSpan = Math.max(MIN_VIEWPORT_MS, (wMs * width) / (BAND_GRAB_PX * 1.5));
    let half = needSpan / 2;
    m.v0 = clamp(center - half, m.meta0, m.meta1);
    m.v1 = clamp(center + half, m.meta0, m.meta1);
    if (m.v1 - m.v0 < needSpan) {
      if (m.v0 <= m.meta0 + 1) m.v1 = Math.min(m.meta1, m.v0 + needSpan);
      else m.v0 = Math.max(m.meta0, m.v1 - needSpan);
    }
  }

  /**
   * @param {number} meta0Sec unix seconds
   * @param {number} meta1Sec unix seconds
   * @param {{ tStartMs?: number, playMs?: number }} [restore]
   */
  function setMeta(meta0Sec, meta1Sec, restore = {}) {
    m.meta0 = meta0Sec * 1000;
    m.meta1 = meta1Sec * 1000;
    if (m.meta1 <= m.meta0) m.meta1 = m.meta0 + 3600e3;
    m.v0 = m.meta0;
    m.v1 = m.meta1;

    const prefer = Number.isFinite(restore.tStartMs) ? restore.tStartMs : m.tStart;
    const want = Number.isFinite(prefer) && prefer > 0
      ? prefer
      : Math.round(Date.now() / 3600e3) * 3600e3;
    m.tStart = clamp(want, m.meta0, m.meta1);
    syncWindowFromInputs();
    if (Number.isFinite(restore.playMs)) {
      m.playMs = clamp(restore.playMs, m.tStart, m.tEnd || m.tStart);
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
    m.tStart = clamp(tStart, m.meta0, m.meta1);
    m.tEnd = clamp(tEnd, m.tStart, m.meta1);
    if (m.tEnd > m.tStart && m.tEnd - m.tStart < minBandMs()) {
      m.tEnd = Math.min(m.meta1, m.tStart + minBandMs());
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

  function hitTest(clientX) {
    const tr = track();
    if (!tr) return "play";
    const r = tr.getBoundingClientRect();
    const x = clientX - r.left;
    const w = r.width || 1;
    const playX = msToFrac(m.playMs) * w;
    if (Math.abs(x - playX) <= EDGE_HIT_PX + 2) return "play";
    if (launchWindowH() > 0 && windowMs() > 0) {
      const left = msToFrac(m.tStart) * w;
      const right = msToFrac(m.tEnd) * w;
      if (Math.abs(x - left) <= EDGE_HIT_PX) return "edge-l";
      if (Math.abs(x - right) <= EDGE_HIT_PX) return "edge-r";
      if (x >= left && x <= right) return "band";
    }
    return "track";
  }

  function onPointerDown(e) {
    if (!ready || e.button !== 0) return;
    const tr = track();
    if (!tr) return;
    tr.setPointerCapture?.(e.pointerId);
    const mode = e.target?.dataset?.edge === "l" ? "edge-l"
      : e.target?.dataset?.edge === "r" ? "edge-r"
      : hitTest(e.clientX);
    drag = {
      mode,
      originX: e.clientX,
      tStart0: m.tStart,
      tEnd0: m.tEnd,
      play0: m.playMs,
      v0: m.v0,
      v1: m.v1,
    };
    if (mode === "track" && launchWindowH() <= 0) {
      // Jump playhead / start to click
      const t = xToMs(e.clientX);
      m.tStart = clamp(t, m.meta0, m.meta1);
      m.tEnd = m.tStart;
      m.playMs = m.tStart;
      render();
      onPlay?.();
      emitChange();
      drag.mode = "play";
      drag.play0 = m.playMs;
    } else if (mode === "track") {
      drag.mode = "pan";
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.originX;
    const tr = track();
    const width = tr?.getBoundingClientRect().width || 1;
    const dMs = (dx / width) * (drag.v1 - drag.v0);

    if (drag.mode === "play") {
      const lo = launchWindowH() > 0 ? m.tStart : m.meta0;
      const hi = launchWindowH() > 0 ? m.tEnd : m.meta1;
      m.playMs = clamp(drag.play0 + dMs, lo, hi);
      if (launchWindowH() <= 0) {
        m.tStart = m.playMs;
        m.tEnd = m.playMs;
      }
      render();
      onPlay?.();
    } else if (drag.mode === "band") {
      const w = drag.tEnd0 - drag.tStart0;
      let ns = drag.tStart0 + dMs;
      ns = clamp(ns, m.meta0, m.meta1 - w);
      m.tStart = ns;
      m.tEnd = ns + w;
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "edge-l") {
      m.tStart = clamp(drag.tStart0 + dMs, m.meta0, drag.tEnd0 - minBandMs());
      m.playMs = clamp(m.playMs, m.tStart, m.tEnd);
      writeLaunchWindowField();
      render();
    } else if (drag.mode === "edge-r") {
      m.tEnd = clamp(drag.tEnd0 + dMs, drag.tStart0 + minBandMs(), m.meta1);
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
      ensureVisibleBand();
      render();
      onBandCommit?.();
    } else if (mode === "play" && launchWindowH() <= 0) {
      emitChange();
    }
  }

  function onWheel(e) {
    if (!ready) return;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const span = m.v1 - m.v0;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    let newSpan = clamp(span * factor, MIN_VIEWPORT_MS, m.meta1 - m.meta0);
    const center = xToMs(e.clientX);
    const leftFrac = (center - m.v0) / span;
    m.v0 = clamp(center - leftFrac * newSpan, m.meta0, m.meta1);
    m.v1 = clamp(m.v0 + newSpan, m.meta0, m.meta1);
    if (m.v1 - m.v0 < newSpan) m.v0 = Math.max(m.meta0, m.v1 - newSpan);
    render();
  }

  function bind() {
    const tr = track();
    if (!tr) return;
    tr.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    tr.addEventListener("wheel", onWheel, { passive: false });
    // Edges live on band
    band()?.querySelectorAll(".timebar-edge").forEach((edge) => {
      edge.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        onPointerDown(e);
      });
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
    onLaunchWindowInput,
    render,
    bind,
    snapshot,
    /** @deprecated compat: hour index for old callers */
    hourValue() {
      return Math.round(m.playMs / 3600e3);
    },
  };
}
