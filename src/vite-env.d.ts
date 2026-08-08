/** Vite-spezifische Importformen, die TypeScript sonst nicht kennt. */

declare module "*?raw" {
  const content: string;
  export default content;
}

/** Als data:-URI eingebettetes Asset. */
declare module "*?inline" {
  const url: string;
  export default url;
}

/** Fertig gebautes IIFE des Export-Viewers (siehe vite.config.js). */
declare module "virtual:viewer-bundle" {
  const code: string;
  export default code;
}

/** Leaflets Symbole als data:-URIs (siehe vite.config.js). */
declare module "virtual:leaflet-images" {
  export const layers: string;
  export const layers2x: string;
  export const markerIcon: string;
}
