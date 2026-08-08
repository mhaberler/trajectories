import { defineConfig, build as viteBuild } from "vite";
import cesium from "vite-plugin-cesium";

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
            entry: new URL("./src/export/htmlViewer.ts", import.meta.url).pathname,
            formats: ["iife"],
            name: "TrajektorienViewer",
          },
          rollupOptions: {
            // Leaflet liegt zur Laufzeit als globales L vor.
            external: ["leaflet"],
            output: { globals: { leaflet: "L" } },
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
  plugins: [viewerBundle(), cesium()],
});
