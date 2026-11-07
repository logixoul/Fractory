# Worker interfaces: verified findings (Milestone 0)

Verified on Windows 11 (Node 24.18.1, git 2.55) on 2026-11-07, using real tiny invocations against a scratch repo. Each section below is verified by hand unless it says *doc-only*. Tool flags change. Re-verify with `claude --help` / `pi --help` after upgrades.

| Tool | Version | Resolved executable (Windows) |
|---|---|---|
| Claude Code | 2.1.251 | `C:\Users\<u>\.local\bin\claude.EXE` (native binary, **not** an npm `.cmd` shim) |
| Pi | 1.5.0 (`@earendil-works/pi-coding-agent`) | `C:\Users\<u>\AppData\Roaming\npm\pi.CMD` (npm shim → `node …\dist\bundle\cli.js`) |

**Resolution:** `cross-spawn` (via `which` + PATHEXT) resolves both correctly with argv arrays. Config keeps `claudePath` / `piPath` overrides. A `.cmd` shim runs through `cmd.exe`. `cross-spawn` escapes the arguments, so a prompt is never shell-interpreted. We still pass long prompts via **stdin or a file**, never argv. That avoids the Windows 32K command-line limit and `cmd.exe` quoting edge cases.

---

## 1. Claude Code (`claude -p`)

### Invocation (verified)
```
claude -p --output-format stream-json --verbose
  --model opus
  --session-id <uuid>            # fresh session with an id we choose
  | -r <uuid>                    # resume that session (same id kept; context retained)
  --tools Read,Grep,Glob         # read-only: built-in tool set restricted to these
  | --tools Read,Edit,Write,Glob,Grep  --permission-mode acceptEdits   # edit mode
  --permission-mode dontAsk      # read-only: never prompt; anything not allowed is denied
  --setting-sources ""           # ignore user/project/local settings (auth still works)
  --strict-mcp-config            # no MCP servers (mcp_servers: [])
  --json-schema '<schema>'       # structured output → result.structured_output
  [--no-session-persistence]     # for throwaway calls
  <prompt>
```
- `--verbose` is required with `stream-json` in `-p` mode.
- **Do not use `--bare`.** It forces `ANTHROPIC_API_KEY` auth and never reads OAuth, which breaks the Pro login.
- Auth check: `system/init.apiKeySource === "none"` means the subscription login is in use. The adapter asserts this and fails the step otherwise, so it never silently bills an API key.
- Env scrub: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` are deleted from the child env. Verified that auth still succeeds.
- `--include-partial-messages` adds `stream_event` deltas (token streaming). Optional, for live GUI text.
- Bash in edit mode: not enabled by default. If a repo needs it, config can add `--allowedTools "Bash(npm test*)"`-style patterns. The orchestrator runs the checks itself regardless.

### Stream (verified sequence)
`system/init` → `rate_limit_event` → `assistant`* / `user`* (tool results) → `result/success|error_*`

```jsonc
{"type":"system","subtype":"init","session_id":"7d3f…","model":"claude-opus-5","permissionMode":"dontAsk",
 "apiKeySource":"none","tools":["Glob","Grep","Read"],"mcp_servers":[],"cwd":"…","claude_code_version":"2.1.251", …}

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
 "modelUsage":{…}}
```

### Quota / rate-limit signal
- `rate_limit_event.rate_limit_info.status`: we saw `"allowed"`. Anything else (e.g. `"rejected"`, `"allowed_warning"`) is treated as follows:
  - `allowed_warning` → emit a `rate_limit` WorkerEvent with utilization (GUI header only).
  - any status other than `allowed`/`allowed_warning` → **quota exhausted**: `paused_quota` with `resetsAt` (**epoch seconds**).
- Also a quota signal: `result.is_error === true` with `api_error_status` 429, or result text matching `/usage limit|rate limit|limit reached/i`. Use the last seen `resetsAt` if present.
- Not observed live (we didn't exhaust quota). The rejected-status shape is **inferred**. The adapter is lenient: any non-`allowed*` status pauses the run. No retry, ever.

### Structured output (verified)
`--json-schema` makes Claude call a synthetic `StructuredOutput` tool. The parsed object is in `result.structured_output`, and `result.result` holds the same JSON as a string. We still validate it with zod.

### Read-only enforcement (verified)
`--tools Read,Grep,Glob --permission-mode dontAsk`, asked to create `hacked.txt` → the model reported it had no write tool, `git status --porcelain` stayed empty, `permission_denials: []` (the tool simply doesn't exist). The orchestrator porcelain gate remains the second line of defense.

### Gotchas
- Claude cites **absolute paths** (`C:\…\testrepo\math.js`) as well as relative ones. The `path:line` validator must normalize absolute → repo-relative and accept both `\` and `/`.
- `result.session_id` equals the `--session-id` we passed, and resume keeps the same id (without `--fork-session`).

---

## 2. Pi (`pi --mode json`)

### Invocation (verified)
```
pi --mode json
  --provider together --model deepseek-ai/DeepSeek-V4.1-Flash-1017
  --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp
  --tools read,grep,find,ls           # read-only
  | --tools read,edit,write,grep,find,ls[,bash]   # edit mode
  --session-dir <fractory-data>/pi-sessions
  [--session <id>]                    # resume by full/partial id (verified)
  [--no-session]                      # ephemeral (judge)
  <prompt>
env: TOGETHER_API_KEY (from envFile), PI_CODING_AGENT_DIR=<fractory-data>/pi-agent
```
- **Model id:** Pi's catalog lists `deepseek-ai/DeepSeek-V4.1-Flash` (`pi --list-models together`). The spec's `…-Flash-1017` also works. Pi prints `Warning: Model "…-1017" not found for provider "together". Using custom model id.` on stderr and passes it through, and cost is still computed. Default config uses the spec id. It's configurable.
- **Isolated agent dir** (verified): `PI_CODING_AGENT_DIR` pointing at a fractory-owned dir with `settings.json` = `{"retry":{"enabled":false,"provider":{"maxRetries":0}}}` works with the env key. Pi creates an empty `auth.json` there (it does **not** persist the key). This isolates Pi from the user's personal Pi config and turns off Pi's internal retries, so the orchestrator sees every failure.
- **Prompt from file:** Pi accepts `@file` args. The adapter writes `prompt.md` into the step dir and passes `@<path>`, which avoids argv length/quoting issues.

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
  "stopReason":"stop","usage":{"input":134,"output":32,"cacheRead":1536,"cacheWrite":0,"reasoning":0,"totalTokens":1702,
  "cost":{"input":0.000402,"output":0.00048,"cacheRead":0.0004608,"cacheWrite":0,"total":0.0013428,"totalFromProvider":false}}}}
{"type":"agent_end","messages":[…],"willRetry":false}
{"type":"agent_settled","aborted":false}
```
- Final text = text parts of the **last assistant `message_end`**. Usage/cost: sum `message_end(assistant).message.usage` across the run. `usage` on `message_update` is cumulative *per response*, so summing it double-counts.
- Session file: `<session-dir>/<timestamp>_<id>.jsonl`. Resuming with `--session <id>` appends to the same file and emits the same `session.id`.
- `message_end` also appears for `role:"system"` and `role:"user"`. Filter on `role === "assistant"`.

### Errors (verified)
Bad API key → **exit code 0** and:
```jsonc
{"type":"message_end","message":{"role":"assistant","stopReason":"error",
  "errorMessage":"401: {\"message\":\"Invalid API key provided…\",\"code\":\"invalid_api_key\"}"}}
{"type":"agent_end","willRetry":false}
```
So the adapter must treat `stopReason ∈ {error, aborted, length}` on the last assistant message as failure. The exit code alone isn't enough. A 429 / `rate limit` in `errorMessage` → `rate_limit` WorkerEvent (not quota-paused for Pi by default. Together limits are short. Config decides). Doc-only: `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}` / `auto_retry_end{success,attempt,finalError}`. Disabled in our agent dir.

### Read-only enforcement (verified)
`--tools read,grep,find,ls`, asked to create `hacked.txt` → the model said it has no write tool, porcelain stayed empty. `bash` must **never** be in the read-only tool list, because it can write.

### Gotchas
- JSONL framing: split on `\n` only (strip a trailing `\r`), **not** Node `readline`, which also splits on U+2028/U+2029 inside JSON strings.
- Windows: Pi's `bash` tool uses Git Bash. The `powershell` tool is opt-in (Windows only).

---

## 3. Process lifecycle (verified on Windows)
- `cross-spawn(cmd, argv, {stdio:["ignore"|"pipe","pipe","pipe"]})` + `tree-kill(pid,"SIGKILL")` on timeout killed `pi.cmd → cmd.exe → node.exe` completely. No orphan processes afterwards (checked via `Win32_Process`).
- Killed Pi output ends mid-stream with no `agent_settled`. The adapter treats a missing terminal event as an `error{reason:"killed"|"timeout"}`.
- Orderly cancel: Pi doc says SIGTERM / closing stdin triggers an orderly shutdown. On Windows that's not meaningful for `.cmd` trees, so cancel = tree-kill.

## 4. Read-only enforcement matrix

| Layer | Claude | Pi |
|---|---|---|
| Tool set | `--tools Read,Grep,Glob` | `--tools read,grep,find,ls` |
| Permission | `--permission-mode dontAsk` | n/a (no approval UI in json mode) |
| Config isolation | `--setting-sources "" --strict-mcp-config` | `PI_CODING_AGENT_DIR=<own>`, `--no-extensions --no-skills --no-mcp --no-context-files` |
| Orchestrator gate | `git status --porcelain` empty, else fail + `reset --hard` + `clean -fdx` | same |

## 5. Open caveats
- Claude rejected-quota payload not observed live (see §1). Adapter is lenient by design.
- Context files: `--setting-sources ""` doesn't by itself stop CLAUDE.md discovery from the target repo. That's acceptable, since the target repo's CLAUDE.md is legitimate context. Pi uses `--no-context-files` for parity. That's configurable.
- Line endings: the scratch repo showed git's `LF will be replaced by CRLF` warnings (`core.autocrlf=true` on this machine). Diffs will use `-c core.autocrlf=false` plus `--ignore-cr-at-eol`, verified in M2 tests.
