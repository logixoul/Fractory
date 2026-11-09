import type { RunState } from "./types.js";
import { vscodeHref, type RefHit } from "./refs.js";

/**
 * Where a document's path:line refs point: the commit the text was written against (the base
 * commit, or a contestant's head commit in a duel) and the worktree holding that version.
 */
export interface RefContext {
  runId: string;
  /** Commit sha, or "base". The daemon only serves commits recorded in the run. */
  rev: string;
  /** Human description of `rev`, e.g. "base commit" or "opus (a1b2) head at judging". */
  revTitle: string;
  repo: string;
  /** Roots that absolute paths in the text may start with (worktrees, repo). */
  roots: string[];
  /** Worktree checked out at (or descended from) `rev`, if it still exists. */
  worktree?: { path: string; label: string; atRev: boolean };
}

export interface ViewRequest extends RefHit {
  path: string;
  ctx: RefContext;
  vscode: { href: string; label: string; note?: string };
}


/** "Open in VS Code" target: the worktree when it still exists, else the main repo (with a note). */
export function vscodeTarget(ctx: RefContext, rel: string, line: number): ViewRequest["vscode"] {
  if (ctx.worktree) {
    return {
      href: vscodeHref(ctx.worktree.path, rel, line),
      label: `Open in VS Code: ${ctx.worktree.label} worktree`,
      ...(ctx.worktree.atRev ? {} : { note: "The worktree has moved on since this commit; its file may differ from the one shown." }),
    };
  }
  return {
    href: vscodeHref(ctx.repo, rel, line),
    label: "Open in VS Code: main repository",
    note: "The worktree was removed; your repository's current file may differ from the commit shown.",
  };
}

interface SetupLike {
  base: string;
  worktrees: Record<string, string>;
  judgeLabel: string;
}

const setupOf = (st: RunState): SetupLike | undefined =>
  st.steps.setup?.status === "completed" ? (st.steps.setup.result as SetupLike) : undefined;

/**
 * Ref context for a document of a run. `label` = the contestant whose text it is (its worktree
 * is opened in VS Code); `rev` defaults to the base commit.
 */
export function refContext(st: RunState, o: { label?: string; rev?: string; revTitle?: string } = {}): RefContext {
  const setup = setupOf(st);
  const roots = [...Object.values(setup?.worktrees ?? {}), st.repo];
  const label = o.label ?? setup?.judgeLabel;
  const wtPath = label ? setup?.worktrees[label] : undefined;
  const rev = o.rev ?? "base";
  const ctx: RefContext = { runId: st.runId, rev, revTitle: o.revTitle ?? "base commit", repo: st.repo, roots };
  if (wtPath && !st.cleaned && label) {
    const who = st.labels[label] ? `${st.labels[label]} (${label})` : `judge (${label})`;
    // Consensus worktrees never move off the base; duel worktrees may get later commits.
    const atRev = st.workflow === "consensus" || (rev !== "base" && rev === latestHead(st, label));
    ctx.worktree = { path: wtPath, label: who, atRev };
  }
  return ctx;
}

/** Most recent commit recorded for a contestant's worktree (implement/fix/apply/refix results). */
export function latestHead(st: RunState, label: string): string | undefined {
  let head: string | undefined;
  for (const id of st.stepOrder) {
    const s = st.steps[id];
    if (s?.status !== "completed" || s.label !== label) continue;
    const h = (s.result as { head?: unknown } | undefined)?.head;
    if (typeof h === "string") head = h;
  }
  return head;
}
