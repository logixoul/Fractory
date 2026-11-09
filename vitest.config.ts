import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against core's sources, not its built dist/.
    alias: {
      "@fractory/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@fractory/daemon": fileURLToPath(new URL("./packages/daemon/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
