import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { commandEnv, runChecksIsolated, runSetup } from "../src/checks/runner.js";
import { StepFailure } from "../src/engine/errors.js";
import { commitStepResult, revParse } from "../src/index.js";
import { ensureWorktree } from "../src/git/worktree.js";
import { CheckCommand, DEFAULT_EXCLUDE_DIRS, SetupCommand } from "../src/schemas/config.js";
import { tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

const snap = { maxIgnoredFileBytes: 1024 * 1024, excludeDirs: DEFAULT_EXCLUDE_DIRS };
const node = (code: string) => [process.execPath, "-e", code];
const check = (name: string, code: string, artifacts: string[] = []) => CheckCommand.parse({ name, argv: node(code), artifacts });
const setupCmd = (code: string) => SetupCommand.parse({ argv: node(code) });

async function worktree() {
  const repo = initRepo({ "math.js": "export const add = (a, b) => a + b;\n", ".gitignore": "node_modules/\ncoverage/\n" });
  const data = dataDir();
  const base = await revParse(repo);
  const wt = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "a1b2", base });
  fs.writeFileSync(path.join(wt.path, "math.js"), "export const add = (a, b) => a + b + 0;\n");
  const post = await commitStepResult(wt.path, "implement.a1b2", path.join(data, "empty-hooks"));
  const stepDir = path.join(data, "runs", "r", "steps", "checks.a1b2");
  fs.mkdirSync(stepDir, { recursive: true });
  return { repo, data, wt: wt.path, post, stepDir, guard: { dataDir: data, mainRepo: repo } };
}

describe("check runner (§8.18)", () => {
  it("keeps check outputs only as artifacts and restores the branch to the post-step commit", async () => {
    const w = await worktree();
    const checks = [
      check("test", "const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/lcov.info','cov');fs.writeFileSync('math.js','tampered');console.log('tests ok')", ["coverage/**"]),
      check("lint", "console.error('lint: 2 problems');process.exit(1)"),
    ];
    const out = await runChecksIsolated({
      worktree: w.wt,
      postStepSha: w.post,
      checks,
      setup: [],
      preserveOnClean: [],
      guard: w.guard,
      snapshot: snap,
      stepDir: w.stepDir,
    });
    expect(out.results.map((r) => [r.name, r.passed])).toEqual([
      ["test", true],
      ["lint", false],
    ]);
    expect(out.allPassed).toBe(false);
    expect(out.results[1]!.logTail).toContain("lint: 2 problems");
    expect(fs.readFileSync(path.join(w.stepDir, "artifacts", "test", "coverage", "lcov.info"), "utf8")).toBe("cov");
    expect(out.cleaned.some((p) => p.startsWith("coverage"))).toBe(true);
    // the branch is untouched: tracked edit reverted, no coverage dir, HEAD unchanged
    expect(fs.readFileSync(path.join(w.wt, "math.js"), "utf8")).toContain("+ 0");
    expect(fs.existsSync(path.join(w.wt, "coverage"))).toBe(false);
    expect(await revParse(w.wt)).toBe(w.post);
    expect(g(w.wt, "status", "--porcelain").trim()).toBe("");
  });

  it("reruns setup after a clean removed things, honouring preserveOnClean", async () => {
    const w = await worktree();
    const setup = [setupCmd("require('fs').mkdirSync('node_modules/dep',{recursive:true});require('fs').writeFileSync('node_modules/dep/index.js','x')")];
    await runSetup(w.wt, setup, path.join(w.stepDir, "logs"));
    const base = {
      worktree: w.wt,
      postStepSha: w.post,
      setup,
      guard: w.guard,
      snapshot: snap,
      stepDir: w.stepDir,
    };
    const preserved = await runChecksIsolated({ ...base, checks: [check("t", "")], preserveOnClean: ["node_modules/"] });
    expect(preserved.cleaned).toEqual([]);
    expect(preserved.setupRerun).toBe(false);
    const cleaned = await runChecksIsolated({ ...base, checks: [check("t", "")], preserveOnClean: [] });
    expect(cleaned.cleaned.some((p) => p.startsWith("node_modules"))).toBe(true);
    expect(cleaned.setupRerun).toBe(true);
    expect(fs.existsSync(path.join(w.wt, "node_modules", "dep", "index.js"))).toBe(true);
  });

  it("setup failure is an env_error, never a check result", async () => {
    const w = await worktree();
    const err = await runSetup(w.wt, [setupCmd("console.error('npm ERR! network');process.exit(1)")], path.join(w.stepDir, "logs")).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    expect((err as StepFailure).kind).toBe("env_error");
    expect((err as StepFailure).message).toContain("npm ERR! network");
  });

  it("a check that times out is a failed result and the tree is still restored", async () => {
    const w = await worktree();
    const out = await runChecksIsolated({
      worktree: w.wt,
      postStepSha: w.post,
      checks: [CheckCommand.parse({ name: "hang", argv: node("require('fs').writeFileSync('junk','j');setInterval(()=>{},1000)"), timeoutMs: 1500 })],
      setup: [],
      preserveOnClean: [],
      guard: w.guard,
      snapshot: snap,
      stepDir: w.stepDir,
    });
    expect(out.results[0]).toMatchObject({ passed: false, reason: "timeout" });
    expect(fs.existsSync(path.join(w.wt, "junk"))).toBe(false);
  });

  it("strips secrets from check/setup env", () => {
    const env = commandEnv({ EXTRA: "1" }, { PATH: "p", TOGETHER_API_KEY: "k", GH_TOKEN: "t" });
    expect(env).toEqual({ PATH: "p", EXTRA: "1" });
    void tmpDir;
  });
});
