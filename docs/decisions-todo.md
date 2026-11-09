# Decisions to review

Choices made while building fractory that you may want to confirm or change. Each milestone adds a section. Every entry gives the choice, the reason, and what changing it would affect. Tick an item (`[x]`) once you've confirmed it, or note the change you want.

Binding requirements you already set (docs/interfaces.md §8) are not repeated here. This file lists only the calls made on top of them.

**Status:** M0–M5 and M6 reviewed 2026-11-09. Everything there is confirmed except the items you changed, which are marked *(changed in review)* and describe the new behaviour; all are implemented and tested. Open for review: the implementation choices at the end of M6.

---

## M0: spikes and interfaces

- [x] **Default Pi model id is the spec's `deepseek-ai/DeepSeek-V4.1-Flash-1017`.** Pi's catalog lists only `…-Flash`. The `-1017` id still works, but Pi warns on stderr that it's a "custom model id". Prices are configured for both ids.
- [x] **Pi reasoning: only `off` and `high` are effective for this model.** Pi clamps every other level to `high`. Config accepts all levels, but warns on anything other than `off`/`high`. The default is `high`.
- [x] **Claude effort is logged as requested only.** Claude Code never reports the effective effort, so `effectiveReasoning` is `null` for Claude steps. The default effort is `high`.
- [x] **Project-context parity: both harnesses load no project context.** Claude runs with `--setting-sources ""`; Pi runs with `--no-context-files` and an empty, isolated agent dir. The orchestrator injects the same text into both prompts: by default, the repo-root `AGENTS.md` and `CLAUDE.md` if present.
- [x] ~~**Pi's internal retries are disabled**, so every retry is the orchestrator's decision. The orchestrator now retries transient errors itself, with backoff (see M1 *(changed in review)*).~~ **Changed (review 2026-11-09):** Pi's own retries are on, for provider rate limits and 5xx, and the step retry is the last resort. See "Review of open items" at the end and `docs/interfaces.md` §2 "Retries".
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

## M6: GUI (and how the M0–M5 review changes were implemented)

GUI:
- [x] **Svelte 5 SPA with hash routing.** A fragment survives the `/auth` → `/` redirect.
- [x] **All state comes from the daemon** (SSE replay and reconnect; state refetched ≤ every 300 ms; runs list every 3 s, header every 10 s).
- [x] **Live view panes** (one per contestant, plus judge and orchestrator).
- [x] **The phase indicator** is derived only from step states.
- [x] **Opening `path:line` refs** *(changed in review)*:
  - A ref now opens an **in-app, read-only Monaco view** of the file at **the commit the ref was made against**, scrolled to the line or range and highlighting it. The file comes through the blob endpoint.
  - **"Open in VS Code"** is a secondary action in that view, labelled with what it opens:
    - "Open in VS Code: opus (a1b2) worktree" while the worktree exists, with a note if the worktree has moved on since that commit;
    - otherwise "Open in VS Code: main repository", with a note that your repository's current file may differ.
  - Markdown is still marked → DOMPurify, with `img`, `style`, `form` and `input` forbidden.
- [x] **Compare view** (consensus documents side by side; duel Monaco diffs in three modes).
- [x] **Monaco is loaded lazily**, only for the duel compare view and the file view. It was verified under the CSP (`worker-src 'self'`).
- [x] **Verdict view.**
- [x] **Run controls.**
- [x] **Header widget.**
- [x] **No duplicated core code** *(changed in review)*:
  - The `path:line` extractor and the state/event types now live in a Node-free **`packages/shared`**, imported by core and the GUI. The GUI's copies are gone.
  - Core keeps re-export shims (`schemas/run-events.ts`, `schemas/worker-events.ts`, `state/reducer.ts` re-exports the state types), so its public API is unchanged.
- [x] **Dependencies:** the DOMPurify override stays. Only the two low `deepmerge` advisories remain (build-time); Playwright added none.
- [x] **GUI tests** *(changed in review)*: in addition to the unit tests, there's **one Playwright smoke test** against a fake duel run (`npm run e2e`).
  - Path: runs list → open run → compare view renders the Monaco diff → open a `path:line` ref in the file view (line highlighted, labelled VS Code link) → approve one item → the state updates live to `completed`.
  - It fails on any console error. It runs in CI together with `npm audit` once M7 adds CI.

Review changes (M0–M5), implementation choices:
- [x] **What counts as transient** (5xx/overloaded, network, Pi/Together 429). "Max 2 attempts" = 2 retries; the per-step counter resets on `--retry-failed`.
- [x] **`judge.swapOrderPass` is a verification pass** over the first pass's numbered points (fresh session, A/B swapped). A point is kept only if both passes attribute it to the same contestant(s).
- [x] **When no point survives the swap pass** *(changed in review)*:
  - This is **not a failure**. The run records a `no_robust_preferences` warning and sets `noRobustPreferences` on the judge result, then continues with an empty verdict.
  - Consensus: `decision.md` says "No robust preferences" and the run completes. The exit check accepts an empty decision list only when that flag is set.
  - Duel: the run goes to the approval gate with nothing to approve; resuming skips apply and writes the report.
- [x] **Both-forfeit is a failing `outcome` step.**
- [x] **`clean` / `gc`.**
- [x] **Login codes live in daemon memory**; Enter in the `serve` terminal mints a new one.
- [x] **The dirty-repo check** runs at run creation only (tracked changes and untracked files).

M6 review changes, implementation choices (reviewed):
- [x] **Which commit a document's refs point to** *(changed in review, for duels)*:
  - Consensus documents and `decision.md`: the base commit.
  - **Duel judge evidence: every ref is resolved individually.** While validating the judge's evidence, the orchestrator checks each ref against side A's head, side B's head and the base. It records `{path, line/range, side, label, sha, ambiguous, chosenBy, resolvedIn}` in the item's `evidenceRefs`.
  - When a ref resolves in more than one place it is marked `ambiguous`, and the side is picked in this order:
    1. the side the evidence text names (e.g. `B: math.js:3`);
    2. the side the item text names;
    3. the item's better side;
    4. base.
  - In-app links, the file view and "Open in VS Code" use **each ref's own side and commit**, not the item's better side.
  - **`report.md` uses the same per-ref data:** each evidence ref is a link to its side and commit, e.g. `[math.js:3](#ref/<label>/<sha>/3-3/math.js) (B, deepseek @ 1a2b3c4, ambiguous)`. Evidence that resolved nowhere is marked "(unresolved)".
  - Refs in an item's prose (recommendation) use that item's resolved evidence for the same file. Otherwise they open at the better side's head.
- [x] **Which worktree "Open in VS Code" uses:** the worktree of the ref's own side (the judge worktree for base), with the "moved on" and "removed" notes.
- [x] **The blob endpoint serves only commits recorded in the run.**
- [x] **Refs outside the repository are shown greyed.**
- [x] **What's in `packages/shared`** (now also the evidence-resolution types, the in-app link format, and the evidence renderer used by both core's `report.md` and the GUI).
- [x] **Playwright uses the installed Chrome**; `npm audit --audit-level=moderate` in CI.
- [x] **Ref linking runs after `tick()`.**
- [x] **The extractor regex was rewritten** (both separators covered by tests).

Per-ref resolution, implementation choices (open):
- [ ] **How a text "names" a side** (`sideMentioned`). It recognises:
  - `B:` / `B -` at the start of an evidence string;
  - "side B", "implementation B", "version B" or "branch B";
  - "B's";
  - "(B)" or "[B]";
  - "in B", "from B" or "of B".

  Only capital A/B count, so the article "A …" isn't a side. A text that names both sides names neither.
  - *Alternative:* ask the judge for `side` per evidence entry in the schema. More reliable, but it changes the judge's output format.
  - **Superseded (review 2026-11-09):** the judge now declares `side` per evidence entry. `sideMentioned` is only a fallback for runs judged before that (see "Review of open items" below).
- [ ] **"Resolves" means the same rule as everywhere else:** the file exists at that commit and the line or range is within it. It's checked in each side's worktree while it is still at the judged head, and in the judge worktree for base.
- [ ] **Link format:** `#ref/<label|base>/<sha>/<line>-<end>/<path>`. It's a plain markdown link, so `report.md` stays readable outside the GUI, and DOMPurify allows `#` links. Runs judged before this change have no `evidenceRefs` and fall back to the better-side behaviour.
- [ ] **The apply step's excerpt of the other diff** now uses the resolved refs: files cited on the other side by the approved items.

## M7

- [x] ~~**CI tests Node 22 only.**~~ **Changed (review 2026-11-09):** the matrix is Node 22 and Node 24 on all three OSes (6 jobs). Playwright trace artifacts are named per OS and Node version.
- [ ] **Audit fails at moderate severity.** Two known low-severity `deepmerge` findings remain in build dependencies; lowering the threshold would make CI fail until they are resolved.
- [ ] **Run the GUI smoke test on all three operating systems using preinstalled Chrome.** This exercises the packaged GUI without downloading a browser; changing browser or installation strategy affects portability and CI duration.
- [ ] **Pin GitHub Actions to major version tags.** This receives updates within each major version; pinning commit SHAs would make action dependencies immutable but require explicit updates.
- [ ] **Documentation separates user setup from engineer architecture.** The README covers operation and configuration, while ARCHITECTURE.md explains implementation and invariants; changing this split affects where contributors and users look for guidance.

## Provider and reasoning switch (2026-11-09)

Requested: Baseten instead of Together; the DeepSeek "Fast" variant; GLM-5.3 Flash as judge; medium reasoning for every model call.

- [ ] **Contestant model: `deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast`.** Baseten also has `DeepSeek-V4.1-Flash-Fast`, but its output limit is 32.8K tokens in Pi's catalog (131K per Baseten) versus 262K for the `1017` build the spec names. Price: input $0.60, output $2.40, cache read $0.014 per 1M, twice the non-Fast price.
- [ ] **Judge: `zai-org/GLM-5.3-Flash`** (input $0.15, output $0.50, cache read $0.03 per 1M), about a tenth of GLM-5.3.
- [ ] **Prices come from Baseten's `/v1/models` catalog** (its `pricing` field, checked 2026-11-09), because the pricing web page is JavaScript-rendered. No cache-write price is listed; as before, cost becomes unknown only if a cache-write token count appears.
- [ ] **The Together price entries were removed** from the defaults. A config that switches a worker back to Together must add its own `prices`. The Together-specific thinking-clamp warning is kept for that case.
- [ ] **Medium reasoning everywhere:** Claude `effort: "medium"`, Pi `thinking: "medium"` for both Pi workers. These are both the schema defaults and the built-in worker defaults, so a worker declared without a level also gets medium. The smoke script now uses the defaults too, so it costs slightly more than before (it previously used `low`/`off`).
- [x] ~~**Whether `medium` is effective on Baseten is unverified.**~~ Verified by the smoke run: DeepSeek runs at `medium`. GLM-5.3 Flash has only low/high/max, so Pi sent `high`; the judge is now set to `high` explicitly (see below).
- [ ] **Pi's `passEnv` default is now `["BASETEN_API_KEY"]`.** A `TOGETHER_API_KEY` in your shell is no longer passed to Pi unless you add it to `passEnv`, or put it in the envFile.

## Review of open items and smoke follow-ups (2026-11-09)

Requested: Pi request-level retries for rate limits; a declared `side` per judge evidence entry; CI on Node 22 and 24; `judge.swapOrderPass` on by default. Then, after the Baseten smoke run: the judge's thinking explicitly `high`, and an investigation of unreported reasoning tokens (findings in `docs/interfaces.md` §2 "Baseten reasoning tokens").

- [ ] **Both of Pi's retry levels are enabled, 4 retries each.** The request asked for retries that honour Retry-After *and* emit `auto_retry_*` events, but no single Pi level does both: the provider level honours Retry-After but emits nothing; the agent level emits events but ignores Retry-After.
  - Provider level: `maxRetries: 4`, `maxRetryDelayMs: 60000`.
  - Agent level: `maxRetries: 4`, backoff 2, 4, 8, 16 s, capped at 60 s.
  - Worst case is 25 HTTP attempts per turn, and provider-level retries never show in the live view.
  - *Alternative:* agent level only (every retry visible, Retry-After ignored), or provider level with fewer retries.
- [ ] **`provider_retry` WorkerEvent** with `phase: "scheduled" | "finished"`, `attempt`, `maxAttempts`, `delayMs`, `success` and `message` (truncated to 1000 chars). The CLI prints it, the GUI shows it as an amber "↻" line, and a final failure shows as an error line. Step retries (`step_retrying`) now also print in the CLI, which they didn't before.
- [ ] **Step retry delay** (`stepRetryDelayMs`):
  - A Retry-After in the error text comes first, capped at 15 minutes. It matches Pi's `Server requested Ns retry delay`, `retry-after-ms`, `Retry-After: N` (seconds) and "try again in N s/min".
  - Otherwise a rate limit uses the new `retry.rateLimitBackoffMs` (default 60 s, then 120 s), and anything else uses `retry.backoffMs` (5 s, then 30 s).
  - It reads only the final error message: Pi's headers aren't visible to the orchestrator.
- [ ] **Evidence side is in the duel verdict schema:** each evidence entry is `{ref, side: "A"|"B"|"base"}`. `JudgeItem.evidence` stays a `string[]` of the refs, so the GUI, CLI and old runs are unchanged.
- [ ] **Side mismatch handling.**
  - **The check:** an entry whose ref exists, but not in its declared side, is a mismatch.
  - **The repair turn:** mismatches trigger the one repair turn, shared with the existing "item without valid evidence" repair, so a single prompt lists both problems.
  - **After the repair:** an item with no ref resolving in its declared side fails the step, as before. A ref that still mismatches but sits in an item that also has valid evidence doesn't fail it: that ref is not linked (shown as "unresolved"), and it's recorded in `evidenceSideMismatches` with an `evidence_side_mismatch` warning.
  - *Alternative:* fail the step on any remaining mismatch.
- [ ] **A declared side wins even when the ref also exists elsewhere** (`chosenBy: "declared"`, still marked `ambiguous`). The text inference is used only for plain-string entries.
- [ ] **`judge.swapOrderPass` defaults to `true`.** This doubles judge calls per run (GLM-5.3 Flash, cheap). The test helpers set it to `false` for tests that aren't about the swap pass; the swap tests set it explicitly.
- [ ] **Judge thinking is `high`, set explicitly.** GLM-5.3 Flash on Baseten has low/high/max. Medium isn't one of them, so Pi already sent `high`.
- [ ] **Reasoning level warnings, in two places:**
  - A config warning from a small built-in table of what each known model supports. It was copied from Pi 1.5.0's catalog `thinkingLevelMap` plus the Together spike, so it can go stale when Pi updates.
  - A run warning, `reasoning_level_mismatch`, whenever a step's effective level differs from the requested one. This holds for any model.
- [ ] **No reasoning-token estimate was added.** The probe showed that Baseten reports `reasoning_tokens`, that they're included in `completion_tokens`, and that Pi maps them into `usage.reasoning` and `usage.output`. Cost therefore already covers them. Both models reported 0 because they didn't reason on the smoke prompt. The 75 s GLM turn was latency on Baseten's side, not hidden thinking. Billing was inferred from the usage fields, not checked against an invoice.
  - fractory has no budget cap today, so there was nothing to switch to an estimate.
- [ ] **Not done:** recording receive timestamps in the raw stream files. With them, time-to-first-delta could be measured afterwards; without them, only Pi's per-message `durationMs` is available.


## Review workflow (2026-11-09)

Requested: a new `review` workflow (implement → cross-family review → test confirmation → respond → rebuttal → apply/dismiss gate), made the default of `fractory run`, plus `fractory stats`.

**Reviewer model and keys**
- [ ] **The reviewer runs through Pi's `openai` provider** (`workers.gpt`), not a new adapter. Pi 1.5.0's catalog has `gpt-6.1-sol`, so the existing guard, gates and stream parsing apply unchanged. **No real call has been made yet:** `npm run smoke -- --gpt` (new, opt-in, needs `OPENAI_API_KEY`) verifies it. *Alternative:* OpenRouter (`openai/gpt-6.1-sol`) behind one key.
- [ ] **Price `openai/gpt-6.1-sol`: input 2, output 10, cache read 0.10 per 1M.** Taken from Pi's catalog and third-party trackers; **not checked on openai.com**, and one tracker gave a different cache rate. No cache-write price, because OpenAI caching is automatic; a non-zero `cacheWrite` would make the cost unknown.
- [ ] **Reviewer reasoning `medium`**, matching the other models. off/minimal aren't mapped for this model (config warning).
- [ ] **`envFile` secrets reach every Pi worker** (existing behaviour, now more visible). With both keys in `.dev.vars`, DeepSeek, GLM and GPT all receive `BASETEN_API_KEY` and `OPENAI_API_KEY`; `passEnv` filters only the shell env. *Option:* filter `envFile` values by `passEnv` too (a small change in `PiWorker`), so each worker gets only its own provider's key.

**Roles and families**
- [ ] **`family` on every worker config**, inferred when omitted: Claude → `anthropic`; Pi from a first-party provider id (`openai`, `deepseek`, ...), else from model-id patterns (`gpt-`, `deepseek`, `glm`, `qwen`, ...). A fake worker is its own family. An implementer or reviewer whose family can't be inferred is a config error ("set workers.X.family").
- [ ] **The family check runs for every config, not only review runs**, because roles are part of the shared config. A global config whose reviewer shares the implementer's family fails even for `fractory duel`.
- [ ] **`roles` in `run_created` gained optional `implementer`/`reviewer`.** A review run's labels are implementer + reviewer (not the contestants). The quota pre-flight checks a run's labelled workers, plus the judge for duel/consensus.

**Steps and rules**
- [ ] **Step ids:** `implement`, `check.i`/`fix.i`, `review`, `confirm`, `respond.r`, `rcheck.r.i`/`rfix.r.i`, `retest.r`, `rebuttal.r`, `approve`, `apply`, `acheck.i`/`afix.i`, `report`. `review.maxFixIterations` (default 2) bounds every fix loop.
- [ ] **Three worktrees per run:** implementer, reviewer and scratch. The reviewer's is reset to the implementer's head (its own branch moves) before every reviewer turn. The scratch branch collects one hook-free commit per test run (`fractory: confirm test F1`); it is never the result branch.
- [ ] **The reviewer resumes its review session for the rebuttal** (it keeps its context). It gets the responses, the whole diff, the delta since its last look, and the checks.
- [ ] **No anonymization between implementer and reviewer.** They see each other's text as is, unlike the judge. Each knows it is in a review, and there is no A/B to hide.
- [ ] **Findings without a resolving ref after the repair turn are dropped** (warning `findings_dropped`, listed in the report and in stats as `dropped`), rather than failing the run. *Alternative:* fail the step, as the duel judge does.
- [ ] **A maintained rebuttal whose new refs don't resolve after its repair turn is still maintained**, flagged `evidenceInvalid` with a warning, so the user decides. *Alternative:* treat it as withdrawn.
- [ ] **Added beyond the spec: `retest.r`.** After each response round, the tests of confirmed findings rerun at the new head. A finding answered "fixed" whose test still fails is maintained automatically, just like a confirmed-but-rejected one.
- [ ] **Responses' refs are resolved and recorded, but not repaired.** An invalid ref there only shows up as unresolved. A repair would need another edit turn.
- [ ] **A respond turn that changed no files skips the checks.** The previous check result stands. A "fixed" answer with no file changes gives the warning `fixed_without_changes`.
- [ ] **`review.maxRounds` is 1–5, not 0.** A round always ends in a rebuttal.
- [ ] **An implementation without changes fails the run** (the `outcome` step), like a double forfeit in the duel.
- [ ] **Added to the reviewer's schema: `summary`.** It is shown in the report and the GUI. `review.maxFindings` (default 30) caps the findings list via the schema.

**Test confirmation**
- [ ] **`review.testCommand`** (unset by default) is `{argv, timeoutMs, env?, failExitCodes: [1], requireFileInOutput: true}`. `{testFile}` in argv is replaced by the repo-relative path; without a placeholder, the path is appended.
- [ ] **Classification:** exit 0 is `refuted`; an exit in `failExitCodes` is `confirmed`; timeout, spawn error or any other code is `error`. With `requireFileInOutput`, output that doesn't contain the test file's name is also `error`. This catches "no tests found" and collection errors, which most runners report with exit 1. The argv echo at the top of the log is excluded from that search.
- [ ] **Without a test command, every test file is recorded as `error`** (warning `no_test_command`). The reviewer is told not to write tests, and `fractory run` warns at start.
- [ ] **Test files may overwrite an existing file** at the head (recorded as `overwrote`). Paths are repo-relative, without `..`, and not in `.git` (schema-checked).

**Gate and stats**
- [ ] **The gate reuses the approval mechanism:** approved item numbers are applied, the rest are dismissed. `fractory approve <id> --items ""` dismisses all. When nothing is applied, the apply step records `skipped` and no checks run.
- [ ] **`fractory stats` counts completed review runs only**, grouped by reviewer worker id (with its configured model).
  - *confirmed bug rate* = bug-severity findings whose test failed / bug-severity findings.
  - *refuted rate* = passing tests / tests run.
  - *accepted / rejected* = the implementer's last answer; *withdrawn / maintained* = the reviewer's last verdict.
  - Also on the daemon as `GET /api/stats` (no GUI screen).
- [ ] **The duel's edit and check helpers moved to `workflows/edit.ts`** (shared, unchanged behaviour). `EditResult` gained `stepChangedFiles`.

## Start runs from the GUI (2026-11-09)

Requested: launch a run from the web UI, with the prompt typed into a textarea (no prompt files), a recent-repos list, the `serve` repo pre-filled, and a live repo check.

- [ ] **The pre-filled repo comes from `fractory serve`'s cwd** (or `--repo`), held by the daemon and served by `GET /api/start-info`, not passed in the login link. One daemon has one default. Without a repo cwd, the form falls back to the most recent run's repo. A `--repo` that is not inside a git repo is a startup error; a non-repo cwd is silently ignored.
- [ ] **Recent repos = the distinct repos of all runs in the data dir, newest first, capped at 20.** No separate "favourites" list. A deleted repo stays listed until its runs are removed; the live check marks it.
- [ ] **The repo field takes absolute paths only** (`GET /api/repo-check` refuses relative ones). A relative path would resolve against the daemon's cwd, which the browser can't see. A subdirectory resolves to the repo's top level, which is what the run uses.
- [ ] **`/api/repo-check` answers for any absolute path**: whether it exists, is a git repo, its branch/HEAD/dirty count, and config warnings. Token-gated and loopback-only, like the rest of the API, but it does let the GUI probe the filesystem. A repo without commits is refused there (the run would fail at setup).
- [ ] **Start warnings are shared** (`startWarnings` in core): the CLI prints them, `POST /api/runs` returns them, and the form shows them before you start. So far there's one (`review.testCommand` not set); the dirty-repo warning is still recorded on the run as before.
- [ ] **The prompt draft is kept in `sessionStorage`** (per tab, cleared after a successful start), so a reload doesn't lose it. Typed prompts are saved by the daemon under `<dataDir>/prompts/` (existing behaviour of `POST /api/runs`) and snapshotted into the run.
- [ ] **No config preview in the form** (which models/reasoning a run will use). It could come from the same repo-check call if wanted.
