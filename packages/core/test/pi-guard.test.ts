import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, decide, globEscapes, inside, parseGuardConfig } from "../assets/pi-path-guard.js";
import { tmpDir } from "./helpers.js";

/** worktrees/run1/{aaaa,bbbb} + steps/s1/{inputs,out} */
function layout() {
  const root = fs.realpathSync.native(tmpDir("fractory-guard-"));
  const own = path.join(root, "worktrees", "run1", "aaaa");
  const other = path.join(root, "worktrees", "run1", "bbbb");
  const inputs = path.join(root, "steps", "s1", "inputs");
  const out = path.join(root, "steps", "s1", "out", "result.json");
  for (const d of [own, other, inputs, path.dirname(out)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(own, "a.ts"), "x");
  fs.writeFileSync(path.join(other, "plan.md"), "secret plan");
  fs.writeFileSync(path.join(inputs, "brief.md"), "brief");
  const guard = parseGuardConfig(JSON.stringify({ read: [own, inputs], write: [out] }))!;
  return { root, own, other, inputs, out, guard };
}

const linkType = process.platform === "win32" ? "junction" : "dir";

describe("pi path guard", () => {
  it("allows own worktree and inputs, rewrites the path to the canonical one", () => {
    const { own, inputs, guard } = layout();
    expect(decide(guard, "read", { path: "a.ts" }, own)).toEqual({ allow: true, path: path.join(own, "a.ts") });
    expect(decide(guard, "read", { path: path.join(inputs, "brief.md") }, own)).toMatchObject({ allow: true });
    expect(decide(guard, "ls", {}, own)).toEqual({ allow: true, path: own });
  });

  it("blocks the sibling worktree by absolute path, traversal and ls ..", () => {
    const { own, other, guard } = layout();
    expect(decide(guard, "read", { path: path.join(other, "plan.md") }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "read", { path: "../bbbb/plan.md" }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "ls", { path: ".." }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "grep", { pattern: "secret", path: path.dirname(own) }, own)).toMatchObject({ allow: false });
  });

  it("blocks junction/symlink escapes via realpath", () => {
    const { own, other, guard } = layout();
    fs.symlinkSync(other, path.join(own, "link"), linkType);
    expect(decide(guard, "read", { path: "link/plan.md" }, own)).toMatchObject({ allow: false, reason: expect.stringContaining("outside allowlist") });
    expect(decide(guard, "ls", { path: "link" }, own)).toMatchObject({ allow: false });
  });

  it("write only where allowed: the out file, not the worktree in a read-only step", () => {
    const { own, out, guard } = layout();
    expect(decide(guard, "write", { path: out }, own)).toEqual({ allow: true, path: out });
    expect(decide(guard, "write", { path: "hacked.txt" }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "edit", { path: "a.ts" }, own)).toMatchObject({ allow: false });
    // reads of the out file are allowed (read ∪ write)
    expect(decide(guard, "read", { path: out }, own)).toMatchObject({ allow: true });
  });

  it("handles @ and ~ prefixes and unicode spaces like Pi does", () => {
    const { own, guard } = layout();
    expect(canonical("@a.ts", own)).toBe(path.join(own, "a.ts"));
    expect(canonical("~", own)).toBe(fs.realpathSync.native(os.homedir()));
    expect(decide(guard, "read", { path: "~/x" }, own)).toMatchObject({ allow: false });
    expect(canonical("a\u00A0b.ts", own)).toBe(path.join(own, "a b.ts"));
  });

  it("compares case-insensitively only on case-insensitive platforms", () => {
    expect(inside("C:\\A\\B\\c", "c:\\a\\b", true)).toBe(true);
    // path.relative itself ignores case on win32, so the case-sensitive branch is POSIX-only.
    if (process.platform !== "win32") expect(inside("/a/B/c", "/a/b", false)).toBe(false);
    expect(inside("/a/bc", "/a/b", false)).toBe(false);
  });

  it("rejects escaping grep globs and find patterns", () => {
    const { own, guard } = layout();
    for (const g of ["../**", "/etc/*", "C:/x/*", "~/x", "a/../../b"]) expect(globEscapes(g)).toBe(true);
    expect(globEscapes("src/**/*.ts")).toBe(false);
    expect(decide(guard, "grep", { pattern: "x", glob: "../**" }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "find", { pattern: "../../**" }, own)).toMatchObject({ allow: false });
    expect(decide(guard, "find", { pattern: "**/*.ts" }, own)).toMatchObject({ allow: true });
  });

  it("fails closed: no/invalid config and unknown tools are blocked", () => {
    const { own, guard } = layout();
    for (const raw of [undefined, "", "{}", '{"read":"x","write":[]}', '{"read":[""],"write":[]}', "not json"]) {
      expect(parseGuardConfig(raw)).toBeNull();
    }
    expect(decide(null, "read", { path: "a.ts" }, own)).toMatchObject({ allow: false, reason: expect.stringContaining("fail closed") });
    for (const t of ["bash", "powershell", "fetch"]) expect(decide(guard, t, { path: "a.ts" }, own)).toMatchObject({ allow: false });
  });
});
