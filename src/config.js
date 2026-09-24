export const DEFAULT_API_BASE = "https://open-meteo.mah.priv.at";
/** Compiled default Open-Meteo host (not the live override). */
export const API_BASE = DEFAULT_API_BASE;

/** Public Open-Meteo (pressure-level / geopotential vars not on private hosts). */
export const OM_PUBLIC_FORECAST = "https://api.open-meteo.com/v1/forecast";

/** Isobaric levels available on api.open-meteo.com (ICON). */
export const OM_PRESSURE_LEVELS_HPA = [
  1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30,
];

export const DEFAULT_TRAJECTORY_API = "https://trajectory.mah.priv.at";
/** Compiled default FastAPI origin (not the live override). */
export const TRAJECTORY_API = DEFAULT_TRAJECTORY_API;

/**
 * Absolute http(s) origin, no trailing slash. Path kept if present.
 * Empty or invalid → null.
 */
export function normalizeApiOrigin(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  const origin = `${u.protocol}//${u.host}`;
  return path && path !== "/" ? `${origin}${path}` : origin;
}

let trajectoryApiOverride = "";
let apiBaseOverride = "";

/** Apply user-chosen origins. Empty/invalid clears that override. */
export function setApiEndpoints({ trajectoryApi, apiBase } = {}) {
  if (trajectoryApi !== undefined) {
    const n = normalizeApiOrigin(trajectoryApi);
    trajectoryApiOverride = n && n !== DEFAULT_TRAJECTORY_API ? n : "";
  }
  if (apiBase !== undefined) {
    const n = normalizeApiOrigin(apiBase);
    apiBaseOverride = n && n !== DEFAULT_API_BASE ? n : "";
  }
}

/** Live FastAPI origin for /v1/trajectory and DEM. */
export function trajectoryApi() {
  return trajectoryApiOverride || DEFAULT_TRAJECTORY_API;
}

/** Live default Open-Meteo host (models with their own ``apiBase`` ignore this). */
export function omApiBase() {
  return apiBaseOverride || DEFAULT_API_BASE;
}

/** Open-Meteo base URL for a model (optional per-model ``apiBase``). */
export function modelApiBase(model) {
  return String(model?.apiBase || omApiBase()).replace(/\/$/, "");
}

/** Forecast API path (default ``/v1/forecast``). */
export function modelApiPath(model) {
  const p = model?.apiPath || "/v1/forecast";
  return p.startsWith("/") ? p : `/${p}`;
}

/** Full forecast URL prefix: ``{apiBase}{apiPath}``. */
export function modelForecastUrl(model) {
  return `${modelApiBase(model)}${modelApiPath(model)}`;
}

/** Max trajectory duration (h); matches Python `forecast_horizon_h`. */
export function modelForecastHorizonH(modelOrKey) {
  const model = typeof modelOrKey === "string" ? MODELS[modelOrKey] : modelOrKey;
  const h = Number(model?.forecastHorizonH);
  return Number.isFinite(h) && h > 0 ? h : 72;
}

// Levelzählung der API: N=1 oberstes, N=nLevels unterstes Modelllevel (~10 m AGL).
export const MODELS = {
  icon_d2: {
    apiModel: "icon_d2",
    dataset: "dwd_icon_d2",
    label: "ICON-D2 (~2,2 km)",
    grid: 0.02,
    gridMeters: 2200,
    nLevels: 65,
    forecastHorizonH: 48,
    bbox: { latMin: 43.18, latMax: 58.08, lonMin: -3.94, lonMax: 20.34 },
  },
  icon_eu: {
    apiModel: "icon_eu",
    dataset: "dwd_icon_eu",
    label: "ICON-EU (~6,5 km)",
    grid: 0.0625,
    gridMeters: 6500,
    nLevels: 74,
    forecastHorizonH: 120,
    bbox: { latMin: 29.5, latMax: 70.5, lonMin: -23.5, lonMax: 62.5 },
  },
  // Same OM host/path as D2/EU; W on half levels (nHalfLevels).
  icon_global: {
    apiModel: "icon_global",
    dataset: "dwd_icon",
    label: "ICON Global (~28 km)",
    grid: 0.25,
    gridMeters: 28000,
    nLevels: 120,
    nHalfLevels: 121,
    forecastHorizonH: 180,
    bbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 179.75 },
  },
};

// CVD-validierte Farb-Slots für helle Kartenhintergründe. Eine Höhe behält
// ihren Slot, solange sie in der Liste ist (Farbe folgt der Höhe, nie dem
// Listenplatz — Hinzufügen/Entfernen färbt die übrigen nicht um). Maximal
// 8 Höhen gleichzeitig.
export const SERIES_COLORS = [
  "#2a78d6", "#008300", "#e87ba4", "#eda100",
  "#1baf7a", "#eb6834", "#4a3aa7", "#e34948",
];

export const DEFAULT_HEIGHTS = [500, 1500, 3000];
export const HEIGHT_MIN = 0;
export const HEIGHT_MAX = 10000;

// Zeitmarken-Abstände (Minuten) für die Punktmarkierungen.
export const MARKER_INTERVALS = [10, 30, 60, 180, 360];

// Methodenvergleich: Farbe je Berechnungsart (die ersten vier Palette-Slots
// sind auch paarweise CVD-validiert), Strichlierung als Zweitkodierung.
export const METHODS = [
  { key: "height", label: "konstante Höhe", color: "#2a78d6", dash: null },
  { key: "pressure", label: "isobar", color: "#008300", dash: "8 6" },
  { key: "theta", label: "isentrop", color: "#e87ba4", dash: "12 4 3 4" },
  { key: "z3d", label: "Modell-w (3D)", color: "#eda100", dash: "2 6" },
];
