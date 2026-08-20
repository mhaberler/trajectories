/**
 * Nutzlast und Gerüst des eigenständigen HTML-Exports.
 *
 * Bewusst frei von DOM und Vite-spezifischen Importen, damit die ganze Logik
 * unter `bun test` läuft. Die Vite-Hülle (`html.ts`) reicht nur die per `?raw`
 * eingebetteten Quelltexte herein.
 */

import type { LastRuns, Run, TerrainSeries, XsecData } from "../types";

/** Eine Zeile im Marker-Popup (aus `kmlMarkerFields` des Hauptprogramms). */
export interface PopupRow {
  label: string;
  value: string;
}

/** Einstellungen des HTML-Exports (siehe EXPORT_DEFAULTS in app.js). */
export interface HtmlExportOpts {
  markers: boolean;
  markerRadius: number;
  lineWidth: number;
  lineOpacity: number;
  profile: boolean;
  profileHeight: number;
  baseOpacity: number;
  defaultBase: string;
  tracklist: boolean;
  legendHtml: string;
  /** Startansicht der exportierten Datei. */
  defaultView: "2d" | "3d";
  /** Anfangs-Überhöhung der 3D-Ansicht. */
  exaggeration: number;
  /** 3D-Kartengrundlage (esri|osm|opentopo). */
  defaultImagery: "esri" | "osm" | "opentopo";
}

/** Importierte Flugspur für HTML 2D/3D. coords: [lat, lon, z|null]. */
export interface PayloadOverlay {
  name: string;
  color: string;
  note: string;
  visible: boolean;
  coords: [number, number, number | null][];
}

/** Was `buildPayload` außer `state.lastRuns` noch braucht. */
export interface ExportCtx {
  xsec: XsecData | null;
  opts: Partial<HtmlExportOpts>;
  unitState: { height: string; wind: string };
  markerFields: (m: unknown, label: string) => (PopupRow & { key?: string })[];
  trackName: (run: Run, direction: number) => string;
  /** Startpunkt für 3D-Höhenabgleich (Geoid/Ellipsoid). */
  start?: { lat: number; lon: number } | null;
  /** Modellorographie am Start (m NN), für denselben Abgleich. */
  modelElev?: number | null;
  /** Importierte Flugspuren (bereits [lat,lon,z] fürs Payload). */
  overlays?: PayloadOverlay[];
  /** Nur für Tests/Reproduzierbarkeit; sonst „jetzt". */
  now?: number;
}

export interface PayloadRun {
  label: string;
  color: string;
  dash: string | null;
  name: string;
  /** [lat, lon, z|null, tMs] — z fehlt, solange die Höhe unbekannt ist. */
  pts: [number, number, number | null, number][];
  markers: { lat: number; lon: number; z: number | null; rows: PopupRow[] }[];
}

export interface Payload {
  meta: {
    modelKey: string;
    mode: string;
    t0Ms: number;
    duration: number;
    direction: number;
    generated: string;
    title: string;
  };
  units: { height: string; wind: string };
  opts: HtmlExportOpts;
  runs: PayloadRun[];
  xsec: XsecData;
  start: { lat: number; lon: number } | null;
  modelElev: number | null;
  overlays: PayloadOverlay[];
}

export const HTML_EXPORT_DEFAULTS: HtmlExportOpts = {
  markers: true,
  markerRadius: 5,
  lineWidth: 3,
  lineOpacity: 0.85,
  profile: false,
  profileHeight: 200,
  baseOpacity: 1,
  defaultBase: "OpenStreetMap",
  tracklist: true,
  legendHtml: "",
  defaultView: "2d",
  exaggeration: 1.5,
  defaultImagery: "esri",
};

/** Gepinnte Cesium-Version für CDN (Workers/Assets über CESIUM_BASE_URL). */
export const CESIUM_CDN_VERSION = "1.143.0";
export const CESIUM_CDN_BASE =
  `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_CDN_VERSION}/Build/Cesium/`;

/** Koordinaten auf `prec` Nachkommastellen, Höhe auf ganze Meter. */
function rd(x: number, prec: number) {
  const f = 10 ** prec;
  return Math.round(x * f) / f;
}

/**
 * Nur die Felder, die `renderCrossSection` liest — der Rest (heightM, method,
 * Integrator-Interna) bläht die Datei sonst unnötig auf.
 */
function pickXsec(xsec: XsecData, prec: number): XsecData {
  return {
    t0Ms: xsec.t0Ms,
    direction: xsec.direction,
    overlay: xsec.overlay,
    ...(xsec.terrainHi ? { terrainHi: roundSeries(xsec.terrainHi) } : {}),
    runs: xsec.runs.map((run) => ({
      label: run.label,
      color: run.color,
      dash: run.dash,
      heightM: run.heightM,
      method: run.method,
      terrain: run.terrain.map((g) => (Number.isFinite(g) ? Math.round(g as number) : null)),
      ...(run.terrainHi ? { terrainHi: roundSeries(run.terrainHi) } : {}),
      r: {
        status: run.r.status,
        reason: run.r.reason,
        points: run.r.points.map((p) => ({
          lat: rd(p.lat, prec),
          lon: rd(p.lon, prec),
          z: Number.isFinite(p.z) ? Math.round(p.z as number) : null,
          tMs: p.tMs,
        })),
        markers: run.r.markers.map((m) => ({
          lat: rd(m.lat, prec),
          lon: rd(m.lon, prec),
          z: Number.isFinite(m.z) ? Math.round(m.z as number) : null,
          tMs: m.tMs,
          u: m.u,
          v: m.v,
        })),
      },
    })),
  } as XsecData;
}

function roundSeries(s: TerrainSeries): TerrainSeries {
  return s.map((p) => ({ tSec: Math.round(p.tSec), z: Math.round(p.z) }));
}

/**
 * Nutzlast des Exports. `ctx.xsec` liefert das Gelände — `state.lastRuns`
 * allein trägt es nicht, deshalb der harte Abbruch statt einer stillen Datei
 * ohne Geländeprofil.
 */
export function buildPayload(data: LastRuns, ctx: ExportCtx): Payload {
  if (!ctx.xsec || !Array.isArray(ctx.xsec.runs) || !ctx.xsec.runs.length) {
    throw new Error("Kein Querschnitt-Zustand — bitte Trajektorien neu berechnen.");
  }
  const opts: HtmlExportOpts = { ...HTML_EXPORT_DEFAULTS, ...ctx.opts };
  if (opts.defaultView !== "3d") opts.defaultView = "2d";
  if (!(opts.exaggeration >= 1)) opts.exaggeration = HTML_EXPORT_DEFAULTS.exaggeration;
  if (opts.defaultImagery !== "osm" && opts.defaultImagery !== "opentopo") {
    opts.defaultImagery = "esri";
  }
  const prec = 5;
  const { runs, modelKey, mode, t0Ms, duration, direction } = data;

  const payloadRuns: PayloadRun[] = runs.map((run) => ({
    label: run.label,
    color: run.color,
    dash: run.dash,
    name: ctx.trackName(run, direction),
    pts: run.r.points.map((p) => [
      rd(p.lat, prec),
      rd(p.lon, prec),
      Number.isFinite(p.z) ? Math.round(p.z as number) : null,
      p.tMs,
    ] as [number, number, number | null, number]),
    // Popup-Inhalt wird hier erzeugt: `kmlMarkerFields` formatiert bereits in
    // der gewählten Einheit, dadurch braucht der Viewer keine Einheitenlogik.
    markers: opts.markers
      ? run.r.markers
        .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
        .map((m) => ({
          lat: rd(m.lat, prec),
          lon: rd(m.lon, prec),
          z: Number.isFinite((m as { z?: number }).z)
            ? Math.round((m as { z: number }).z)
            : null,
          rows: ctx.markerFields(m, run.label)
            .filter(Boolean)
            .map(({ label, value }) => ({ label, value })),
        }))
      : [],
  }));

  const generated = new Date(ctx.now ?? Date.now()).toISOString();
  const start = ctx.start && Number.isFinite(ctx.start.lat) && Number.isFinite(ctx.start.lon)
    ? { lat: rd(ctx.start.lat, prec), lon: rd(ctx.start.lon, prec) }
    : null;
  const modelElev = Number.isFinite(ctx.modelElev as number) ? Math.round(ctx.modelElev as number) : null;

  const overlays: PayloadOverlay[] = (ctx.overlays || [])
    .filter((o) => o.visible !== false && Array.isArray(o.coords) && o.coords.length >= 2)
    .map((o) => ({
      name: o.name,
      color: o.color,
      note: o.note || "",
      visible: true,
      coords: o.coords.map((c) => [
        rd(c[0], prec),
        rd(c[1], prec),
        Number.isFinite(c[2] as number) ? Math.round(c[2] as number) : null,
      ] as [number, number, number | null]),
    }));

  return {
    meta: {
      modelKey,
      mode,
      t0Ms,
      duration,
      direction,
      generated,
      title: `Windtrajektorien ${modelKey} — ${new Date(t0Ms).toISOString().slice(0, 16)}Z`,
    },
    units: { ...ctx.unitState },
    opts,
    runs: payloadRuns,
    xsec: pickXsec(ctx.xsec, prec),
    start,
    modelElev,
    overlays,
  };
}

/**
 * JSON für die Einbettung in ein `<script type="application/json">`.
 *
 * Nur `</script` beendet den Block — als `<\/script` maskiert bleibt es
 * gültiges JSON. `<!--` und U+2028/U+2029 werden vorsorglich mitmaskiert,
 * damit die Nutzlast auch in einem klassischen Skriptkontext heil bliebe.
 */
export function jsonForScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\u0021--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface DocParts {
  title: string;
  leafletCss: string;
  viewerCss: string;
  leafletJs: string;
  viewerJs: string;
  json: string;
}

function esc(s: string) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
}

/** Vollständiges, eigenständiges HTML-Dokument (2D Leaflet + optional 3D Cesium). */
export function renderDocument(p: DocParts): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>${esc(p.title)}</title>
<style>
${p.leafletCss}
</style>
<style>
${p.viewerCss}
</style>
</head>
<body>
<header class="gv-top">
  <div class="gv-title">${esc(p.title)}</div>
  <div class="gv-view-toggle" role="group" aria-label="Ansicht">
    <button type="button" class="gv-view-btn" data-view="2d">Karte</button>
    <button type="button" class="gv-view-btn" data-view="3d">3D</button>
  </div>
</header>
<div id="view-2d" class="gv-pane">
  <div id="map"></div>
  <div id="profile"></div>
</div>
<div id="view-3d" class="gv-pane" hidden>
  <div id="globe"></div>
  <div class="gv-3d-chrome">
    <label class="gv-exagg">Überhöhung
      <input type="range" id="ex-globe-exagg" min="1" max="10" step="0.5" />
      <span id="ex-globe-exagg-label">×1.5</span>
    </label>
    <label class="gv-exagg">Karte
      <select id="ex-globe-imagery">
        <option value="esri">Esri Satellit</option>
        <option value="osm">OpenStreetMap</option>
        <option value="opentopo">OpenTopoMap</option>
      </select>
    </label>
    <div id="ex-globe-note" class="gv-3d-note"></div>
  </div>
</div>
<script>
${p.leafletJs}
</script>
<script id="data" type="application/json">${p.json}</script>
<script>
${p.viewerJs}
</script>
</body>
</html>
`;
}
