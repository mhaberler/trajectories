import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, build as viteBuild } from "vite";
import cesium from "vite-plugin-cesium";

/**
 * Leaflets Bilder als data:-URIs für den eigenständigen HTML-Export.
 *
 * Nicht über `?inline`: das liefert im Dev-Server einen Serverpfad
 * (`/node_modules/…?inline`) statt einer data:-URI. In der exportierten Datei
 * zeigte der Verweis dann ins Leere und das Ebenen-Symbol blieb ein weißer
 * Kasten — im Build sah alles korrekt aus, beim Entwickeln nicht.
 */
function leafletImages() {
  const virtualId = "virtual:leaflet-images";
  const resolvedId = `\0${virtualId}`;
  return {
    name: "trajektorien-leaflet-images",
    enforce: "pre",
    resolveId(id) {
      return id === virtualId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const require = createRequire(import.meta.url);
      const dir = join(dirname(require.resolve("leaflet/package.json")), "dist/images");
      const uri = (name) =>
        `data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}`;
      return `export const layers = ${JSON.stringify(uri("layers.png"))};
export const layers2x = ${JSON.stringify(uri("layers-2x.png"))};
export const markerIcon = ${JSON.stringify(uri("marker-icon.png"))};`;
    },
  };
}

/**
 * Der HTML-Export bettet den Viewer als fertiges IIFE-Bündel ein. Das Bündel
 * entsteht in einem eigenen, geschachtelten Vite-Lauf und wird über das
 * virtuelle Modul `virtual:viewer-bundle` als Text importiert.
 *
 * Warum kein `?raw` auf die Quelldatei: der Viewer importiert `crosssection`
 * und `units`. Als Bündel läuft das über den echten Modulgraphen — kein
 * Textumbau am Quelltext, kein Bruch bei einem neuen Import.
 */
function viewerBundle() {
  const virtualId = "virtual:viewer-bundle";
  const resolvedId = `\0${virtualId}`;
  let cached = null;

  return {
    name: "trajektorien-viewer-bundle",
    enforce: "pre",
    resolveId(id) {
      return id === virtualId ? resolvedId : null;
    },
    async load(id) {
      if (id !== resolvedId) return null;
      // Im Dev-Server bei jedem Zugriff neu bauen, damit Änderungen am Viewer
      // ohne Neustart ankommen; im Build genügt einmal.
      if (cached && process.env.NODE_ENV === "production") return cached;
      const out = await viteBuild({
        configFile: false,
        logLevel: "warn",
        build: {
          write: false,
          minify: "esbuild",
          lib: {
            entry: new URL("./src/export/htmlExportMain.ts", import.meta.url).pathname,
            formats: ["iife"],
            name: "TrajektorienViewer",
          },
          rollupOptions: {
            // Leaflet liegt zur Laufzeit als globales L vor; Cesium kommt vom CDN.
            external: ["leaflet", "cesium"],
            output: { globals: { leaflet: "L", cesium: "Cesium" } },
          },
        },
      });
      const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === "chunk");
      cached = `export default ${JSON.stringify(chunk.code)};`;
      return cached;
    },
  };
}

/** Default base `/` for local `bun run dev` / `bun run build`.
 *  VPS path deploy uses: `bunx vite build --base=/trajectories/`
 *  (deploy-vps.sh flattens vite-plugin-cesium’s nested dist/<base>/cesium). */
export default defineConfig({
  base: "/",
  plugins: [leafletImages(), viewerBundle(), cesium()],
  // Do not crawl playground HTML (track-import, colormap) — those apps have
  // their own vite.config aliases (@overlays, @colormap) and a separate
  // `npm run dev:track-import` on port 5174.
  optimizeDeps: {
    entries: ["index.html"],
  },
});
