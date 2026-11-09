# Architecture

For engineers changing fractory. The rules that must hold are in [CLAUDE.md](CLAUDE.md). The verified vendor interfaces and the binding requirements (cited below as §8.x) are in [docs/interfaces.md](docs/interfaces.md). Reviewed judgment calls are in [docs/decisions-todo.md](docs/decisions-todo.md).

## Packages

```
packages/shared   Node-free: event schemas (zod), run-state types, path:line refs
packages/core     library: run store, reducer, engine, workers, git, checks, workflows
packages/cli      `fractory` (commander); drives core in-process
packages/daemon   Hono on 127.0.0.1: HTTP commands + SSE; drives core in-process
packages/web      Svelte 5 + Vite SPA; a pure view over the daemon API
```

Dependencies point one way: `shared ← core ← cli, daemon`, and `shared ← web`. `web` never imports core and never owns a process or state. The CLI works without the daemon. The daemon is just another driver of the same runs.

## A run on disk

`<dataDir>/runs/<runId>/`:

- `events.jsonl`: **the source of truth.** Append-only. Every event is redacted, schema-validated and fsynced before it counts, and carries a gap-free `seq`.
- `state.json`: derived by the pure `reduceInto` reducer (`core/src/state/reducer.ts`). It's always rebuildable from the log.
- `prompt.md`: the task, snapshotted at creation. `run_created` also records the full resolved config, the random neutral labels (label → worker exists only here, §8.16) and the A/B seed. A resume never re-reads config files.
- `steps/<stepId>/`: `inputs/` (files the agent may read, hashed before and after, §8.19), `out/` (results, structured output), `artifacts/` (copies of check outputs), raw vendor streams (redacted) and logs.
- `driver.lock`: the single-writer lock. A stale lock from a dead process is taken over. `cancel.request` is how another process asks the driver to stop.

Worktrees live outside your repo, in `<dataDir>/worktrees/<runId>/<label>`, on branches `fractory/<runId>/<label>`.

## The engine

`core/src/engine/drive.ts` drives a `WorkflowDef`: a pure function `next(state)` that returns either the next **stage** (steps that run in parallel, or one approval gate) or **done**. Control flow therefore depends only on recorded state, never on model text, except through schema-validated step results.

- **Steps.** A step runs, its result is JSON-normalized, and its `exitCheck` (machine-checkable) decides between `step_completed` and `step_failed`.
- **Failures.** A hard failure aborts its siblings. A quota hit lets siblings finish (their work is kept) and pauses the run. Pi retries provider rate limits and 5xx itself first (logged as `provider_retry`). After that, transient errors (5xx, network, a provider 429 for Pi) are retried as a whole step, from the step's checkpoint: a Retry-After in the error is honoured, rate limits back off from 60 s, and other errors from 5 s.
- **Resume.** A crashed step (started, never finished) is marked abandoned and rerun. Completed steps are never rerun. `--retry-failed` reopens a failed run at its failed step.
- **Pauses.** `paused_quota` (with the reset time; resume is refused earlier unless forced), `awaiting_approval`, and `needs_attention` (the main repo changed during a step; the step's result stands).
- **Worker calls.** `worker-task.ts` streams a worker's normalized events into the log (text deltas merged), records usage, and computes cost from the price table. Claude is subscription-billed, so its vendor cost is shown as API-equivalent only. It also records quota observations and maps worker errors to engine errors.
- **Structured output.** `structured.ts`: Claude gets `--json-schema`; other workers write `out/<name>.json`, whose schema is in the prompt. Both are validated by the same zod schema, with exactly one repair turn.
- **Gates.** `gated.ts` wraps every worker step. It takes content-hashed `git status --porcelain --ignored` snapshots of the main repo and every run worktree before and after, plus the `inputs/` hash:
  - a main-repo change → `needs_attention`;
  - a change in any worktree the step may not touch → a guarded restore and a hard failure;
  - a change in `inputs/` → a hard failure.

## Workers

`Worker.run(task)` returns an async iterable of normalized `WorkerEvent`s (`shared/src/worker-events.ts`) that ends in exactly one `done` or `error`.

- **ClaudeWorker** (`claude -p --output-format stream-json`):
  - prompt on stdin; `--setting-sources ""` and `--strict-mcp-config` for isolation;
  - read-only tools, or file tools in edit mode; never a shell;
  - must report `apiKeySource: "none"`.
- **PiWorker** (`pi --mode json`):
  - prompt on stdin; isolated agent dir (Pi's own retries for rate limits and 5xx are on and bounded); no context files, skills or extensions;
  - always loads the **path guard** (`core/assets/pi-path-guard.ts`), a fail-closed allowlist: its own worktree, its own `inputs/` and out file. The adapter refuses a result unless the guard acknowledged loading with a per-call nonce.
- **FakeWorker**: scripted and deterministic. Every automated test uses it.

Processes are spawned with argv arrays (`cross-spawn`), and whole process trees are killed on timeout or cancel (`tree-kill`) (`core/src/util/proc.ts`).

## Git

- `git/git.ts`: every call runs with long paths and optional locks off. Orchestrator commits are hook- and signing-free and authored by `fractory` (§8.17).
- `git/guard.ts`: the **only** route to `reset --hard`, `clean -fdx` and `worktree remove`. It asserts that the realpath is strictly inside `<dataDir>/worktrees/`, isn't the main repo or one of its ancestors, and is a worktree's top level (§8.3).
- `git/snapshot.ts` and `git/gates.ts`: content-aware snapshots (§8.13) and the per-step gates.
- `checks/runner.ts`: `setup` failures are environment errors. Checks run, their outputs are copied as artifacts, and the worktree is restored to the post-step commit and verified against its snapshot (§8.18).

## Workflows

**Consensus** (`core/src/workflows/consensus.ts`), all read-only:

`setup` → `propose.<l>` ∥ → `critique.<l>` ∥ → `revise.r<n>.<l>` ∥ (≤ `maxRounds`, early stop when both report no changes) → `judge`.

- Each contestant works in its own worktree at the base commit and keeps one session throughout.
- Project context is injected from the base commit, identically for both.
- Proposals need ≥ `minRefs` valid `path:line` refs (one repair turn).
- The judge sees anonymized prose: worker and model names scrubbed, paths made repo-relative, leak-checked. Your task text is passed verbatim. The A/B order comes from the run's seed.
- `decision.md` is rendered by the orchestrator from the validated verdict.

**Duel** (`core/src/workflows/duel.ts`):

`setup` → per contestant `implement` → `check.0` → [`fix.i` → `check.i`] (≤ `maxFixIterations`) → `judge` → `approve` (gate) → `apply` → `recheck.0` → [`refix.i` → `recheck.i`] → `report`.

- Every edit step is checkpointed (a commit at its start); retries restore that checkpoint.
- An implementation without changes forfeits. With one forfeit there's no judge, and the other branch is the result; if both forfeit, the run fails.
- The judge sees squashed `base..HEAD` diffs verbatim, check results, and your task.
- Each evidence entry declares its side (`A`, `B` or `base`). The orchestrator checks that the ref exists there, at A's head, B's head or the base; a mismatch gets one repair turn. Links, the file view and `report.md` use exactly that side and commit.
- `judge.swapOrderPass` (on by default) re-rates every point with A/B swapped and keeps only agreeing points. If none survive, it records `no_robust_preferences` and continues.

## Daemon and GUI

`packages/daemon/src/security.ts`:

- listens only on 127.0.0.1;
- Host and Origin allowlists; cross-site fetches refused; no CORS; strict CSP;
- a per-launch token as a bearer header or HttpOnly SameSite=Strict cookie, obtained by exchanging a single-use 60 s code (`/auth`). The token never appears in a URL.

The API serves run state, an SSE stream of the event log (it replays from `Last-Event-ID`, then tails by byte offset), and run files (always `text/plain`, confined to the run dir). It also serves duel diffs, and file contents at commits recorded in the run. Commands: start, approve, resume, cancel, clean, gc.

The GUI rebuilds everything from that API, so a page refresh loses nothing. Model output is rendered as markdown sanitized by DOMPurify. Monaco is loaded lazily for diffs and the in-app file view.

## Testing

- `npm test`: vitest, FakeWorker only, real git in temp repos. Covers the engine (crash resume, quota, cancel, approval, retries), the adapters (recorded vendor streams and a fake CLI), git safety (guard, hooks, snapshots), both workflows end to end, CLI and daemon security, and the GUI's pure logic.
- `npm run e2e`: one Playwright test of the built GUI against a fake duel.
- `npm run smoke`: opt-in, real models, run by hand.

## Where to start reading

| Topic | File |
|---|---|
| Event types | `packages/shared/src/run-events.ts` |
| State derivation | `packages/core/src/state/reducer.ts` |
| Drive loop | `packages/core/src/engine/drive.ts` |
| A workflow | `packages/core/src/workflows/duel.ts` |
| Destructive git | `packages/core/src/git/guard.ts` |
| Daemon security | `packages/daemon/src/security.ts` |
