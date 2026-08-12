/**
 * Query-Parameter der exportierten HTML-Seite: Ansicht, Höhenprofil,
 * Überhöhung und Cesium-Kamera. Schreiben per replaceState (kein History-Spam).
 */

export type ExportView = "2d" | "3d";

export interface CameraState {
  lon: number;
  lat: number;
  h: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface ViewState {
  view?: ExportView;
  profile?: boolean;
  exagg?: number;
  camera?: CameraState | null;
}

const CAM_KEYS = ["lon", "lat", "h", "heading", "pitch", "roll"] as const;

function num(raw: string | null, lo?: number, hi?: number): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (lo != null && n < lo) return undefined;
  if (hi != null && n > hi) return undefined;
  return n;
}

function parseBool(raw: string | null): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return undefined;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function searchFromHref(href: string): string {
  try {
    return new URL(href).search;
  } catch {
    return "";
  }
}

/** Liest den aktuellen Query-String (ohne Side-Effects). */
export function parseViewState(search: string): ViewState {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: ViewState = {};

  const v = q.get("view");
  if (v === "2d" || v === "3d") out.view = v;

  const profile = parseBool(q.get("profile"));
  if (profile !== undefined) out.profile = profile;

  const exagg = num(q.get("exagg"), 1, 20);
  if (exagg !== undefined) out.exagg = exagg;

  const lon = num(q.get("lon"), -180, 180);
  const lat = num(q.get("lat"), -90, 90);
  const h = num(q.get("h"), 1);
  if (lon !== undefined && lat !== undefined && h !== undefined) {
    out.camera = {
      lon,
      lat,
      h,
      heading: num(q.get("heading")) ?? 0,
      pitch: num(q.get("pitch")) ?? -45,
      roll: num(q.get("roll")) ?? 0,
    };
  } else {
    out.camera = null;
  }

  return out;
}

export function readViewState(): ViewState {
  if (typeof location === "undefined") return parseViewState("");
  // Query zuerst; falls die Seite nur den Hash nutzt (file://-Fallback), von dort lesen.
  const fromQuery = parseViewState(location.search || "");
  if (
    fromQuery.view ||
    fromQuery.profile !== undefined ||
    fromQuery.exagg !== undefined ||
    fromQuery.camera
  ) {
    return fromQuery;
  }
  const hash = (location.hash || "").replace(/^#/, "");
  if (hash.includes("=")) return parseViewState(hash);
  return fromQuery;
}

/**
 * Schreibt Teilzustand in die URL. `camera: null` entfernt die Kamera-Keys
 * (z. B. beim Wechsel auf 2D). Sonstige Query-Keys bleiben erhalten.
 */
export function applyViewStateToSearch(search: string, partial: ViewState): string {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  if (partial.view === "2d" || partial.view === "3d") q.set("view", partial.view);

  if (partial.profile !== undefined) q.set("profile", partial.profile ? "1" : "0");

  if (partial.exagg !== undefined && Number.isFinite(partial.exagg) && partial.exagg >= 1) {
    q.set("exagg", String(round(partial.exagg, 1)));
  }

  if (partial.camera === null) {
    for (const k of CAM_KEYS) q.delete(k);
  } else if (partial.camera) {
    const c = partial.camera;
    q.set("lon", String(round(c.lon, 5)));
    q.set("lat", String(round(c.lat, 5)));
    q.set("h", String(round(c.h, 1)));
    q.set("heading", String(round(c.heading, 1)));
    q.set("pitch", String(round(c.pitch, 1)));
    q.set("roll", String(round(c.roll, 1)));
  }

  return q.toString();
}

/**
 * Aktualisiert die Adresszeile sofort. Preferiert `?query`; bei file:// oder
 * replaceState-Fehler Fallback auf `#query`, damit Teilen trotzdem geht.
 */
export function writeViewState(partial: ViewState): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  try {
    const u = new URL(location.href);
    // Wenn wir bisher im Hash-Fallback waren, von dort mergen.
    const baseSearch =
      u.search ||
      ((u.hash || "").includes("=") ? (u.hash || "").replace(/^#/, "") : "");
    const next = applyViewStateToSearch(baseSearch, partial);
    const isFile = u.protocol === "file:";
    if (isFile) {
      u.search = "";
      u.hash = next ? `#${next}` : "";
    } else {
      u.search = next ? `?${next}` : "";
      // Alte Hash-Fallback-Params wegräumen, sobald Query funktioniert.
      if ((u.hash || "").includes("view=") || (u.hash || "").includes("lon=")) u.hash = "";
    }
    history.replaceState(history.state, "", u.href);
  } catch {
    try {
      const next = applyViewStateToSearch(searchFromHref(location.href), partial);
      location.hash = next ? `#${next}` : "";
    } catch {
      /* Adresszeile ist Komfort */
    }
  }
}

/** True, wenn lon/lat/h in der Query stehen (Kamera wiederherstellen). */
export function hasCamera(state: ViewState): state is ViewState & { camera: CameraState } {
  return !!state.camera;
}

/** Einfacher Throttle für Kamera-Updates während der Interaktion. */
export function throttle(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  let last = 0;
  return () => {
    const now = Date.now();
    const left = ms - (now - last);
    if (left <= 0) {
      last = now;
      if (t) {
        clearTimeout(t);
        t = null;
      }
      fn();
    } else if (!t) {
      t = setTimeout(() => {
        t = null;
        last = Date.now();
        fn();
      }, left);
    }
  };
}
