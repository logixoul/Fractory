import { planMarkerIds } from "@fractory/shared/plan";
import { checkRefs } from "./refs.js";

export interface PlanCheckInput {
  text: string;
  adoptedIds: string[];
  /** Ids that exist but are not decisions (dropped by the swapped-order pass). */
  droppedIds: string[];
  metaPatterns: string[];
  /** A checkout of the base commit, and extra roots for absolute paths. */
  root: string;
  roots: string[];
}

/** Machine-checkable problems of a plan.md; empty = passes. */
export function checkPlan(i: PlanCheckInput): string[] {
  const problems: string[] = [];
  const found = new Set(planMarkerIds(i.text));
  const missing = i.adoptedIds.filter((id) => !found.has(id));
  if (missing.length) problems.push(`no <!-- d:<id> --> marker for decision(s): ${missing.join(", ")}`);
  const dropped = new Set(i.droppedIds);
  const adopted = new Set(i.adoptedIds);
  const unknown = [...found].filter((id) => !adopted.has(id));
  if (unknown.length) {
    problems.push(`markers referencing ${unknown.map((id) => `${id} (${dropped.has(id) ? "a dropped decision" : "no such decision"})`).join(", ")}`);
  }
  const lines = i.text.split("\n");
  const meta: string[] = [];
  for (const p of i.metaPatterns) {
    const re = new RegExp(`\\b(?:${p})\\b`, "i");
    const at = lines.findIndex((l) => re.test(l));
    if (at >= 0) meta.push(`"${re.exec(lines[at]!)![0]}" (line ${at + 1})`);
  }
  if (meta.length) problems.push(`meta-language the reader cannot understand: ${meta.join(", ")}; rewrite without referring to proposals, sides, critiques, rounds or a judge`);
  const refs = checkRefs(i.text, i.root, i.roots);
  if (refs.invalid.length) problems.push(`path:line references that do not exist at the base commit: ${refs.invalid.slice(0, 20).map((r) => r.raw).join(", ")}`);
  return problems;
}
