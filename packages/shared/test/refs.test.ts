import { describe, expect, it } from "vitest";
import { evidenceMarkdown, findRefs, parseRefHref, refHref, sideMentioned, type ResolvedRef } from "../src/refs.js";

describe("shared refs", () => {
  it("finds POSIX and Windows refs, ranges and #L anchors", () => {
    expect(findRefs(String.raw`a src/x.ts:3-5 b C:\r\y.ts:9 c /home/u/z.ts:1 d w.md#L4-L6`).map((r) => [r.path, r.line, r.endLine])).toEqual([
      ["src/x.ts", 3, 5],
      [String.raw`C:\r\y.ts`, 9, undefined],
      ["/home/u/z.ts", 1, undefined],
      ["w.md", 4, 6],
    ]);
  });

  it("keeps route-syntax segments ([param], [...rest], [[optional]], [p=matcher], (group), +page) on POSIX and Windows separators", () => {
    const paths = [
      "src/routes/admin/students/[uid]/+page.svelte",
      "src/routes/docs/[...rest]/+page.ts",
      "src/routes/(app)/settings/+layout.svelte",
      "src/routes/[[lang]]/about/+page.svelte",
      "src/routes/items/[page=integer]/+page.server.ts",
      "app/(marketing)/(.)photo/[id]/page.tsx",
    ];
    for (const p of paths) {
      for (const written of [p, p.replace(/\//g, "\\"), `C:\\repo\\${p.replace(/\//g, "\\")}`, `/home/u/repo/${p}`]) {
        expect(findRefs(`see ${written}:1351-1353 now`).map((r) => [r.path, r.line, r.endLine])).toEqual([[written, 1351, 1353]]);
        expect(findRefs(`(${written}:7)`).map((r) => r.path)).toEqual([written]);
      }
    }
  });

  it("unbalanced brackets and markdown link syntax never join a path", () => {
    expect(findRefs("(src/a.ts:42)").map((r) => r.raw)).toEqual(["src/a.ts:42"]);
    expect(findRefs("[text](src/a.ts:42)").map((r) => r.raw)).toEqual(["src/a.ts:42"]);
    expect(findRefs("[src/a.ts:42](src/b.ts:1)").map((r) => r.raw)).toEqual(["src/a.ts:42", "src/b.ts:1"]);
    expect(findRefs("see [a.ts:3] and (b.ts:4), c.ts:5.").map((r) => r.raw)).toEqual(["a.ts:3", "b.ts:4", "c.ts:5"]);
    expect(findRefs("src/[uid/+page.svelte:3").map((r) => r.path)).toEqual(["uid/+page.svelte"]); // unclosed: not a segment
  });

  it("in-app links and evidence markdown survive brackets and parentheses in paths", () => {
    const sha = "b".repeat(40);
    const p = "src/routes/(app)/students/[uid]/+page.svelte";
    const r: ResolvedRef = { raw: `${p}:3`, path: p, line: 3, side: "A", label: "a1b2", sha, ambiguous: false, chosenBy: "evidence", resolvedIn: ["A"] };
    const href = refHref(r);
    expect(href).toBe(`#ref/a1b2/${sha}/3-3/src/routes/%28app%29/students/%5Buid%5D/%2Bpage.svelte`);
    expect(parseRefHref(href)?.path).toBe(p);
    expect(evidenceMarkdown([r.raw], [r], { a1b2: "gpt" })).toBe(`[src/routes/(app)/students/\\[uid\\]/+page.svelte:3](${href}) (A, gpt @ bbbbbbb)`);
  });

  it("detects which side a text attributes something to", () => {
    expect(sideMentioned("B: math.js:3")).toBe("B");
    expect(sideMentioned("see side A for the guard")).toBe("A");
    expect(sideMentioned("B's version is cleaner")).toBe("B");
    expect(sideMentioned("math.js:3 (A)")).toBe("A");
    expect(sideMentioned("taken from B")).toBe("B");
    expect(sideMentioned("A guard against zero is needed")).toBeUndefined(); // article, not a side
    expect(sideMentioned("side A and side B both")).toBeUndefined(); // both named: no attribution
    expect(sideMentioned("math.js:3")).toBeUndefined();
  });

  it("round-trips in-app ref links and renders evidence with its own side and commit", () => {
    const sha = "a".repeat(40);
    const r: ResolvedRef = { raw: "src/a b.ts:3-4", path: "src/a b.ts", line: 3, endLine: 4, side: "B", label: "c3d4", sha, ambiguous: true, chosenBy: "evidence", resolvedIn: ["A", "B"] };
    const href = refHref(r);
    expect(href).toBe(`#ref/c3d4/${sha}/3-4/src/a%20b.ts`);
    expect(parseRefHref(href)).toEqual({ label: "c3d4", sha, line: 3, endLine: 4, path: "src/a b.ts" });
    expect(parseRefHref(`#ref/base/${sha}/7-7/x.ts`)).toEqual({ sha, line: 7, path: "x.ts" });
    expect(parseRefHref("#ref/x/nothex/1-1/a")).toBeUndefined();
    expect(evidenceMarkdown(["B: src/a b.ts:3-4", "nowhere.ts:1"], [r], { c3d4: "deepseek" })).toBe(
      `[src/a b.ts:3-4](${href}) (B, deepseek @ aaaaaaa, ambiguous), \`nowhere.ts:1\` (unresolved)`,
    );
  });
});
