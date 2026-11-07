# Build "fractory": a local multi-model orchestrator for consensus design and implementation duels

## Context
I want two coding agents from different model families to work on my repositories:
- **Opus** via Claude Code on my **Claude Pro subscription** (headless: Claude Agent SDK or `claude -p`). No API key for Anthropic.
- **DeepSeek V4.1 Flash** via the **Pi coding agent** (`pi`, @earendil-works/pi-coding-agent) using Together AI (`TOGETHER_API_KEY`, model id `deepseek-ai/DeepSeek-V4.1-Flash-1017`).

Primary platform: **Windows 11**. Must be designed to work on Linux and macOS too.

### Hard architectural rules (do not deviate)
1. **Deterministic control plane.** All workflow logic is explicit TypeScript state machines. No LLM ever decides the control flow, phase transitions, or "is it done".
2. **Models are bounded workers** behind a thin adapter interface. One task per invocation, either fresh or explicitly resumed by session id.
3. **State lives on disk.** Every run has an append-only `events.jsonl` (source of truth) plus derived `state.json`. Every step is idempotent and checkpointed. A crash or restart must be resumable from the last completed step.
4. **Engine is independent of the GUI.** Layers: `core` (library) → `cli` and `daemon` (local HTTP API + SSE) → `web` (Svelte SPA, pure view). The CLI must work with no GUI running. The GUI must never own subprocesses or state.
5. **Use only first-party, documented interfaces.** Do NOT use pi-claude-bridge, pi-claude-code-auth, or any Claude auth/billing shim. Opus runs through Claude Code itself.
6. **Machine-checkable exit conditions** for every phase (file exists, schema validates, git tree clean, checks pass), never "the model said it's done".

## Stack
- Node 22+, TypeScript (strict), npm workspaces: `packages/core`, `packages/cli`, `packages/daemon`, `packages/web`.
- Daemon: Hono or Fastify. Commands over HTTP, events over **SSE** (replays the run's events.jsonl on connect, then streams live).
- Web: **Svelte 5 + Vite SPA** (no SSR). Monaco diff editor (or an established git-diff component) for diffs; markdown rendering for proposals/verdicts.
- Validation: zod for config, events, and judge outputs.
- Process handling: `execa` or `cross-spawn` (Windows `.cmd` shims), `tree-kill` for killing process trees, `env-paths` for OS-appropriate data dirs.
- Keep dependencies minimal and mainstream.

## Cross-platform requirements
- Never build shell command strings; pass argv arrays. Use `path` everywhere; no hardcoded separators.
- Resolve `claude` and `pi` executables correctly on Windows (npm `.cmd` shims); make paths overridable in config.
- Cancellation/timeouts must kill the whole process tree on all OSes.
- Parse streamed JSON lines robustly (`\r?\n`, partial chunks, non-JSON noise on stderr).
- Git: create worktrees as siblings outside the target repo (e.g. `<data-dir>/worktrees/<run-id>/<worker>`), handle long paths on Windows, and normalize line endings in diffs (don't let CRLF produce whole-file diffs).
- **Scrub `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` from the Claude child's environment** so it always uses my subscription login.
- Never log secrets; redact API keys from events and logs.

## Worker adapter interface (core)
Roughly:
```ts
interface Worker {
  id: string; // "opus" | "deepseek" | "judge" | ...
  run(task: {
    prompt: string; cwd: string; mode: "read-only" | "edit";
    sessionId?: string; timeoutMs: number; signal: AbortSignal;
  }): AsyncIterable<WorkerEvent>; // text, tool_call, tool_result, usage, rate_limit, error, done{sessionId, finalText}
}
```
Adapters: `ClaudeWorker`, `PiWorker`, and `FakeWorker` (scripted, deterministic, for tests). Raw vendor events are normalized into `WorkerEvent` and the raw stream is also saved per step for debugging.

**Read-only mode** must be enforced in two ways: (a) the tool/permission restrictions each CLI supports (verify what exists), and (b) an orchestrator gate: after a read-only step, `git status --porcelain` in that worktree must be empty, otherwise the step fails and the worktree is reset.

**Quota handling (important on Pro):** detect Claude usage-limit / rate-limit signals (events or errors). Put the run into a `paused_quota` state with the reset time if known. Support resume. Never busy-retry.

## Workflow 1: consensus (design / UI / implementation plan)
Input: target repo path, prompt file, config. All phases read-only.
1. **Independent proposals (parallel):** Opus and DeepSeek each write a proposal grounded in the actual code. Exit check: non-empty, and contains at least N `path:line` references that exist in the repo.
2. **Cross-critique:** each critiques the other's proposal against the code: what's wrong, what's better than their own.
3. **Revision rounds:** each revises its proposal, up to `maxRounds` (config, default 1). Stop early if both declare no changes (structured flag, schema-validated).
4. **Synthesis by judge:** proposals are **anonymized as A/B with randomized order** to reduce self-preference and position bias. The judge produces `decision.md` plus structured JSON: decisions, rationale, evidence refs, and an explicit list of unresolved disagreements.
Judge model is configurable; default to DeepSeek via Pi (to save Pro quota), with another Together model as an option.

## Workflow 2: duel (independent implementations + cherry-pick)
1. Record base commit; create two worktrees on branches `fractory/<run>/opus` and `fractory/<run>/deepseek`.
2. Both implement the feature prompt in parallel (edit mode), within timeouts.
3. Run the configured **check commands** (build/test/lint, configurable per repo) in each worktree; record results.
4. **Judge** receives both diffs (vs base) plus check results, anonymized and order-randomized, and returns schema-validated JSON: a list of items `{aspect, betterSide, evidence: path:line[], recommendation, risk}`.
5. **Human approval gate:** the run pauses in `awaiting_approval`. I approve a subset of items via CLI or GUI.
6. Resume the **Opus session** (by session id) in its worktree with the approved items, plus the relevant excerpts from DeepSeek's diff. Rerun checks.
7. Final report. **Never merge or push anything**; leave the branches for me.

## CLI
`fractory consensus --repo <path> --prompt <file>`, `fractory duel --repo <path> --prompt <file>`, `fractory runs`, `fractory show <id>`, `fractory approve <id> --items 1,3`, `fractory resume <id>`, `fractory cancel <id>`, `fractory serve` (starts daemon + opens GUI). Config via `fractory.config.json` (global in the OS config dir, overridable per repo), validated with zod.

## Daemon security (non-negotiable)
Bind to `127.0.0.1` only. Random per-launch token required on every request (passed to the GUI via the URL the CLI opens). Validate the `Host` and `Origin` headers to block DNS rebinding and CSRF. No permissive CORS.

## GUI (keep scope to these screens)
1. **Runs list:** status, workflow, repo, timestamps.
2. **Live run view:** phase indicator plus one pane per worker streaming normalized events (collapsible tool calls).
3. **Compare view:** proposals/critiques side by side (markdown), or diffs side by side (Monaco diff). `path:line` refs are clickable and open in VS Code (`vscode://file/...`).
4. **Verdict/approval view:** judge items with checkboxes, approve/resume.
Header widget: Claude quota state (from rate-limit events) and DeepSeek token/cost totals. Reconnect-safe: a page refresh loses nothing.

## How to work
- **Milestone 0, spikes first:** before writing adapters, run `claude --help`, `pi --help`, and consult current docs to verify headless flags, stream-json/RPC formats, session resume, tool restrictions, and how Pi configures Together as a provider. Do tiny real invocations on this Windows machine. Record findings in `docs/interfaces.md`. Don't trust flag names in this prompt; verify them.
- Then milestones, committing after each with tests passing:
  M1 core (events, state machine, run store, FakeWorker, unit tests) → M2 adapters + git/worktree + check runner → M3 consensus + CLI → M4 duel + approve/resume → M5 daemon + security → M6 GUI → M7 GitHub Actions CI matrix (windows, ubuntu, macos) with FakeWorker tests, plus README and ARCHITECTURE.md.
- **Conserve my Pro quota:** all automated tests use FakeWorker. Real-model tests are a single opt-in smoke script that I run manually.
- Use plan mode first and show me the plan. Stop at the end of each milestone with a short summary so I can review before you continue.
- Keep a `CLAUDE.md` with the architectural rules above so future sessions respect them.