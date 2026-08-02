import { defineConfig } from "vite";

/** Default base `/` for local `bun run dev` / `bun run build`.
 *  VPS path deploy uses: `bunx vite build --base=/trajectories/` */
export default defineConfig({
  base: "/",
});
