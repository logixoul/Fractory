import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { defaultConfigDir } from "../paths.js";
import { Config, DEFAULT_CONFIG_INPUT, configWarnings } from "../schemas/config.js";

export const CONFIG_FILENAME = "fractory.config.json";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface LoadedConfig {
  config: Config;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  warnings: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars from `over` replace. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function readConfigFile(file: string): unknown | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    const v: unknown = JSON.parse(text.replace(/^﻿/, ""));
    if (!isPlainObject(v)) throw new Error("top level must be an object");
    return v;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

export function parseConfig(input: unknown, sources: string[] = []): LoadedConfig {
  const res = Config.safeParse(input);
  if (!res.success) {
    const where = sources.length ? ` (from ${sources.join(", ")})` : "";
    throw new ConfigError(`invalid fractory config${where}:\n${z.prettifyError(res.error)}`);
  }
  return { config: res.data, sources, warnings: configWarnings(res.data) };
}

/**
 * defaults ← <config dir>/fractory.config.json ← <repo>/fractory.config.json ← overrides
 */
export function loadConfig(opts: { repo?: string; configDir?: string; overrides?: unknown } = {}): LoadedConfig {
  const layers: { file: string; value: unknown }[] = [];
  const globalFile = path.join(opts.configDir ?? defaultConfigDir(), CONFIG_FILENAME);
  const g = readConfigFile(globalFile);
  if (g !== undefined) layers.push({ file: globalFile, value: g });
  if (opts.repo) {
    const repoFile = path.join(opts.repo, CONFIG_FILENAME);
    const r = readConfigFile(repoFile);
    if (r !== undefined) layers.push({ file: repoFile, value: r });
  }
  for (const l of layers) {
    const v = l.value as Record<string, unknown>;
    if (typeof v.envFile === "string" && !path.isAbsolute(v.envFile)) {
      l.value = { ...v, envFile: path.resolve(path.dirname(l.file), v.envFile) };
    }
  }
  const ov = opts.overrides as Record<string, unknown> | undefined;
  const overrides = ov && typeof ov.envFile === "string" && !path.isAbsolute(ov.envFile) ? { ...ov, envFile: path.resolve(ov.envFile) } : opts.overrides;
  let merged: unknown = DEFAULT_CONFIG_INPUT;
  for (const l of layers) merged = deepMerge(merged, l.value);
  merged = deepMerge(merged, overrides);
  return parseConfig(merged, layers.map((l) => l.file));
}
