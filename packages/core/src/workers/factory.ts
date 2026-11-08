import * as fs from "node:fs";
import * as path from "node:path";
import { dataPaths } from "../paths.js";
import type { Config } from "../schemas/config.js";
import { parseEnvFile } from "../util/envfile.js";
import type { Redactor } from "../util/redact.js";
import { ClaudeWorker } from "./claude.js";
import { PiWorker } from "./pi.js";
import type { Worker } from "./types.js";

export interface WorkerFactoryOptions {
  dataDir: string;
  redactor: Redactor;
  /** Base for resolving a relative envFile (the repo, or the config dir). */
  baseDir: string;
  env?: NodeJS.ProcessEnv;
}

/** Reads the configured envFile and registers every value with the redactor. */
export function loadSecretEnv(config: Config, o: Pick<WorkerFactoryOptions, "baseDir" | "redactor">): Record<string, string> {
  if (!config.envFile) return {};
  const file = path.resolve(o.baseDir, config.envFile);
  const vars = parseEnvFile(fs.readFileSync(file, "utf8"));
  for (const v of Object.values(vars)) o.redactor.addSecret(v);
  return vars;
}

/**
 * Real adapters for every configured worker. `fake` workers are rejected here: tests build
 * FakeWorker instances directly.
 */
export function createWorkers(config: Config, o: WorkerFactoryOptions): Record<string, Worker> {
  const secretEnv = loadSecretEnv(config, o);
  const dp = dataPaths(o.dataDir);
  const out: Record<string, Worker> = {};
  for (const [id, w] of Object.entries(config.workers)) {
    switch (w.kind) {
      case "claude":
        out[id] = new ClaudeWorker(id, w, { redactor: o.redactor, withholdEnv: Object.keys(secretEnv), ...(o.env ? { env: o.env } : {}) });
        break;
      case "pi":
        out[id] = new PiWorker(id, w, {
          redactor: o.redactor,
          secretEnv,
          agentDir: dp.piAgent,
          sessionDir: dp.piSessions,
          ...(o.env ? { env: o.env } : {}),
        });
        break;
      case "fake":
        throw new Error(`worker '${id}' is kind 'fake'; fake workers are only constructed by tests`);
    }
  }
  return out;
}
