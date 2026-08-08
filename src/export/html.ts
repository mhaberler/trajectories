/**
 * Vite-Hülle des HTML-Exports: sammelt die einzubettenden Texte und reicht
 * sie an die reine Logik in `htmlPayload.ts` weiter.
 *
 * Dieses Modul wird nur bei Bedarf geladen (`await import(...)` im Download-
 * Handler), damit die rund 165 kB Leaflet-Text nicht im Hauptbündel landen.
 */

import leafletJs from "leaflet/dist/leaflet.js?raw";
import leafletCssRaw from "leaflet/dist/leaflet.css?raw";
import viewerCss from "./viewer.css?raw";
import viewerBundle from "virtual:viewer-bundle";
// Leaflets CSS verweist relativ auf images/*.png — in einer alleinstehenden
// Datei gäbe es die nicht (das Ebenen-Symbol bliebe leer). Daher eingebettet.
import layersPng from "leaflet/dist/images/layers.png?inline";
import layers2xPng from "leaflet/dist/images/layers-2x.png?inline";
import markerPng from "leaflet/dist/images/marker-icon.png?inline";
import { buildPayload, jsonForScript, renderDocument } from "./htmlPayload";
import type { ExportCtx } from "./htmlPayload";
import type { LastRuns } from "../types";

const leafletCss = leafletCssRaw
  .replace(/url\(images\/layers-2x\.png\)/g, `url(${layers2xPng})`)
  .replace(/url\(images\/layers\.png\)/g, `url(${layersPng})`)
  .replace(/url\(images\/marker-icon\.png\)/g, `url(${markerPng})`);

export function buildHTML(data: LastRuns, ctx: ExportCtx): string {
  const payload = buildPayload(data, ctx);
  return renderDocument({
    title: payload.meta.title,
    leafletCss,
    viewerCss,
    leafletJs,
    // Bündel definiert window.initViewer; danach mit den Daten starten.
    viewerJs: `${viewerBundle}
initViewer(JSON.parse(document.getElementById("data").textContent));`,
    json: jsonForScript(payload),
  });
}
