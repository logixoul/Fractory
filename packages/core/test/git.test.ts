import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkpoint, commitStepResult, restoreCheckpoint } from "../src/git/checkpoint.js";
import { escapingLinksByLabel, evaluateGates, gatesPassed, hashInputs, takeBaseline } from "../src/git/gates.js";
import { commitAll, revParse, squashedDiff } from "../src/git/git.js";
import { GuardError, assertWorktreeTarget, guardedClean, guardedResetHard, guardedWorktreeRemove } from "../src/git/guard.js";
import { SnapshotCache, diffSnapshots, escapingLinks, parsePorcelainZ, takeSnapshot } from "../src/git/snapshot.js";
import { ensureWorktree, worktreeBranch, worktreePath } from "../src/git/worktree.js";
import { DEFAULT_EXCLUDE_DIRS } from "../src/schemas/config.js";
import { tmpDir } from "./helpers.js";
import { dataDir, g, initRepo } from "./git-helpers.js";

const snap = { maxIgnoredFileBytes: 1024, excludeDirs: DEFAULT_EXCLUDE_DIRS };
const linkType = process.platform === "win32" ? "junction" : "dir";

async function setup() {
  const repo = initRepo();
  const data = dataDir();
  const base = await revParse(repo);
  const a = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "a1b2", base });
  const b = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "c3d4", base });
  return { repo, data, base, a, b, ctx: { dataDir: data, mainRepo: repo } };
}

describe("worktrees", () => {
  it("creates neutral, idempotent worktrees outside the repo", async () => {
    const { repo, data, base, a } = await setup();
    expect(a.path).toBe(worktreePath(data, "20261108-000000-abcd", "a1b2"));
    expect(a.branch).toBe(worktreeBranch("20261108-000000-abcd", "a1b2"));
    expect(a.head).toBe(base);
    expect(g(a.path, "branch", "--show-current").trim()).toBe("fractory/20261108-000000-abcd/a1b2");
    const again = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "a1b2", base });
    expect(again).toEqual(a);
  });

  it("recovers a stale registration whose directory was deleted behind git's back", async () => {
    const { repo, data, base, a } = await setup();
    fs.rmSync(a.path, { recursive: true, force: true });
    const again = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "a1b2", base });
    expect(again.head).toBe(base);
    expect(g(again.path, "branch", "--show-current").trim()).toBe(a.branch);
  });

  it("reports the real head of an existing branch advanced past base", async () => {
    const { repo, data, base, a } = await setup();
    fs.writeFileSync(path.join(a.path, "adv.txt"), "x");
    const advanced = await commitAll(a.path, { emptyHooksDir: path.join(data, "empty-hooks"), message: "adv" });
    fs.rmSync(a.path, { recursive: true, force: true });
    g(repo, "worktree", "prune");
    const again = await ensureWorktree({ repo, dataDir: data, runId: "20261108-000000-abcd", label: "a1b2", base });
    expect(again.head).toBe(advanced);
    expect(advanced).not.toBe(base);
  });
});

describe("hook-free orchestrator commits (§8.17)", () => {
  it("commits despite failing hooks and commit.gpgsign=true, as fractory", async () => {
    const { a, data } = await setup();
    // Worktrees share the main repo's hooks dir.
    const hooksDir = path.join(g(a.path, "rev-parse", "--git-common-dir").trim(), "hooks");
    const abs = path.isAbsolute(hooksDir) ? hooksDir : path.join(a.path, hooksDir);
    fs.mkdirSync(abs, { recursive: true });
    for (const h of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
      fs.writeFileSync(path.join(abs, h), "#!/bin/sh\necho hook ran >&2\nexit 1\n", { mode: 0o755 });
    }
    g(a.path, "config", "commit.gpgsign", "true");
    g(a.path, "config", "user.signingkey", "DEADBEEFNOTAKEY");
    // sanity: a normal commit is blocked by the hook
    fs.writeFileSync(path.join(a.path, "x.txt"), "x");
    expect(() => g(a.path, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "nope")).toThrow();
    const sha = await commitAll(a.path, { emptyHooksDir: path.join(data, "empty-hooks"), message: "fractory: checkpoint s" });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(g(a.path, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s").trim()).toBe(
      "fractory <fractory@localhost>|fractory <fractory@localhost>|fractory: checkpoint s",
    );
    expect(g(a.path, "show", "-s", "--format=%G?", sha).trim()).toBe("N");
  });
});

describe("guarded destructive git (§8.3)", () => {
  it("refuses the main repo, its parent, outside dirs, traversal and link escapes", async () => {
    const { repo, data, a, ctx } = await setup();
    const reject = (p: string) => expect(() => assertWorktreeTarget(p, ctx)).toThrow(GuardError);
    reject(repo);
    reject(path.dirname(repo));
    reject(tmpDir("fractory-outside-"));
    reject(path.join(data, "worktrees"));
    reject(path.join(a.path, "..", "..", "..", "..", path.basename(repo)));
    reject(path.join(data, "worktrees", "..", "runs"));
    // a junction inside worktrees/ pointing at the main repo
    const link = path.join(data, "worktrees", "evil");
    fs.symlinkSync(repo, link, linkType);
    reject(link);
    // data dir inside the repo would make the repo an ancestor: still refused for the repo itself
    expect(assertWorktreeTarget(a.path, ctx)).toBe(fs.realpathSync.native(a.path));
    await expect(guardedResetHard(repo, "HEAD", ctx)).rejects.toThrow(GuardError);
    await expect(guardedClean(repo, ctx)).rejects.toThrow(GuardError);
    await expect(guardedWorktreeRemove(repo, ctx)).rejects.toThrow(GuardError);
  });

  it("refuses a subdirectory of a worktree (must be its top level)", async () => {
    const { a, ctx } = await setup();
    fs.mkdirSync(path.join(a.path, "sub"));
    await expect(guardedClean(path.join(a.path, "sub"), ctx)).rejects.toThrow(/top level/);
  });

  it("checkpoint → edit → restore returns to the checkpoint; preserveOnClean is kept", async () => {
    const { a, data, ctx } = await setup();
    const hooks = path.join(data, "empty-hooks");
    fs.mkdirSync(path.join(a.path, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(a.path, ".gitignore"), "node_modules/\n");
    const cp = await checkpoint(a.path, "implement.a1b2", hooks);
    fs.writeFileSync(path.join(a.path, "math.js"), "broken");
    fs.writeFileSync(path.join(a.path, "new.txt"), "n");
    fs.writeFileSync(path.join(a.path, "node_modules", "dep.js"), "d");
    const removed = await restoreCheckpoint(a.path, cp, ctx, ["node_modules/"]);
    expect(removed).toContain("new.txt");
    expect(fs.readFileSync(path.join(a.path, "math.js"), "utf8")).toContain("add");
    expect(fs.existsSync(path.join(a.path, "new.txt"))).toBe(false);
    expect(fs.existsSync(path.join(a.path, "node_modules", "dep.js"))).toBe(true);
    const result = await commitStepResult(a.path, "implement.a1b2", hooks);
    expect(g(a.path, "log", "-1", "--format=%s", result).trim()).toBe("fractory: implement.a1b2 result");
  });
});

describe("content-aware snapshots (§8.13)", () => {
  it("parses porcelain -z including renames", () => {
    expect(parsePorcelainZ("R  new.js\0old.js\0 M a b.txt\0?? x\0")).toEqual([
      { xy: "R ", path: "new.js" },
      { xy: " M", path: "a b.txt" },
      { xy: "??", path: "x" },
    ]);
  });

  it("equal for identical rewrites, different for content changes of an already-dirty file", async () => {
    const repo = initRepo({ "a.txt": "one\n", ".gitignore": "dist/\n*.log\nbig.bin\n" });
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n"); // repo is already dirty: that's fine
    fs.writeFileSync(path.join(repo, "u.txt"), "untracked\n");
    fs.writeFileSync(path.join(repo, "x.log"), "ignored small\n");
    fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(4096, 1));
    fs.mkdirSync(path.join(repo, "dist"));
    fs.writeFileSync(path.join(repo, "dist", "out.js"), "built");
    const s1 = await takeSnapshot(repo, snap);
    expect(Object.keys(s1.entries)).toEqual(expect.arrayContaining(["a.txt", "u.txt", "x.log", "big.bin", "dist/"]));
    expect(s1.entries["big.bin"]).toMatch(/^!! size:4096:mtime:/);
    expect(s1.entries["dist/"]).toBe("!! dir");

    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n"); // content-identical rewrite
    expect(diffSnapshots(s1, await takeSnapshot(repo, snap))).toEqual([]);

    fs.writeFileSync(path.join(repo, "a.txt"), "dirtier\n");
    fs.writeFileSync(path.join(repo, "x.log"), "ignored changed\n");
    fs.writeFileSync(path.join(repo, "dist", "out.js"), "rebuilt"); // documented blind spot
    const changes = diffSnapshots(s1, await takeSnapshot(repo, snap));
    expect(changes.map((c) => c.path)).toEqual(["a.txt", "x.log"]);
  });

  it("hashes files inside ignored, non-excluded directories", async () => {
    const repo = initRepo({ "a.txt": "a\n", ".gitignore": "cache/\n" });
    fs.mkdirSync(path.join(repo, "cache", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "cache", "deep", "f"), "1");
    const s1 = await takeSnapshot(repo, snap);
    expect(Object.keys(s1.entries)).toContain("cache/deep/f");
    fs.writeFileSync(path.join(repo, "cache", "deep", "f"), "2");
    expect(diffSnapshots(s1, await takeSnapshot(repo, snap)).map((c) => c.path)).toEqual(["cache/deep/f"]);
  });

  it("records links that escape the tree", async () => {
    const { a, b } = await setup();
    fs.symlinkSync(b.path, path.join(a.path, "peek"), linkType);
    const s = await takeSnapshot(a.path, snap);
    expect(escapingLinks(s)).toEqual([expect.objectContaining({ path: "peek", outside: true })]);
  });
  // Windows junctions are never recorded as mode-120000 entries, so there is no tracked link to detect there.
  it.skipIf(process.platform === "win32")("detects a symlink committed after the inventory cache was used", async () => {
    const { a, b, data } = await setup();
    const cache = new SnapshotCache();
    const first = await takeSnapshot(a.path, snap, cache);
    expect(first.links).toEqual([]);
    fs.symlinkSync(b.path, path.join(a.path, "peek"), linkType);
    await commitAll(a.path, { emptyHooksDir: path.join(data, "empty-hooks"), message: "link" });
    const s = await takeSnapshot(a.path, snap, cache);
    expect(escapingLinks(s)).toEqual([expect.objectContaining({ path: "peek", outside: true })]);
    // cached path, retargeted link: the target is re-resolved from the filesystem
    fs.rmSync(path.join(a.path, "peek"), { recursive: true, force: true });
    fs.symlinkSync(a.path, path.join(a.path, "peek"), linkType);
    expect(escapingLinks(await takeSnapshot(a.path, snap, cache))).toEqual([]);
  });
});

describe("step gates (§8.2, §8.4, §8.14, §8.19)", () => {
  it("main repo change → attention; other worktree → violation; own worktree in edit → allowed", async () => {
    const { repo, a, b } = await setup();
    const targets = { mainRepo: repo, worktrees: { a1b2: a.path, c3d4: b.path } };
    const before = await takeBaseline(targets, snap);
    expect(escapingLinksByLabel(before)).toEqual({});
    fs.writeFileSync(path.join(repo, "user-edit.txt"), "user is working");
    fs.writeFileSync(path.join(a.path, "math.js"), "edited by a");
    fs.writeFileSync(path.join(b.path, "leak.txt"), "a wrote into b");
    const v = await evaluateGates(before, targets, snap, { writableLabel: "a1b2" });
    expect(v.attention.map((c) => c.path)).toEqual(["user-edit.txt"]);
    expect(v.allowed.map((c) => c.path)).toEqual(["math.js"]);
    expect(Object.keys(v.violations)).toEqual(["c3d4"]);
    expect(gatesPassed(v)).toBe(false);

    // read-only step: any worktree change is a violation
    const ro = await evaluateGates(await takeBaseline(targets, snap), targets, snap, {});
    expect(gatesPassed(ro)).toBe(true);
  });

  it("inputs/ changes fail the step", async () => {
    const { repo, a } = await setup();
    const inputs = tmpDir();
    fs.writeFileSync(path.join(inputs, "brief.md"), "brief");
    const targets = { mainRepo: repo, worktrees: { a1b2: a.path } };
    const before = await takeBaseline(targets, snap, inputs);
    fs.writeFileSync(path.join(inputs, "brief.md"), "tampered");
    fs.writeFileSync(path.join(inputs, "extra.md"), "added");
    const v = await evaluateGates(before, targets, snap, { writableLabel: "a1b2" }, inputs);
    expect(v.inputsChanged.map((c) => c.path)).toEqual(["brief.md", "extra.md"]);
    expect(gatesPassed(v)).toBe(false);
    expect(Object.keys(hashInputs(inputs))).toEqual(["brief.md", "extra.md"]);
  });
});

describe("squashed diffs", () => {
  it("CRLF rewrites do not produce whole-file diffs; checkpoints are squashed", async () => {
    const { a, base, data } = await setup();
    const hooks = path.join(data, "empty-hooks");
    await checkpoint(a.path, "implement.a1b2", hooks);
    // rewrite with CRLF endings plus one real change
    fs.writeFileSync(path.join(a.path, "math.js"), "export const add = (a, b) => a + b;\r\nexport const sub = (a, b) => a - b;\r\n");
    await commitStepResult(a.path, "implement.a1b2", hooks);
    fs.writeFileSync(path.join(a.path, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
    await commitStepResult(a.path, "fix_1.a1b2", hooks);
    const diff = await squashedDiff(a.path, base);
    expect(diff).toContain("+export const sub");
    expect(diff).not.toContain("-export const add");
    expect(diff).toMatch(/Binary files .*bin\.dat differ/);
    expect(diff).not.toContain("checkpoint");
  });
});
