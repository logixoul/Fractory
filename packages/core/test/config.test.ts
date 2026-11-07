import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, ConfigError, loadConfig } from "../src/config/load.js";
import { tmpDir } from "./helpers.js";

function setup(globalCfg?: unknown, repoCfg?: unknown) {
  const configDir = tmpDir();
  const repo = tmpDir();
  if (globalCfg !== undefined) fs.writeFileSync(path.join(configDir, CONFIG_FILENAME), JSON.stringify(globalCfg));
  if (repoCfg !== undefined) fs.writeFileSync(path.join(repo, CONFIG_FILENAME), typeof repoCfg === "string" ? repoCfg : JSON.stringify(repoCfg));
  return { configDir, repo };
}

describe("loadConfig", () => {
  it("parses built-in defaults", () => {
    const { configDir, repo } = setup();
    const { config, sources, warnings } = loadConfig({ configDir, repo });
    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
    expect(config.workers.opus).toMatchObject({ kind: "claude", model: "opus", effort: "high", command: "claude" });
    expect(config.workers.deepseek).toMatchObject({ kind: "pi", provider: "together", thinking: "high" });
    expect(config.roles).toEqual({ contestants: ["opus", "deepseek"], judge: "deepseek" });
    expect(config.prices["together/deepseek-ai/DeepSeek-V4.1-Flash-1017"]).toMatchObject({ input: 0.3, output: 1.2, cacheRead: 0.006 });
    expect(config.quota.warnUtilization).toBe(0.8);
    expect(config.consensus).toEqual({ maxRounds: 1, minRefs: 3 });
    expect(config.duel.maxFixIterations).toBe(2);
  });

  it("deep-merges defaults ← global ← repo, arrays replace", () => {
    const { configDir, repo } = setup(
      { quota: { warnUtilization: 0.5 }, workers: { deepseek: { thinking: "off" } }, contextFiles: ["A.md", "B.md"] },
      { consensus: { maxRounds: 2 }, checks: [{ name: "test", argv: ["npm", "test"] }], contextFiles: ["X.md"] },
    );
    const { config, sources } = loadConfig({ configDir, repo });
    expect(sources).toEqual([path.join(configDir, CONFIG_FILENAME), path.join(repo, CONFIG_FILENAME)]);
    expect(config.quota.warnUtilization).toBe(0.5);
    expect(config.workers.deepseek).toMatchObject({ kind: "pi", thinking: "off", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    expect(config.workers.opus).toMatchObject({ kind: "claude" });
    expect(config.consensus).toEqual({ maxRounds: 2, minRefs: 3 });
    expect(config.checks).toEqual([{ name: "test", argv: ["npm", "test"], timeoutMs: 600_000, artifacts: [] }]);
    expect(config.contextFiles).toEqual(["X.md"]);
  });

  it("reports schema errors with the contributing file", () => {
    const { configDir, repo } = setup(undefined, { roles: { judge: "nobody" } });
    expect(() => loadConfig({ configDir, repo })).toThrow(ConfigError);
    expect(() => loadConfig({ configDir, repo })).toThrow(/unknown worker 'nobody'[\s\S]*|fractory\.config\.json/);
    try {
      loadConfig({ configDir, repo });
    } catch (e) {
      expect((e as Error).message).toContain(path.join(repo, CONFIG_FILENAME));
      expect((e as Error).message).toContain("unknown worker 'nobody'");
    }
  });

  it("rejects invalid JSON and invalid regex patterns", () => {
    const a = setup(undefined, "{ not json");
    expect(() => loadConfig(a)).toThrow(/invalid JSON/);
    const b = setup(undefined, { anonymize: { patterns: ["(unclosed"] } });
    expect(() => loadConfig(b)).toThrow(/invalid regex/);
  });

  it("rejects identical contestants", () => {
    const { configDir, repo } = setup(undefined, { roles: { contestants: ["opus", "opus"] } });
    expect(() => loadConfig({ configDir, repo })).toThrow(/two different workers/);
  });

  it("warns about Pi thinking levels the Flash model clamps", () => {
    const { configDir, repo } = setup(undefined, { workers: { deepseek: { thinking: "low" } } });
    expect(loadConfig({ configDir, repo }).warnings.join("\n")).toMatch(/clamped to 'high'/);
  });

  it("default anonymization patterns are unambiguous (no bare Pi/Together)", () => {
    const { configDir, repo } = setup();
    const pats = loadConfig({ configDir, repo }).config.anonymize.patterns.map((p) => new RegExp(p, "i"));
    const hits = (s: string) => pats.some((p) => p.test(s));
    expect(hits("Claude suggested")).toBe(true);
    expect(hits("used pi-coding-agent")).toBe(true);
    expect(hits("compute Pi digits together")).toBe(false);
  });
});
