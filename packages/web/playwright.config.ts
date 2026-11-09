import { defineConfig } from "@playwright/test";

/**
 * GUI smoke test against the built daemon + GUI with fake workers (no model calls).
 * Run with `npm run e2e` (builds first). Uses the locally installed Chrome (also preinstalled on
 * GitHub-hosted runners), so no browser download is needed; override with FRACTORY_E2E_CHANNEL.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: process.env.FRACTORY_E2E_CHANNEL ?? "chrome",
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
});
