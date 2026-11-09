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
