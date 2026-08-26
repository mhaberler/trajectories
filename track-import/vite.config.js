import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

export default defineConfig({
  root: here,
  publicDir: false,
  resolve: {
    alias: {
      "@overlays": resolve(repo, "src/overlays/parse.js"),
      "@colormap": resolve(repo, "colormap/src/lib/colorscales.js"),
    },
  },
  server: {
    fs: { allow: [repo] },
    port: 5174,
  },
});
