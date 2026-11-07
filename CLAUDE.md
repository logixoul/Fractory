# fractory: rules for every session

Local multi-model orchestrator: Opus (Claude Code, Pro subscription) and DeepSeek (Pi + Together) as bounded workers in deterministic workflows (consensus, duel). Full spec: `spec.md`. Verified CLI interfaces: `docs/interfaces.md`.

## Hard architectural rules (do not deviate)
1. **Deterministic control plane.** All workflow logic is explicit TypeScript state machines. No LLM ever decides control flow, phase transitions, or "is it done".
2. **Models are bounded workers** behind the `Worker` adapter interface. One task per invocation, fresh or explicitly resumed by session id.
3. **State lives on disk.** Each run has an append-only `events.jsonl` (source of truth) plus a derived `state.json`. Every step is idempotent and checkpointed. Crash/restart resumes from the last completed step.
4. **Engine is independent of the GUI.** `core` (library) → `cli` and `daemon` (HTTP + SSE) → `web` (Svelte SPA, pure view). The CLI works with no GUI. The GUI never owns subprocesses or state.
5. **First-party, documented interfaces only.** No pi-claude-bridge, pi-claude-code-auth, or any Claude auth/billing shim. Opus runs through Claude Code itself.
6. **Machine-checkable exit conditions** for every phase (file exists, schema validates, git tree clean, checks pass). Never "the model said it's done".

## Non-negotiables
- Never build shell command strings. Spawn with argv arrays (`cross-spawn`). Use `path` everywhere.
- Kill whole process trees (`tree-kill`) on cancel/timeout.
- Claude child env: delete `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`. Never use `claude --bare` (it breaks the subscription login). Assert `apiKeySource === "none"`.
- Never log secrets. All events pass through the redactor. `.dev.vars` is gitignored and must never be committed or printed.
- Worktrees live outside target repos (`<data-dir>/worktrees/<run>/<worker>`). Never merge or push.
- Daemon binds 127.0.0.1 only, uses a per-launch token, validates Host/Origin, no permissive CORS.
- **Conserve Pro quota:** automated tests use `FakeWorker` only. Real-model calls only in the opt-in smoke script.

## Workflow
- Milestones M0–M7 (see `spec.md`). Commit after each with `npm run typecheck && npm test` green, then stop for review.
