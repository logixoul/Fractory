import type { RunState } from "../state/reducer.js";
import type { RunStore } from "../store/run-store.js";
import { reviewOutcomes, reviewProgress, type FindingOutcome } from "../workflows/review.js";

/**
 * Per-reviewer statistics over completed review runs (`fractory stats`). Everything is derived
 * from recorded step results; nothing is estimated.
 */
export interface ReviewerStats {
  /** Worker id of the reviewer, plus its model as configured in those runs. */
  reviewer: string;
  models: string[];
  runs: number;
  findings: number;
  findingsPerRun: number;
  /** Findings dropped because no reference resolved (not counted in `findings`). */
  dropped: number;
  bySeverity: Record<string, number>;
  tested: number;
  confirmed: number;
  refuted: number;
  testErrors: number;
  /** Confirmed bug-severity findings / bug-severity findings. */
  confirmedBugRate: number | null;
  /** Refuted / tested. */
  refutedRate: number | null;
  /** Implementer's last answer. */
  accepted: number;
  rejected: number;
  /** Reviewer's verdict after the last round. */
  withdrawn: number;
  maintained: number;
  /** The user's decision on maintained disagreements. */
  applied: number;
  dismissed: number;
}

const rate = (n: number, d: number) => (d === 0 ? null : n / d);

/** Outcomes of one completed review run, or undefined for any other run. */
export function runReviewOutcomes(st: RunState): FindingOutcome[] | undefined {
  if (st.workflow !== "review" || st.status !== "completed") return undefined;
  return reviewOutcomes(reviewProgress(st));
}

export function reviewerStats(states: readonly RunState[]): ReviewerStats[] {
  const by = new Map<string, { models: Set<string>; runs: number; outcomes: FindingOutcome[] }>();
  for (const st of states) {
    const outcomes = runReviewOutcomes(st);
    if (!outcomes || !st.roles.reviewer) continue;
    const id = st.roles.reviewer;
    const e = by.get(id) ?? { models: new Set<string>(), runs: 0, outcomes: [] };
    const w = (st.config as { workers?: Record<string, { kind?: string; provider?: string; model?: string }> }).workers?.[id];
    if (w?.model) e.models.add(w.provider ? `${w.provider}/${w.model}` : w.model);
    e.runs++;
    e.outcomes.push(...outcomes);
    by.set(id, e);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reviewer, e]) => {
      const all = e.outcomes.filter((o) => o.final !== "dropped");
      const count = (f: (o: FindingOutcome) => boolean) => all.filter(f).length;
      const tested = count((o) => o.test !== "none");
      const refuted = count((o) => o.test === "refuted");
      const bugs = count((o) => o.severity === "bug");
      const bySeverity: Record<string, number> = {};
      for (const o of all) bySeverity[o.severity] = (bySeverity[o.severity] ?? 0) + 1;
      return {
        reviewer,
        models: [...e.models].sort(),
        runs: e.runs,
        findings: all.length,
        findingsPerRun: all.length / e.runs,
        dropped: e.outcomes.length - all.length,
        bySeverity,
        tested,
        confirmed: count((o) => o.test === "confirmed"),
        refuted,
        testErrors: count((o) => o.test === "error"),
        confirmedBugRate: rate(count((o) => o.severity === "bug" && o.test === "confirmed"), bugs),
        refutedRate: rate(refuted, tested),
        accepted: count((o) => o.action === "fixed"),
        rejected: count((o) => o.action === "rejected"),
        withdrawn: count((o) => o.final === "withdrawn"),
        maintained: count((o) => o.final === "maintained"),
        applied: count((o) => o.decision === "apply"),
        dismissed: count((o) => o.decision === "dismiss"),
      } satisfies ReviewerStats;
    });
}

export function storeReviewerStats(store: RunStore): ReviewerStats[] {
  return reviewerStats(store.list().flatMap((r) => (r.state ? [r.state] : [])));
}
