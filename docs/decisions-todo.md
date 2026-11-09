# Decisions to review

Choices made while building fractory that you may want to confirm or change. Each milestone adds a section. Every entry gives the choice, the reason, and what changing it would affect. Tick an item (`[x]`) once you've confirmed it, or note the change you want.

Binding requirements you already set (docs/interfaces.md §8) are not repeated here. This file lists only the calls made on top of them.

**Status:** M0–M5 reviewed 2026-11-09. Everything there is confirmed except 11 items you changed. Those are marked *(changed in review)* and describe the new behaviour; all are implemented and tested. M6 is open for review.

---

## M0: spikes and interfaces

- [x] **Default Pi model id is the spec's `deepseek-ai/DeepSeek-V4.1-Flash-1017`.** Pi's catalog lists only `…-Flash`. The `-1017` id still works, but Pi warns on stderr that it's a "custom model id". Prices are configured for both ids.
- [x] **Pi reasoning: only `off` and `high` are effective for this model.** Pi clamps every other level to `high`. Config accepts all levels, but warns on anything other than `off`/`high`. The default is `high`.
- [x] **Claude effort is logged as requested only.** Claude Code never reports the effective effort, so `effectiveReasoning` is `null` for Claude steps. The default effort is `high`.
- [x] **Project-context parity: both harnesses load no project context.** Claude runs with `--setting-sources ""`; Pi runs with `--no-context-files` and an empty, isolated agent dir. The orchestrator injects the same text into both prompts: by default, the repo-root `AGENTS.md` and `CLAUDE.md` if present.
- [x] **Pi's internal retries are disabled**, so every retry is the orchestrator's decision. The orchestrator now retries transient errors itself, with backoff (see M1 *(changed in review)*).
- [x] **Quota detection** *(changed in review)*:
  - Signals: a `rate_limit_event.status` other than `allowed`/`allowed_warning`, or Claude `api_error_status` 429.
  - **Text matching** (`usage limit|rate limit|quota|429|…`) applies **only to a result with `is_error === true`**. Successful model output is never text-matched. Test: a successful result that discusses rate limiting doesn't pause.
  - A non-success subtype without `is_error` is a plain model error.
  - Nothing is ever retried automatically for quota.
- [x] **Prompts always go over stdin.**

## M1: core engine

- [x] **Workflows are pure `next(state)` functions.**
- [x] **Single writer per run** (`driver.lock`, stale-lock takeover, `cancel.request` polled every 500 ms).
- [x] **Crash recovery truncates a torn last line.** A corrupt middle line or a sequence gap refuses to load.
- [x] **Crash recovery is tested with constructed logs.**
- [x] **Retries** *(changed in review)*:
  - **Transient errors are retried automatically.** That means 5xx/overloaded, network errors (`ECONNRESET`, `fetch failed`, …) and **Together 429** (a provider rate limit for Pi). Claude 429 stays a Pro quota pause.
  - The step's checkpoint is restored first (edit steps) or its post-step commit (check steps). There are at most `retry.transientMaxRetries` = **2** retries, with backoff `retry.backoffMs` = 5 s then 30 s. Each retry is logged as `step_retrying`.
  - After that the run fails with kind `transient`.
  - **`fractory resume <id> --retry-failed`** (and a GUI button) reopens a failed run and reruns the failed step from its checkpoint; this works for any failure kind. A plain `resume` of a failed run is a no-op.
  - Quota and abandoned (crashed) steps rerun as before.
- [x] **A hard failure in a parallel stage aborts its siblings; a quota hit lets siblings finish.** Outcome order: cancelled > failed > quota > needs_attention. Transient retries happen inside the step, before its outcome counts.
- [x] **Resuming before the quota reset time is refused** unless `--force` is given.
- [x] **Approving zero items is allowed.**
- [x] **Streamed text is merged before it's logged** (4000 characters or 250 ms; `state.json` throttled to 250 ms).
- [x] **Default judge** *(changed in review)*:
  - It's **a third model family via Pi, `zai-org/GLM-5.3` on Together** (worker `glm`, thinking `high`), never a contestant.
  - Price from Together's pricing page and model page (checked 2026-11-09): input $1.40, output $4.40, cached input $0.26 per 1M tokens. The model is in Pi's Together catalog with thinking support.
  - **Caveat:** Together's model page also showed a "launching soon" banner. `npm run smoke` (or `-- --glm`) now makes one GLM call to confirm the endpoint is live.
  - Config warns if `roles.judge` is also a contestant.
  - Optional **`judge.swapOrderPass`** (default `false`): see M6.
- [x] **Cost comes from tokens × your price table.** A missing price component gives `null` plus a warning.
- [x] **Toolchain:** TypeScript 7.0.2, vitest 5, zod 4, `@types/node` 22.
- [x] **`.gitattributes` forces LF.**

## M2: adapters, git, checks

- [x] **Gates and checkpoints** are used on every step since M3/M4.
- [x] **Pi's path guard must prove it loaded** (nonce ack; verified with `npm run smoke`).
- [x] **Pi gets no secrets except the `.dev.vars` values and `passEnv`.** Claude has only `ANTHROPIC_*` and the envFile keys removed.
- [x] **Check and setup commands get no secret-looking env vars.**
- [x] **Claude permission denials are counted as `tool_blocked`.**
- [x] **Claude billing** *(changed in review)*:
  - Claude is **subscription-billed**: its usage is recorded with `billing: "subscription"` and `costUsd: 0`, with **no price warning**.
  - Its vendor `costUSD` is shown as **"API-equivalent"** (CLI `show`, GUI header) and is not counted as spend.
  - Usage is still recorded per model from `modelUsage`.
- [x] **Raw vendor streams are kept for debugging** (redacted, per step).
- [x] **Tool outputs in the event log are truncated** to 8000 characters.
- [x] **Snapshots use `git status --ignored=matching`** (blind spots documented; `--no-filters` hashing).
- [x] **All git calls disable optional locks** and force long paths / unquoted paths.
- [x] **Judge diffs use `--ignore-cr-at-eol` and `--find-renames`.**
- [x] **Re-creating a worktree is idempotent.**
- [x] **Check artifacts are copied into `artifacts/<check-name>/`.**
- [x] **Config: only `argv[0]` must be non-empty.**
- [x] **The smoke script runs on the built `dist/`.** It now covers Claude (`haiku`), DeepSeek and the GLM judge.

## M3: consensus workflow and CLI

- [x] **Each contestant reads its own worktree**; the judge gets a third.
- [x] **Cleaning up worktrees** *(changed in review)*:
  - **`fractory clean <run>`** removes a *finished* run's worktree directories through the guarded `worktree remove` (§8.3) and keeps the branches. It refuses unfinished runs and is idempotent.
  - **`fractory gc --older-than <days>`** does the same for every finished, not yet cleaned run whose last update is older than N days.
  - Also available in the API (`POST /api/runs/:id/clean`, `POST /api/gc`) and the GUI ("Remove worktrees" on a run, "Clean up" on the runs list).
- [x] **The base is the repo's HEAD commit, not its working tree** *(changed in review)*. When the main repo has uncommitted changes at run start, the run records a **`dirty_repo` warning** (CLI prints it, GUI shows it) and continues.
- [x] **No per-repo `setup` for consensus.**
- [x] **Each contestant keeps one session across all its steps.**
- [x] **Too few valid `path:line` refs get one repair turn.**
- [x] **What counts as a valid ref.**
- [x] **Revision rounds after the first** use the round-1 critique plus the other's current proposal.
- [x] **Revisions return the full proposal inside the structured JSON.**
- [x] **What the judge sees** *(changed in review)*:
  - The task, both current proposals and both critiques; A/B order from the run's seed.
  - **Your task text is exempt from scrub and leak check**: it's passed verbatim.
  - Proposals and critiques are still scrubbed and leak-checked.
- [x] **Model ids and worker ids are added to the scrub list automatically.**
- [x] **The leak check also forbids data-dir and worktree paths** in judge prose.
- [x] **Every judge decision needs at least one valid evidence ref.**
- [x] **`decision.md` is rendered by the orchestrator.**
- [x] **Structured output for non-Claude workers goes through `out/<name>.json`.**
- [x] **Pi `passEnv`** (default `["TOGETHER_API_KEY"]`).
- [x] **Relative `envFile` paths** *(changed in review)* resolve against **the directory of the config file that declares them** (global or per-repo); an override resolves against the working directory. The recorded run config stores the absolute path, never the values (tested).
- [x] **A resumed run uses its recorded config.**
- [x] **The CLI drives runs in-process** (exit codes 0/1/2/64).
- [x] **`approve` records; `resume` continues.**
- [x] **Parallel steps that see the same main-repo change report it once.**
- [x] **vitest's per-test timeout is 60 s.**

## M4: duel workflow, approve and resume

- [x] **Limitation: in the parallel implement/fix stages, a write into the other worktree can't be told apart from that contestant's own edits.** Isolation there relies on harness confinement.
- [x] **Each contestant's chain moves at its own pace.**
- [x] **A contestant whose checks still fail after the last fix goes to the judge.**
- [x] **Forfeit** *(changed in review)*:
  - An implementation with no changes means **that contestant forfeits**: no checks, and **no judge**, approval or apply.
  - The report and the run result name **the other branch as the result** (`result.winner`).
  - Only if **both** forfeit does the run fail (`exit_check` at step `outcome`).
- [x] **What the judge sees in a duel** *(changed in review)*:
  - Your **task text verbatim**, both squashed diffs verbatim, and both final check results.
  - New: a **warning-only scan of the diffs for worker identity tokens** (`identity_in_diff`). Code is never rewritten.
- [x] **Check logs get only the path leak check.**
- [x] **Each judge item needs one evidence ref that resolves somewhere.**
- [x] **`duel.applyWorker`** (default: the first contestant).
- [x] **The apply worker resumes its own session** with the approved items and the other diff's excerpts.
- [x] **With zero approved items, apply is skipped.**
- [x] **After apply** *(changed in review)*: the full **check → fix loop up to `maxFixIterations`**: `recheck.0` → [`refix.i` → `recheck.i`]. Fixes resume the apply session.
- [x] **Edit-step retries reuse the step's first checkpoint** (now also for transient retries).
- [x] **Check steps don't use the full snapshot gate.**
- [x] **Per-repo `setup` per contestant worktree.**
- [x] **`report.md` is written by the orchestrator.** It now also covers forfeits, the post-apply fix iterations, and items dropped by the swap pass.
- [x] **CLI duel/approve/resume flow.**

## M5: daemon and security

API, all under `/api` and all requiring the token:
- `GET`: `health`, `runs`, `runs/:id`, `runs/:id/events?since=`, `runs/:id/events/stream` (SSE), `runs/:id/file?path=`, `runs/:id/diff/:label`, `runs/:id/changes/:label`, `runs/:id/blob?rev=&path=`, `quota`
- `POST`: `runs`, `runs/:id/approve`, `runs/:id/resume` (`{force?, retryFailed?}`), `runs/:id/cancel`, `runs/:id/clean`, `gc` (`{olderThanDays}`)

- [x] **Authentication** *(changed in review)*:
  - The token is accepted only as an `Authorization: Bearer` header or the HttpOnly SameSite=Strict cookie. **It never appears in a URL**; `?token=` is refused.
  - The GUI link is `/auth?code=…` with a **single-use code that expires after 60 s**. `GET /auth` exchanges it for the cookie and redirects (303) to `/`; a used or expired code gets 401.
  - `fractory serve` prints a fresh link each time you press Enter.
  - Verified in headless Chrome: after the redirect, the address bar shows `/#/run/…` with no code, and `document.cookie` is empty (HttpOnly).
- [x] **Host and Origin rules, no CORS.**
- [x] **Security headers on every response.** M6 tightened the CSP to `worker-src 'self'` (see M6).
- [x] **Run files are always served as `text/plain`.**
- [x] **The daemon drives runs in its own process** (lock conflicts → 409).
- [x] **The daemon never resumes interrupted runs by itself.**
- [x] **SSE: 250 ms polling, 15 s heartbeat, `end` event, ids = seq.**
- [x] **A prompt sent as text is saved in `<dataDir>/prompts/`.**
- [x] **`fractory serve` options** (`--port`, `--no-open`, shell-free browser launch).
- [x] **The daemon serves the built GUI from `packages/web/dist`.**

## M6: GUI (and how the review changes were implemented)

GUI:
- [ ] **Svelte 5 SPA with hash routing:** `#/` runs list; `#/run/<id>/live|compare|verdict`. A fragment survives the `/auth` → `/` redirect, so a login link can deep-link into a run.
- [ ] **All state comes from the daemon.**
  - The live view replays the run's event log over SSE from the start, and reconnects with `Last-Event-ID`.
  - It refetches `state` at most every 300 ms after events.
  - The runs list polls every 3 s, the header every 10 s. A page refresh loses nothing.
- [ ] **Live view** has one pane per contestant, plus "judge" and "orchestrator" panes. Check steps go to their contestant's pane. Text deltas are merged. Tool calls are collapsible and paired with their results; blocked calls are marked red; transient retries appear inline.
- [ ] **The phase indicator** is derived only from step states:
  - Consensus: setup · propose · critique · revise · judge.
  - Duel: setup · implement · check/fix · judge · approve · apply · recheck · report.
- [ ] **Markdown rendering:** marked → DOMPurify, with `img`, `style`, `form` and `input` forbidden, and links forced to `noopener` + new tab.
  - `path:line` refs, including inside code spans, become `vscode://file/<repo>/<path>:<line>` links.
  - They point to **your main repo's** files, not the worktrees.
- [ ] **Compare view:**
  - Consensus: proposals, critiques and each revision round side by side.
  - Duel: Monaco side-by-side diff per changed file, in three modes (A vs B, base vs A, base vs B). File contents come from `git show <commit>:<path>` through a new `blob` endpoint, which takes repo-relative paths only.
- [ ] **Monaco is loaded lazily**, only in the duel compare view (the editor chunk is about 2.7 MB).
  - Only the editor worker is used; language services aren't loaded, and syntax colouring comes from Monaco's basic tokenizers.
  - **Verified under the daemon's CSP in headless Chrome:** the diff renders, the worker starts as a same-origin script, and there are no CSP violations or console errors. So `worker-src` was **tightened to `'self'`**; `blob:` isn't needed.
- [ ] **Verdict view:**
  - Consensus: shows `decision.md`.
  - Duel: shows the judge items with checkboxes, "Approve N item(s) and resume" or "Approve only", the approved state, and `report.md` when done.
- [ ] **Run controls:**
  - Resume / Continue (needs_attention) / force resume (quota).
  - Cancel / Abort.
  - Retry failed step.
  - Remove worktrees.
  - Warnings and forfeits are shown as notes.
- [ ] **Header widget:**
  - Claude quota windows from the last rate-limit events.
  - Per-worker token totals across runs: metered workers show their computed cost; subscription workers show "API-equivalent $…".
- [ ] **The GUI duplicates two small pieces of core** (the `path:line` regex and the state types), because core is Node-only. The two regexes must be kept in sync.
- [ ] **Dependencies:**
  - Monaco bundles DOMPurify ≤3.4.16, which has critical XSS advisories. A root `overrides` forces 3.4.17 everywhere; `npm audit` no longer reports it.
  - Two **low** advisories remain in `deepmerge` (via the Svelte Vite plugin, build-time only).
- [ ] **Unit tests cover the GUI's pure logic** (panes, phases, refs → links, token stripping); there are no component tests. The screens were checked by hand in headless Chrome against a fake duel run.

Review changes, implementation choices:
- [ ] **What counts as transient:** HTTP 5xx and "overloaded", network errors, and for Pi/Together any 429 or "rate limit". "Max 2 attempts" was read as **2 retries** (3 tries in total). The retry counter is per step and resets on `--retry-failed`.
- [ ] **`judge.swapOrderPass` is a verification pass, not a second full verdict.**
  - The judge (fresh session) gets the same inputs with A and B swapped, plus the numbered points from pass 1. It rates each point A / B / both / neither.
  - A point is kept only if both passes attribute it to the same contestant(s). Dropped points are listed in `decision.json`/`verdict.json`, `decision.md` and the report.
  - If no point survives, the judge step fails (`exit_check`).
  - Swap-pass inputs are written before the gate's `inputs/` baseline (§8.19).
  - *Alternative:* two independent full verdicts matched by topic. That needs fuzzy matching of free text, which isn't machine-checkable.
- [ ] **Both-forfeit is recorded as a failing `outcome` step**, so the failure is a normal, logged step result.
- [ ] **`clean`:**
  - It removes all of a run's worktree directories (contestants and judge).
  - Leftover non-git directories are removed only after the guard's path check.
  - It records `worktrees_cleaned` in the run log.
  - **`gc` uses the run's last update time.**
- [ ] **Login codes live only in daemon memory** (they don't survive a restart). Pressing Enter in the `serve` terminal mints a new one and opens it if `--open` is in effect.
- [ ] **The dirty-repo check** counts tracked changes and untracked files (not ignored files) at run creation only.
