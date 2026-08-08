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
// Eigenes virtuelles Modul statt `?inline`, weil letzteres im Dev-Server einen
// Serverpfad liefert und nur im Build eine data:-URI (siehe vite.config.js).
import { layers as layersPng, layers2x as layers2xPng, markerIcon as markerPng }
  from "virtual:leaflet-images";
import { buildPayload, jsonForScript, renderDocument } from "./htmlPayload";
import type { ExportCtx } from "./htmlPayload";
import type { LastRuns } from "../types";

/**
 * Leaflets relative Bildverweise durch eingebettete data:-URIs ersetzen.
 *
 * Bewusst beim Export ausgeführt und nicht als Modulkonstante: als Konstante
 * faltet der Bundler den Ausdruck zusammen und im Ergebnis blieben die
 * ursprünglichen `url(images/…)` stehen — das Ebenen-Symbol war dann ein
 * leerer weißer Kasten.
 */
function inlineLeafletImages(): string {
  const map: [RegExp, string][] = [
    [/url\(\s*(['"]?)images\/layers-2x\.png\1\s*\)/g, layers2xPng],
    [/url\(\s*(['"]?)images\/layers\.png\1\s*\)/g, layersPng],
    [/url\(\s*(['"]?)images\/marker-icon\.png\1\s*\)/g, markerPng],
  ];
  let css = leafletCssRaw;
  for (const [re, uri] of map) {
    // Ersetzungsfunktion statt Zeichenkette: `$` in data:-URIs bliebe sonst
    // als Sondersequenz stehen.
    css = css.replace(re, () => `url("${uri}")`);
  }
  return css;
}

export function buildHTML(data: LastRuns, ctx: ExportCtx): string {
  const payload = buildPayload(data, ctx);
  return renderDocument({
    title: payload.meta.title,
    leafletCss: inlineLeafletImages(),
    viewerCss,
    leafletJs,
    // Bündel definiert window.initViewer; danach mit den Daten starten.
    viewerJs: `${viewerBundle}
initViewer(JSON.parse(document.getElementById("data").textContent));`,
    json: jsonForScript(payload),
  });
}
