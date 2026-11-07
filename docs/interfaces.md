# Worker interfaces: verified findings (Milestone 0)

Verified on Windows 11 (Node 24.18.1, git 2.55) on 2026-11-07 with real tiny invocations against a scratch repo. Each section below is verified by hand unless it says *doc-only* or *inferred*. Tool flags change. Re-verify with `claude --help` / `pi --help` after upgrades.

| Tool | Version | Resolved executable (Windows) |
|---|---|---|
| Claude Code | 2.1.251 | `C:\Users\<u>\.local\bin\claude.EXE` (native binary, **not** an npm `.cmd` shim) |
| Pi | 1.5.0 (`@earendil-works/pi-coding-agent`) | `C:\Users\<u>\AppData\Roaming\npm\pi.CMD` (npm shim → `node …\dist\bundle\cli.js`) |

**Resolution:** `cross-spawn` (via `which` + PATHEXT) resolves both correctly with argv arrays. Config keeps `claudePath` / `piPath` overrides. A `.cmd` shim runs through `cmd.exe`. Prompts never go on argv: they go over **stdin** (see §4). That avoids the Windows 32K command-line limit and `cmd.exe` quoting edge cases.

---

## 1. Claude Code (`claude -p`)

### Invocation (verified)
```
claude -p --output-format stream-json --verbose
  --model opus
  --effort <low|medium|high|xhigh|max>    # configured per role; NOT echoed back (see §5)
  --session-id <uuid>            # fresh session with an id we choose
  | -r <uuid>                    # resume that session (same id kept; context retained)
  --tools Read,Grep,Glob --permission-mode dontAsk                    # read-only
  | --tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits   # edit (no Bash, see §8.7)
  --setting-sources ""           # ignore user/project/local settings and CLAUDE.md (auth still works)
  --strict-mcp-config            # no MCP servers (mcp_servers: [])
  --add-dir <stepDir>            # lets Read reach orchestrator-written input files (§4)
  --json-schema '<schema>'       # structured output → result.structured_output
  [--no-session-persistence]     # throwaway calls
  < prompt on stdin
```
- `--verbose` is required with `stream-json` in `-p` mode.
- **Do not use `--bare`.** It forces `ANTHROPIC_API_KEY` auth and never reads OAuth, which breaks the Pro login.
- Auth check: `system/init.apiKeySource === "none"` means the subscription login is in use. The adapter asserts this and fails the step otherwise, so it never silently bills an API key.
- Env scrub: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` are deleted from the child env. Verified that auth still succeeds.
- `--include-partial-messages` adds `stream_event` deltas (token streaming). Optional, for live GUI text.

### Stream (verified sequence)
`system/init` → `rate_limit_event` → `assistant`* / `user`* (tool results) → `result/success|error_*`

```jsonc
{"type":"system","subtype":"init","session_id":"7d3f…","model":"claude-opus-5","permissionMode":"dontAsk",
 "apiKeySource":"none","tools":["Glob","Grep","Read"],"mcp_servers":[],"cwd":"…","claude_code_version":"2.1.251",
 "memory_paths":{"auto":"…\\.claude\\projects\\<cwd-slug>\\memory\\"}, …}

{"type":"rate_limit_event","session_id":"7d3f…","rate_limit_info":{
  "status":"allowed","resetsAt":1794079200,"rateLimitType":"five_hour",
  "overageStatus":"rejected","isUsingOverage":false,
  "unifiedWindows":{"five_hour":{"utilization":0.09,"resetsAt":1794079200},
                    "seven_day":{"utilization":0.23,"resetsAt":1794175200}}}}

{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"C:\\…\\math.js"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…","content":"1\texport function add…"}]}}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"…"}]}}   // may appear

{"type":"result","subtype":"success","is_error":false,"session_id":"7d3f…","result":"<final text>",
 "structured_output":{…},           // only with --json-schema
 "total_cost_usd":0.0516,"num_turns":2,"stop_reason":"end_turn","terminal_reason":"completed",
 "permission_denials":[],"api_error_status":null,
 "usage":{"input_tokens":4,"cache_creation_input_tokens":3865,"cache_read_input_tokens":9285,"output_tokens":290,…},
 "modelUsage":{"claude-opus-5":{…},"claude-haiku-4-5-20251001":{…}}}
```
- `modelUsage` can include **background Haiku calls** besides the main model. Usage gets recorded per model key.
- `total_cost_usd` is an API-equivalent figure. On Pro it is **informational only** (§8.1).

### Quota / rate-limit signal
- Every call emits `rate_limit_event` early (before the first assistant message). It gives `status`, `resetsAt` (**epoch seconds**), `rateLimitType`, and `unifiedWindows.{five_hour,seven_day}.utilization` (0–1).
- `status: "allowed"` was observed. Handling:
  - `allowed` / `allowed_warning` → `rate_limit` WorkerEvent with utilization (GUI header, pre-flight warning §8.11).
  - anything else → **quota exhausted**: `paused_quota` with `resetsAt`.
- Also a quota signal: `result.is_error === true` with `api_error_status` 429, or result text matching `/usage limit|rate limit|limit reached/i`. Use the last seen `resetsAt`.
- *Inferred:* the rejected-status shape wasn't observed (we didn't exhaust quota). The adapter is lenient by design. No retry, ever.

### Structured output (verified)
`--json-schema` makes Claude call a synthetic `StructuredOutput` tool. The parsed object is in `result.structured_output`, and `result.result` holds the same JSON as a string. We still validate it with zod.

### Filesystem scope (verified)
Under `dontAsk`, `Read` of a file **outside the cwd** is denied (`permission_denials[0].tool_name === "Read"`). With `--add-dir <dir>` it succeeds. So Claude's file tools are confined to cwd + `--add-dir`s. The orchestrator snapshots (§8.2) are still the backstop.

### Gotchas
- Claude cites **absolute paths** (`C:\…\testrepo\math.js`) as well as relative ones. The `path:line` validator normalizes absolute → repo-relative and accepts `\` and `/`.
- `result.session_id` equals the `--session-id` we passed. Resume keeps the same id (without `--fork-session`).
- Claude's default system prompt includes env info and **git status** (it mentioned a commit message it hadn't read). The harnesses' built-in system prompts differ by nature. Parity (§6) covers *project context*, not vendor system prompts.

---

## 2. Pi (`pi --mode json`)

### Invocation (verified)
```
pi --mode json
  --provider together --model deepseek-ai/DeepSeek-V4.1-Flash-1017
  --thinking <off|high>               # only levels this model supports (§5)
  --no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files
  --tools read,grep,find,ls           # read-only
  | --tools read,grep,find,ls,write   # read-only + structured output file (§8.5)
  | --tools read,edit,write,grep,find,ls   # edit (no bash/powershell, §8.7)
  --session-dir <fractory-data>/pi-sessions
  [--session <id>]                    # resume by full/partial id
  [--no-session]                      # ephemeral
  < prompt on stdin
env: TOGETHER_API_KEY (from envFile), PI_CODING_AGENT_DIR=<fractory-data>/pi-agent
```
- **Model id:** Pi's catalog lists `deepseek-ai/DeepSeek-V4.1-Flash` (`pi --list-models together`). The spec's `…-Flash-1017` also works. Pi prints `Warning: Model "…-1017" not found for provider "together". Using custom model id.` on stderr and passes it through. Default config uses the spec id; it's configurable.
- **Isolated agent dir:** `PI_CODING_AGENT_DIR` pointing at a fractory-owned dir with `settings.json` = `{"retry":{"enabled":false,"provider":{"maxRetries":0}}}` works with the env key. Pi creates an empty `auth.json` there and does **not** persist the key. This isolates Pi from your personal Pi config and turns off its internal retries.
- **Do not pass prompts as `@file`.** Pi wraps `@file` content in `<file name="…">…</file>`, and the model then treats the instructions as untrusted file content. In the spike it refused, calling it "prompt injection". Prompts go via stdin, which arrives as a plain user message.

### Stream (verified sequence)
```
session → agent_start → turn_start → message_start/end(user)
  → message_start(assistant) → message_update:{thinking_*|text_*|toolcall_*}* → message_end(assistant)
  → tool_execution_start → tool_execution_end → turn_end → (next turn…)
→ agent_end{willRetry} → agent_settled{aborted}
```
```jsonc
{"type":"session","version":3,"id":"01a1b722-95fa-…","timestamp":"…","cwd":"C:\\…\\testrepo"}   // first line, also with --no-session
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"…"},"usage":{…}}
{"type":"tool_execution_start","toolCallId":"call_…","toolName":"find","args":{"pattern":"**/math.js"}}
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"ls","result":{"content":[{"type":"text","text":"…"}]},"isError":false,"durationMs":7}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking",…},{"type":"text","text":"…"}],
  "api":"openai-completions","provider":"together","model":"deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "thinkingLevel":"high","stopReason":"stop",
  "usage":{"input":134,"output":32,"cacheRead":1536,"cacheWrite":0,"reasoning":0,"totalTokens":1702,
  "cost":{"input":0.000402,"output":0.00048,"cacheRead":0.0004608,"cacheWrite":0,"total":0.0013428,"totalFromProvider":false}}}}
{"type":"agent_end","messages":[…],"willRetry":false}
{"type":"agent_settled","aborted":false}
```
- Final text = text parts of the **last assistant `message_end`**. Token usage: sum `message_end(role=assistant).message.usage` across the run. `usage` on `message_update` is cumulative *per response*, so summing it double-counts. `message_end` also appears for `role:"system"`/`"user"`, so filter on role.
- **`usage.cost` is wrong for our model.** The rates it implies are $3/M input, $15/M output, $0.30/M cacheRead (`totalFromProvider:false`, Pi's own catalog guess). Together bills $0.30/M input and $1.20/M output. So it is informational only; cost is computed by the orchestrator (§8.1).
- `message.model` echoes the requested id. `responseModel` / `providerThinkingLevel` are **absent** for Together. The effective `thinkingLevel` is present.
- Session file: `<session-dir>/<timestamp>_<id>.jsonl`. Resuming with `--session <id>` appends to the same file and emits the same `session.id`.

### Errors (verified)
Bad API key → **exit code 0** and:
```jsonc
{"type":"message_end","message":{"role":"assistant","stopReason":"error",
  "errorMessage":"401: {\"message\":\"Invalid API key provided…\",\"code\":\"invalid_api_key\"}"}}
{"type":"agent_end","willRetry":false}
```
So the adapter treats `stopReason ∈ {error, aborted, length}` on the last assistant message as failure. The exit code alone isn't enough. A 429 / `rate limit` in `errorMessage` → `rate_limit` WorkerEvent. *Doc-only:* `auto_retry_start/end` events. Retries are disabled in our agent dir.

### Filesystem scope (verified, important)
Pi's tools are **not confined to the cwd**. `read` and `write` on absolute paths outside the worktree both succeeded. Restricting the tool set is the only real control. The orchestrator snapshots (§8.2) detect writes into the main repo or worktree. A write elsewhere on disk can't be detected, which is one more reason Pi never gets `bash`/`powershell` and gets `write` only in steps that need it.

### Gotchas
- JSONL framing: split on `\n` only (strip a trailing `\r`), **not** Node `readline`, which also splits on U+2028/U+2029 inside JSON strings.
- Windows: Pi's `bash` tool uses Git Bash. The `powershell` tool is Windows-only. Both are excluded by our explicit `--tools` allowlists.

---

## 3. Process lifecycle (verified on Windows)
- `cross-spawn(cmd, argv, {stdio:["pipe","pipe","pipe"]})` + `tree-kill(pid,"SIGKILL")` on timeout killed `pi.cmd → cmd.exe → node.exe` completely. No orphan processes afterwards (checked via `Win32_Process`).
- Killed output ends mid-stream with no terminal event (`agent_settled` / `result`). The adapter treats a missing terminal event as `error{reason:"killed"|"timeout"}`.
- Cancel = tree-kill on all OSes. Pi's orderly SIGTERM shutdown isn't meaningful for `.cmd` trees on Windows.

## 4. Prompt and input transport (verified)
- **Claude:** prompt via stdin (no positional prompt) works with `-p --output-format stream-json`.
- **Pi:** prompt via stdin works in `--mode json` and arrives as a plain user message. `@file` doesn't work for prompts (see §2).
- **Large inputs** (diffs, proposals, critiques, check logs) are written by the orchestrator to `steps/<stepId>/inputs/*.md`. The prompt names their absolute paths, and the agent reads them with its `read`/`Read` tool.
  - Claude needs `--add-dir <stepDir>/inputs`. Verified: denied without it, allowed with it.
  - Pi needs nothing. Its reads are unconfined.
  - Inputs live outside the worktree, so worktree snapshots don't change.

## 5. Model id and reasoning-level logging (verified)

| | Claude | Pi |
|---|---|---|
| Requested | `--model opus` | `--provider together --model <id>` |
| Resolved id | `system/init.model` (`claude-opus-5`) + `result.modelUsage` keys (includes background Haiku) | `message_end.message.{provider,model}` (echo of request; no `responseModel` from Together) |
| Reasoning flag | `--effort low\|medium\|high\|xhigh\|max` | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` |
| Effective level reported? | **No.** `init` has no effort field. We log the requested value. | **Yes**, `message_end.message.thinkingLevel`. For DeepSeek-V4.1-Flash only **`off`** and **`high`** are effective. `minimal/low/medium/max` all clamp to `high`. |

Every step logs `{requestedModel, resolvedModels[], requestedReasoning, effectiveReasoning|null}`.

## 6. Context loading (canary tests, verified)
Distinct markers were planted in the scratch repo's `CLAUDE.md`, the repo `AGENTS.md`, and Pi's agent-dir `AGENTS.md`. Each harness was then asked to report them with **all tools disabled**, so they could only come from loaded context.

| Context source | Claude `--setting-sources ""` | Pi (context files on) | Pi `--no-context-files` |
|---|---|---|---|
| repo `CLAUDE.md` | not loaded | **not loaded** (repo has `AGENTS.md` too; it takes precedence per directory) | not loaded |
| repo `AGENTS.md` | not loaded | loaded | not loaded |
| Pi agent-dir `AGENTS.md` | n/a | loaded | not loaded |
| `~/.claude/CLAUDE.md` (global) | **not loaded** (verified with your approval: with default setting sources the same call *did* load it; file restored to 0 bytes, hash matched) | n/a (Pi doesn't read it) | n/a |

Note: Pi refused to repeat markers labelled "canary token" ("leak-detection markers"), so the markers were phrased as project codenames instead.

**Decision (parity):** both harnesses run with project context **disabled** (Claude `--setting-sources ""`; Pi `--no-context-files` + empty isolated agent dir). The orchestrator injects the **same** project context text into both prompts: the contents of configured files (default: repo-root `AGENTS.md` and `CLAUDE.md` if present), with the injected file list and hashes logged per step.

## 7. Enforcement matrix

| Layer | Claude | Pi |
|---|---|---|
| Tool set, read-only | `--tools Read,Grep,Glob` | `--tools read,grep,find,ls` (+`write` only for the structured-output file) |
| Tool set, edit | `--tools Read,Edit,Write,Glob,Grep` | `--tools read,edit,write,grep,find,ls` |
| Permission | `--permission-mode dontAsk` / `acceptEdits` | n/a (no approval UI in json mode) |
| FS confinement | cwd + `--add-dir` (verified) | **none** (verified) |
| Config isolation | `--setting-sources "" --strict-mcp-config` | `PI_CODING_AGENT_DIR=<own>`, `--no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files` |
| Orchestrator gates | before/after `--porcelain --ignored` snapshots of worktree **and** main repo (§8.2, §8.4) | same |

---

## 8. Requirements from the M0 review (binding for M1/M2)

1. **Cost.** The orchestrator computes cost from token counts × a configured price table per `provider/model` (`input`, `output`, `cacheRead`, `cacheWrite` USD per 1M). The default entry for `together/deepseek-ai/DeepSeek-V4.1-Flash-1017` is $0.30 in / $1.20 out. A missing cacheRead/cacheWrite price defaults to the input price, and that's flagged in the event. Vendor fields (`usage.cost`, `total_cost_usd`) are stored as `vendorReportedCostUsd`, informational only. Claude on Pro: tokens recorded, cost shown as API-equivalent and labelled as such. An unknown model → cost `null` + warning (never a guess).
2. **Out-of-worktree writes.** Before and after **every** step, snapshot `git status --porcelain=v1 -z --ignored --untracked-files=all` for the **main repo** and **every sibling worktree of the run**. Any difference outside what the step is allowed to touch fails the **run**. Allowed means only the worker's own worktree, and only in edit steps.
3. **Destructive git safety.** `reset --hard` / `clean -fdx` / `worktree remove` go through one guarded function. It resolves the target with `fs.realpath` and asserts it's strictly inside `<dataDir>/worktrees/`, case-insensitively on Windows and macOS. It also asserts the target isn't the main repo or one of its ancestors. A unit test asserts it throws for the main repo path, its parent, a sibling outside the data dir, and `..`-traversal and symlink/junction escapes.
4. **Read-only gate = snapshot equality.** It does *not* require `--porcelain` to be empty, because the target repo may already be dirty. Before/after `--porcelain --ignored` snapshots must be identical, and mtime-only changes are ignored. On mismatch the step fails and the worktree is restored to its pre-step checkpoint (§8.8) via the guarded reset.
5. **Pi structured output.** The prompt designates `steps/<id>/out/result.json`, which is outside the worktree. Pi gets `write` for that step (verified: Pi can write there). The gate checks that the worktree snapshot is unchanged and that the file exists. The file is zod-validated. On failure there's **one** repair attempt: resume the same Pi session with the zod error text and the bad file's path. A second failure fails the step. Claude keeps `--json-schema` (`result.structured_output`), validated by the same zod schema with the same single repair attempt.
6. **Context parity.** Per §6: both disabled, and the orchestrator injects identical text. Verified for all sources, including global `~/.claude/CLAUDE.md`.
7. **Edit-mode parity: no shell for either worker.** Edit steps use the toolsets in §7. After implementation the orchestrator runs the configured checks. On failure it resumes the same worker session with the failure output (written to an input file, §4), up to `maxFixIterations` (config, default 2). Every fix iteration is a checkpointed edit step (§8.8).
8. **Edit-step checkpoints.** At the start of every edit step (implement, fix_i, apply), the orchestrator commits the worktree state on the worker branch (`git add -A && git commit --allow-empty -m "fractory: checkpoint <stepId>"`, author `fractory`) and records the sha in a `checkpoint_created` event. Retrying the step = guarded `reset --hard <sha>` + `clean -fdx`, then rerun. After the step, the orchestrator commits the result (`fractory: <stepId> result`).
9. **Model and reasoning logging.** Per §5. Config has explicit `claude.effort` (default `high`) and `pi.thinking` (default `high`; config validation allows only `off|high` for the DeepSeek Flash default and warns otherwise). Both are logged requested-vs-effective per step.
10. **Transport.** Per §4: prompts via stdin. Large inputs go to `steps/<id>/inputs/` files the agent reads (Claude via `--add-dir`).
11. **Pre-flight quota check.** The most recent `rate_limit_info` is persisted to `<dataDir>/quota.json`. At run start, if the last known 5-hour or 7-day utilization ≥ `quota.warnUtilization` (default 0.8) and its `resetsAt` hasn't passed, emit `quota_warning` and print it (CLI) / show it (GUI). On the **first** live `rate_limit_event` of a run the threshold is re-checked. If the config has `quota.abortUtilization` (optional), the run pauses as `paused_quota` instead of continuing.

## 9. Open caveats
- Claude quota-rejected payload not observed live (§1).
- Claude edit-mode writes outside cwd: not spiked (to save quota). Expected denied like reads. Snapshots cover it regardless.
- Line endings: `core.autocrlf=true` on this machine (git warned `LF will be replaced by CRLF`). Diffs use `-c core.autocrlf=false` plus `--ignore-cr-at-eol`, verified in M2 tests.
