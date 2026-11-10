# fractory: rules for every session

Local multi-model orchestrator: Opus (Claude Code, Pro subscription) and DeepSeek (Pi + LithosAI; judge GLM-5.3 Flash on Baseten) as bounded workers in deterministic workflows (consensus, duel). Full spec: `spec.md`. Verified CLI interfaces: `docs/interfaces.md`.

## Hard architectural rules (do not deviate)
1. **Deterministic control plane.** All workflow logic is explicit TypeScript state machines. No LLM ever decides control flow, phase transitions, or "is it done".
2. **Models are bounded workers** behind the `Worker` adapter interface. One task per invocation, fresh or explicitly resumed by session id.
3. **State lives on disk.** Each run has an append-only `events.jsonl` (source of truth) plus a derived `state.json`. Every step is idempotent and checkpointed. Crash/restart resumes from the last completed step.
4. **Engine is independent of the GUI.** `core` (library) → `cli` and `daemon` (HTTP + SSE) → `web` (Svelte SPA, pure view). The CLI works with no GUI. The GUI never owns subprocesses or state.
5. **First-party, documented interfaces only.** No pi-claude-bridge, pi-claude-code-auth, or any Claude auth/billing shim. Opus runs through Claude Code itself.
6. **Machine-checkable exit conditions** for every phase (file exists, schema validates, git tree clean, checks pass). Never "the model said it's done".

## Non-negotiables
- `packages/shared` (Node-free) holds the event schemas, run-state types and the `path:line` extractor, imported by core and web. Never duplicate them elsewhere.
- Never build shell command strings. Spawn with argv arrays (`cross-spawn`). Use `path` everywhere.
- Kill whole process trees (`tree-kill`) on cancel/timeout.
- Claude child env: delete `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`. Never use `claude --bare` (it breaks the subscription login). Assert `apiKeySource === "none"`.
- Never log secrets. All events pass through the redactor. `.dev.vars` is gitignored and must never be committed or printed.
- Worktrees live outside target repos (`<data-dir>/worktrees/<run>/<label>`; branches `fractory/<run>/<label>`). Labels are random per run, and label→worker lives only in run state. Never merge or push.
- Orchestrator commits: `-c core.hooksPath=<dataDir>/empty-hooks -c commit.gpgsign=false -c user.name=fractory -c user.email=fractory@localhost commit --no-verify`.
- After every check run: guarded reset + clean back to the post-step commit. Check outputs become step artifacts only.
- Step `inputs/` are hashed before/after each step. Any change = hard failure.
- Daemon binds 127.0.0.1 only, uses a per-launch token (header or HttpOnly cookie, never in a URL; the GUI link carries a single-use 60 s code), validates Host/Origin, no permissive CORS.
- **Conserve Pro quota:** automated tests use `FakeWorker` only. Real-model calls only in the opt-in smoke script.
- **No shell for workers.** Neither Claude nor Pi ever gets Bash/PowerShell. The orchestrator runs checks and feeds failures back (`maxFixIterations`).
- **Guarded destructive git.** `reset --hard` / `clean -fdx` / `worktree remove` only via the guard that asserts realpath ⊂ `<dataDir>/worktrees/`.
- **Snapshot gates.** Before/after `git status --porcelain --ignored` snapshots of the main repo and all run worktrees on every step. Read-only = snapshots equal (not "empty").
- **Edit steps are checkpointed** (commit at step start). Retry = guarded reset to the checkpoint.
- **Cost is computed by the orchestrator** from tokens × the configured price table. Vendor cost fields are informational only.
- **Transport:** prompts over stdin (never argv, never Pi `@file`). Large inputs go in step input files the agent reads.
- **Context parity:** both harnesses have project-context loading disabled. The orchestrator injects identical project context text.
- Log requested and resolved model ids and reasoning levels on every step.
- **Pi always runs with the fractory path-guard extension** (`--no-extensions -e <asset>`, fail-closed allowlist: own worktree, own step inputs, own out file). Workers must never be able to read each other's worktree.
- Snapshot handling: main-repo changes → `needs_attention` (the user may be editing concurrently). Worktree changes → hard failure.
- Per-repo `setup` runs after worktree creation and every guarded clean. Setup failures are environment errors, never fed to workers.
- Judge sees only squashed `base..HEAD` diffs and repo-relative paths. Self-references are scrubbed from **prose only** (never code in diffs) and leak-checked.
- **Real-model spikes use `claude --model haiku`** unless Opus behavior specifically is under test.
- Details and verified flags: `docs/interfaces.md` §8.

## Workflow
- Milestones M0–M7 (see `spec.md`). Commit after each with `npm run typecheck && npm test` green, then stop for review.
- At the end of every milestone, append a `## Mn` section to `docs/decisions-todo.md` listing each judgment call made in that milestone that the user should review (choice, reason, what changing it affects). Don't repeat binding §8 requirements.
