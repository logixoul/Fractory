import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the packages' sources, not their built dist/.
    alias: [
      { find: /^@fractory\/shared$/, replacement: src("./packages/shared/src/index.ts") },
      { find: /^@fractory\/shared\/(.*)$/, replacement: src("./packages/shared/src/") + "$1.ts" },
      { find: /^@fractory\/core$/, replacement: src("./packages/core/src/index.ts") },
      { find: /^@fractory\/daemon$/, replacement: src("./packages/daemon/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
