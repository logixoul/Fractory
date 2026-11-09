import { describe, expect, it } from "vitest";
import { planMarkerIds, planSections } from "../src/plan.js";

describe("plan markers", () => {
  it("collects markers per heading section and ignores fenced code", () => {
    const md = ["intro", "# A", "x <!-- d:d1 -->", "```", "<!-- d:d7 -->", "```", "## B", "<!-- d:d2 -->", "<!--d:d2-->", "## C", "none"].join("\n");
    expect(planSections(md).map((s) => s.ids)).toEqual([[], ["d1"], ["d2"], []]);
    expect(planMarkerIds(md)).toEqual(["d1", "d2"]);
  });
});
