import * as path from "node:path";
import envPaths from "env-paths";

const APP = "fractory";

/** OS data dir (overridable with FRACTORY_DATA_DIR, e.g. in tests). */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRACTORY_DATA_DIR ? path.resolve(env.FRACTORY_DATA_DIR) : envPaths(APP, { suffix: "" }).data;
}

/** OS config dir holding the global fractory.config.json (overridable with FRACTORY_CONFIG_DIR). */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRACTORY_CONFIG_DIR ? path.resolve(env.FRACTORY_CONFIG_DIR) : envPaths(APP, { suffix: "" }).config;
}

export const dataPaths = (dataDir: string) => ({
  runs: path.join(dataDir, "runs"),
  worktrees: path.join(dataDir, "worktrees"),
  emptyHooks: path.join(dataDir, "empty-hooks"),
  piAgent: path.join(dataDir, "pi-agent"),
  piSessions: path.join(dataDir, "pi-sessions"),
  quotaFile: path.join(dataDir, "quota.json"),
});
