# Decisions to review

Choices made while building fractory that you may want to confirm or change. Each milestone adds a section. Every entry gives the choice, the reason, and what changing it would affect. Tick an item (`[x]`) once you've confirmed it, or note the change you want.

Binding requirements you already set (docs/interfaces.md §8) are not repeated here. This file lists only the calls made on top of them.

---

## M0: spikes and interfaces

- [ ] **Default Pi model id is the spec's `deepseek-ai/DeepSeek-V4.1-Flash-1017`.** Pi's catalog lists only `…-Flash`. The `-1017` id still works, but Pi warns on stderr that it's a "custom model id". Prices are configured for both ids.
  - *Alternative:* default to the catalog id `deepseek-ai/DeepSeek-V4.1-Flash`.
- [ ] **Pi reasoning: only `off` and `high` are effective for this model.** Pi clamps every other level to `high`. Config accepts all levels, but warns on anything other than `off`/`high`. The default is `high`.
- [ ] **Claude effort is logged as requested only.** Claude Code never reports the effective effort, so `effectiveReasoning` is `null` for Claude steps. The default effort is `high`.
- [ ] **Project-context parity: both harnesses load no project context.** Claude runs with `--setting-sources ""`; Pi runs with `--no-context-files` and an empty, isolated agent dir. The orchestrator injects the same text into both prompts: by default, the repo-root `AGENTS.md` and `CLAUDE.md` if present.
  - Consequence: your global `~/.claude/CLAUDE.md`, settings, hooks and MCP servers never apply to fractory runs.
- [ ] **Pi's internal retries are disabled** (`retry.enabled=false`, `maxRetries=0` in fractory's own Pi agent dir), so every retry is the orchestrator's decision. A transient Together error fails the step instead of being retried silently.
- [ ] **The Claude "quota rejected" payload has never been observed live.** Detection is deliberately broad:
  - any `rate_limit_event.status` other than `allowed`/`allowed_warning`,
  - `api_error_status` 429,
  - result text matching `usage limit|rate limit|limit reached|quota|429|too many requests`.

  The risk is false positives, where a run pauses for quota when the cause was something else. Nothing is ever retried automatically.
- [ ] **Prompts always go over stdin.** This avoids the Windows command-line length limit and quoting issues. Pi's `@file` was rejected because the model treated the wrapped file as a prompt injection.

## M1: core engine

- [ ] **Workflows are pure `next(state)` functions.** Each returns the next stage (steps run in parallel) or "done". The engine never reads model text except through schema-validated step results.
- [ ] **Single writer per run.** Only the driver holding `driver.lock` appends events. A lock left by a dead process is taken over. `cancel` while a driver is running writes a `cancel.request` file, which the driver polls every 500 ms.
- [ ] **Crash recovery truncates a torn last line.** If the final line of `events.jsonl` is half-written, it's ignored on read and cut off when a writer opens the run. A corrupt line in the middle, or a gap in sequence numbers, refuses to load.
- [ ] **Crash recovery is tested with constructed logs**, meaning the exact events and torn bytes a crash leaves behind. No test kills a real driver process.
- [ ] **On resume, only quota failures are retried.** Every other step failure ends the run as `failed`. A step that was running during a crash is marked abandoned and rerun.
- [ ] **A hard failure in a parallel stage aborts its siblings** to save quota. **A quota hit lets siblings finish**, and their work is kept for the resume. When several steps end badly, the run outcome is chosen in this order: cancelled > failed > quota > needs_attention.
- [ ] **Resuming before the quota reset time is refused** unless `--force` is given.
- [ ] **Approving zero items is allowed**, so you can reject everything the judge suggests and still finish the run.
- [ ] **Streamed text is merged before it's logged.** Text and thinking deltas are coalesced into events of up to 4000 characters or 250 ms. `state.json` writes are throttled to one per 250 ms during worker streaming. This keeps the log small, but the GUI updates in chunks rather than token by token.
- [ ] **Default judge is DeepSeek (via Pi), which is also a contestant**, as the spec says. Anonymization reduces self-preference but can't remove it. The alternative is another Together model as judge.
- [ ] **Cost comes from tokens × your price table.** A missing price component makes the cost `null` with a warning, never a guess.
- [ ] **Toolchain:** TypeScript 7.0.2 (the native compiler), vitest 5, zod 4. `@types/node` is pinned to 22 so the code stays within your Node ≥22.19 minimum.
- [ ] **`.gitattributes` forces LF** (`* text=auto eol=lf`) and the existing files were renormalized.

## M2: adapters, git, checks

- [ ] **Gates and checkpoints are building blocks for now.** Snapshots, step gates, checkpoints and the check runner are implemented and tested, but only the M3 (consensus) and M4 (duel) workflows will call them on every step.
- [ ] **Pi's path guard must prove it loaded.** On load, the guard writes a per-invocation nonce to an ack file in the step dir, and the adapter rejects `done` without it. Verified against the real Pi with `npm run smoke` (SMOKE OK, 2026-11-09), along with the Claude subscription login and sibling-worktree confinement for both workers.
- [ ] **Pi gets no secrets except the `.dev.vars` values.** Every env var whose name looks secret (`*KEY*`, `*TOKEN*`, `*SECRET*`, `PASSWORD`, `CREDENTIALS`) is stripped from the Pi child, then the envFile values are added.
  - Claude has only `ANTHROPIC_*` and the envFile keys removed. Stripping everything secret-looking could break a login that relies on an env token, such as `CLAUDE_CODE_OAUTH_TOKEN`.
- [ ] **Check and setup commands get no secret-looking env vars.** A repo script that needs a token (e.g. `NPM_TOKEN`) must get it through that command's `env` in the config.
- [ ] **Claude permission denials are counted as `tool_blocked`.** They're also visible as error tool results.
- [ ] **Claude usage is recorded per model** from `modelUsage`, so background Haiku calls count too. The price key is `anthropic/<model>`. No Claude prices are configured, so each Claude step logs a "no price" warning. Claude's own `costUSD` is stored for information only, as an API-equivalent figure.
- [ ] **Raw vendor streams are kept for debugging**, redacted, in `steps/<id>/worker-<id>.raw.jsonl` and `.stderr.log`. Retries and repairs append to the same files with an invocation header. At most 200 stderr/noise lines per invocation go into the event log; the full stderr is in the file.
- [ ] **Tool outputs in the event log are truncated** to 8000 characters. Final text and structured output are never truncated.
- [ ] **Snapshots use `git status --ignored=matching`.** Ignored directories are walked file by file, except the ones in `excludeDirs`, which are recorded only as present or absent.
  - Blind spots: changes inside excluded dirs, and same-size, same-timestamp edits to ignored files over 1 MiB.
  - Hashing uses `git hash-object --no-filters`, i.e. raw bytes, so a CRLF-only rewrite counts as a change in a read-only step.
- [ ] **All git calls disable optional locks** (`GIT_OPTIONAL_LOCKS=0`), so `git status` snapshots never rewrite the index. They also force `core.longpaths=true` and `core.quotepath=false`.
- [ ] **Judge diffs use `--ignore-cr-at-eol` and `--find-renames`.** A change that touches only line endings is invisible to the judge, and renames show as renames.
- [ ] **Re-creating a worktree is idempotent.** An existing worktree on the expected branch is reused, a leftover branch without a worktree is reattached, and a non-empty foreign directory at the path is an error.
- [ ] **Check artifacts are copied into `artifacts/<check-name>/`**, keeping their relative paths. Only regular files inside the worktree are copied; symlinks are skipped.
- [ ] **Config: only `argv[0]` must be non-empty.** Later arguments may be empty strings (e.g. `--flag ""`).
- [ ] **The smoke script is plain `.mjs` and runs on the built `dist/`** (`npm run smoke`). Claude defaults to `--model haiku` with effort `low`, and Pi to thinking `off`, to keep the call cheap.
