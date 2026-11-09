import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANONYMIZE_PATTERNS } from "../src/schemas/config.js";
import { buildScrubber, leakCheck, relativizePaths, scrubProse } from "../src/text/anonymize.js";
import { checkRefs, extractRefs } from "../src/text/refs.js";
import { tmpDir } from "./helpers.js";

function repo() {
  const root = fs.realpathSync.native(tmpDir());
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "1\n2\n3\n");
  fs.writeFileSync(path.join(root, "Makefile"), "all:\n");
  return root;
}

describe("path:line refs", () => {
  it("extracts the supported forms and ignores times and URLs", () => {
    const t = "see src/a.ts:2, `src\\a.ts:1-3`, [x](src/a.ts#L3), at 12:30, https://x.io/a.js:4 and a.ts:9.";
    expect(extractRefs(t).map((r) => r.raw)).toEqual(["src/a.ts:2", "src\\a.ts:1-3", "src/a.ts#L3", "a.ts:9"]);
  });

  it("validates existence and line ranges, maps absolute paths through roots", () => {
    const root = repo();
    const other = fs.realpathSync.native(tmpDir());
    const abs = path.join(root, "src", "a.ts");
    const r = checkRefs(`src/a.ts:2 src/a.ts:4 src/a.ts:2-3 ${abs}:1 src/missing.ts:1 ../x/a.ts:1 ${path.join(other, "a.ts")}:1 src/a.ts:2`, root);
    expect(r.valid.map((x) => `${x.path}:${x.line}`)).toEqual(["src/a.ts:2", "src/a.ts:1"]);
    expect(r.invalid.map((x) => x.raw)).toHaveLength(4);
  });
});

describe("path:line refs in route-style paths", () => {
  it("validates SvelteKit/Next.js paths, POSIX and Windows separators, relative and absolute", () => {
    const root = fs.realpathSync.native(tmpDir());
    const files = [
      "src/routes/admin/students/[uid]/+page.svelte",
      "src/routes/docs/[...rest]/+page.ts",
      "src/routes/(app)/settings/+layout.svelte",
      "src/routes/[[lang]]/+page.svelte",
    ];
    for (const f of files) {
      fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), Array.from({ length: 1400 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    }
    const text = files
      .flatMap((f) => [`${f}:1351-1353`, `${f.replace(/\//g, "\\")}:2`, `${path.join(root, ...f.split("/"))}:3`])
      .join(" and ");
    const r = checkRefs(text, root);
    expect(r.invalid).toEqual([]);
    expect(r.valid.map((x) => `${x.path}:${x.line}`)).toEqual(files.flatMap((f) => [`${f}:1351`, `${f}:2`, `${f}:3`]));
    // the reported bug: the path was cut to "/+page.svelte" and flagged invalid
    expect(checkRefs("src/routes/admin/students/[uid]/+page.svelte:1351-1353", root).valid[0]).toMatchObject({ path: "src/routes/admin/students/[uid]/+page.svelte", line: 1351, endLine: 1353 });
  });
});

describe("anonymization (§8.16)", () => {
  const s = buildScrubber(DEFAULT_ANONYMIZE_PATTERNS, ["claude-opus-5", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "opus"], "[agent]");

  it("scrubs self-references and model ids in prose; leaves π and 'together' alone", () => {
    const out = scrubProse("As Claude (claude-opus-5) I think DeepSeek's deepseek-ai/DeepSeek-V4.1-Flash-1017 plan works; Opus agrees. Pi ≈ 3.14, together.", s);
    expect(out.text).toBe("As [agent] ([agent]) I think [agent]'s [agent] plan works; [agent] agrees. Pi ≈ 3.14, together.");
    expect(out.replacements).toBe(5);
    expect(leakCheck(out.text, s)).toEqual([]);
    expect(leakCheck("from anthropic", s)).toHaveLength(1);
  });

  it("relativizes worktree paths and the leak check catches data-dir paths", () => {
    const wt = path.join("C:", "data", "worktrees", "r1", "a1b2");
    const text = `see ${wt}\\src\\a.ts:2 and ${wt.replace(/\\/g, "/")}/b.ts:1`;
    expect(relativizePaths(text, [wt])).toBe("see src\\a.ts:2 and b.ts:1");
    expect(leakCheck(`x ${wt}`, s, [path.join("C:", "data")])).toHaveLength(1);
  });
});
