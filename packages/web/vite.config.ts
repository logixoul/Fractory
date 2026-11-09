import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const shared = fileURLToPath(new URL("../shared/src/", import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // Node-free shared code (refs, types) is compiled from source; only `refs` has runtime code here.
    alias: [{ find: /^@fractory\/shared\/(.*)$/, replacement: `${shared}$1.ts` }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco is large; it is loaded lazily, only where a code view is opened.
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: "es" },
});
