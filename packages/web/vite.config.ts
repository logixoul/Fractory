import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco is large; it is loaded lazily, only for the duel diff view.
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: "es" },
});
