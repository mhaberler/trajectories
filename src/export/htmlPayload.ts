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
}

/** Was `buildPayload` außer `state.lastRuns` noch braucht. */
export interface ExportCtx {
  xsec: XsecData | null;
  opts: Partial<HtmlExportOpts>;
  unitState: { height: string; wind: string };
  markerFields: (m: unknown, label: string) => (PopupRow & { key?: string })[];
  trackName: (run: Run, direction: number) => string;
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
  markers: { lat: number; lon: number; rows: PopupRow[] }[];
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
}

export const HTML_EXPORT_DEFAULTS: HtmlExportOpts = {
  markers: true,
  markerRadius: 5,
  lineWidth: 3,
  lineOpacity: 0.85,
  profile: true,
  profileHeight: 200,
  baseOpacity: 1,
  defaultBase: "OpenStreetMap",
  tracklist: true,
  legendHtml: "",
};

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
          rows: ctx.markerFields(m, run.label)
            .filter(Boolean)
            .map(({ label, value }) => ({ label, value })),
        }))
      : [],
  }));

  const generated = new Date(ctx.now ?? Date.now()).toISOString();
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

/** Vollständiges, eigenständiges HTML-Dokument. */
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
<div id="map"></div>
<div id="profile"></div>
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
