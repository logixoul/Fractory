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
- Read-only (`dontAsk`): `Read` of a file **outside the cwd** is denied (`permission_denials[0].tool_name === "Read"`). With `--add-dir <dir>` it succeeds.
- Edit (`acceptEdits`, verified with `--model haiku`): `Write` outside the cwd is **denied**. The tool_result is an error ("Claude requested permissions to write to …"), it shows up in `permission_denials`, and no file is created. A `Write` inside the cwd succeeds.
- So Claude's file tools are confined to cwd + `--add-dir`s. **Don't `--add-dir` a parent of the run's worktrees.** Give only the step's own `inputs/` dir. Snapshots (§8.2, §8.13) remain the backstop.

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
- **Isolated agent dir:** `PI_CODING_AGENT_DIR` pointing at a fractory-owned dir with its own `settings.json` works with the env key. Pi creates an empty `auth.json` there and does **not** persist the key. This isolates Pi from your personal Pi config. (Until 2026-11-09 the settings turned Pi's retries off; see "Retries" below for the current ones.)
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
So the adapter treats `stopReason ∈ {error, aborted, length}` on the last assistant message as failure. The exit code alone isn't enough. A 429 / `rate limit` in `errorMessage` is a transient error (step retry, below).

### Retries (enabled 2026-11-09, by user request: Baseten Basic tier is 15–120 RPM)
Read from Pi 1.5.0's source (`pi-ai/dist/utils/retry.js`, `provider-retry.js`, `core/agent-session.js`) and docs (`settings.md`, `json.md`). Pi has two independent levels, and only one of each requested property is available per level:

| Level | Setting (our agent dir) | Retries | Backoff | Retry-After | Visible in `--mode json` |
|---|---|---|---|---|---|
| Provider (one HTTP request) | `retry.provider.maxRetries: 4`, `maxRetryDelayMs: 60000` | 429, 408, 409, 5xx, connection errors, before the stream starts (`x-should-retry` honored) | exponential 0.5, 1, 2, 4 s (×0.75–1 jitter, cap 8 s) | **yes**: `retry-after-ms`, `retry-after` (seconds or HTTP date); a requested delay above 60 s fails at once with `Server requested Ns retry delay (max: 60s). …` | no |
| Agent (the whole turn) | `retry.enabled: true`, `maxRetries: 4`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60000` | an assistant message with `stopReason:"error"` whose text matches Pi's retryable patterns (429, 5xx, rate limit, overloaded, network, dropped streams, "retry delay"). Quota/billing texts (`insufficient_quota`, `quota exceeded`, `billing`, …) are **not** retried. Context overflow is left to compaction. | exponential 2, 4, 8, 16 s | no (the turn has no headers) | **yes**: `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}`, `auto_retry_end{success,attempt,finalError?}` |

- The adapter maps `auto_retry_start/end` to a `provider_retry` WorkerEvent (`phase: "scheduled"|"finished"`), shown in the CLI progress and the GUI live view. The failed attempt is omitted from the model context by Pi; its `message_end` still arrives and is counted for usage.
- Worst case per turn: (4 + 1) × (4 + 1) = 25 HTTP attempts, over roughly 2–5 minutes.
- **Orchestrator step retry stays the last resort** (`retry.transientMaxRetries`, default 2): a Retry-After found in the final error text (including Pi's `Server requested Ns retry delay` message) is honored, capped at 15 min. Otherwise a rate limit (`429` / `rate limit` / `too many requests`) waits `retry.rateLimitBackoffMs` (60 s, then 120 s), and other transient errors wait `retry.backoffMs` (5 s, then 30 s).
- *Not yet observed with a real call:* the `auto_retry_*` lines (shapes are from `docs/json.md` and the source), and whether Baseten sends `Retry-After` on 429.

### Filesystem scope (verified, important)
Pi's built-in tools are **not confined to the cwd**. Without a guard, `read` and `write` on absolute paths outside the worktree both succeeded. Confinement comes from the **fractory path-guard extension** (§8.12, verified below). Pi never gets `bash`/`powershell`, and gets `write` only in steps that need it.

### Path-guard extension (verified)
Spike source: [`spikes/pi-path-guard.ts`](../spikes/pi-path-guard.ts). Shipped (M2) as [`packages/core/assets/pi-path-guard.ts`](../packages/core/assets/pi-path-guard.ts), with the decision logic exported for unit tests.
- **Loading:** `--no-extensions -e <abs path to .ts>` loads exactly that one extension. Discovery stays off; TypeScript is loaded directly with no build step.
- **Hook:** `pi.on("tool_call", …)` runs before execution and returns `{block:true, reason}`. `event.input` is mutable. The guard canonicalizes the path, checks it, then **rewrites `input.path` to the validated absolute path**, so Pi opens exactly what was checked.
- **Canonicalization** mirrors Pi's `resolveToCwd`: strip a leading `@`, expand `~`, normalize unicode spaces, `path.resolve(cwd, p)`, then `realpath` of the longest existing prefix (defeats symlinks and junctions). Comparison is case-insensitive on win32/darwin.
- **Covers** `read`, `write`, `edit`, `grep`, `find`, `ls`, with a missing `path` treated as `.`. It also rejects grep `glob` / find `pattern` that are absolute, drive-qualified, `~`-prefixed, or contain a `..` segment. Any other tool name is blocked.
- **Config:** env `FRACTORY_PI_GUARD = {"read":[…], "write":[…], "ack", "nonce"}`, which holds paths only and no secrets.
- **Load assertion (M2):** on load the guard writes the per-invocation `nonce` to the `ack` file (in the step dir). The adapter refuses a `done` unless the ack matches, so a Pi run without the guard can never succeed. Missing or invalid config → **every call blocked** (fail closed, verified).
- **Visible in the stream:** a block produces `tool_execution_end{isError:true, result.content[0].text:"fractory path guard: read outside allowlist: <path>"}`. There's no `tool_result` (per docs). The adapter maps these to a `tool_blocked` WorkerEvent and counts them per step.

Verified matrix (Pi in `worktrees/run1/deepseek`, allow read = own worktree + own `inputs/`, write = own `out/result.json`):

| Attempt | Result |
|---|---|
| `read` own worktree `math.js` | ok |
| `read` own step `inputs/brief.md` | ok |
| `read` sibling `…/run1/opus/plan.md` (absolute) | **blocked** |
| `read ../opus/plan.md` (relative) | **blocked** |
| `ls ..` | **blocked** |
| `grep SECRET` with `path` = `worktrees/run1` | **blocked** |
| `write` own `out/result.json` | ok (file content `{"ok":true}`) |
| `write hacked.txt` (in worktree, read-only step) | **blocked** |
| `read link/plan.md` where `link` is a junction in the own worktree → sibling | **blocked** (realpath) |
| `ls link` (same junction) | **blocked** |
| any call with `FRACTORY_PI_GUARD` unset | **blocked** (fail closed) |

Residual: recursive `grep`/`find` on an allowed dir may traverse a symlink inside it. Mitigation: the snapshot step (§8.13) lists symlinks/junctions in worktrees, and the run refuses to start a step if any of them points outside the worktree.

### Gotchas
- JSONL framing: split on `\n` only (strip a trailing `\r`), **not** Node `readline`, which also splits on U+2028/U+2029 inside JSON strings.
- Windows: Pi's `bash` tool uses Git Bash. The `powershell` tool is Windows-only. Both are excluded by our explicit `--tools` allowlists.

### Provider switch to Baseten (2026-11-09, by user request)
The spec named Together; the default provider is now **Baseten**. Everything above was verified on Together. Baseten is a different backend behind the same Pi interface, so the invocation, guard, stream parsing and gates are unchanged.

| | Status |
|---|---|
| Pi provider id `baseten`, key env `BASETEN_API_KEY` | verified: `pi --list-models baseten` lists the catalog once the key is set |
| Model ids `deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast` (contestant), `zai-org/GLM-5.3-Flash` (judge) | verified in Pi's catalog and in Baseten's `GET https://inference.baseten.co/v1/models` |
| Prices, USD per 1M (from `/v1/models` `pricing`) | DeepSeek V4.1 Flash 1017 Fast: input 0.60, output 2.40, cache read 0.014. GLM-5.3 Flash: input 0.15, output 0.50, cache read 0.03. No cache-write price listed. |
| "Fast" variants | Baseten docs: same weights, dedicated capacity for higher throughput, separate price (2× here) and rate limits; falls back to base capacity when Fast capacity is unavailable |
| Stream shape, `usage`, `message_end.provider` = `baseten` | verified (user's smoke run 2026-11-09; guard, gates and caching OK). `message_end` also carries `durationMs`, `responseId`, `rawStopReason`. `stopReason: "error"` on Baseten not yet observed. |
| Supported reasoning levels (Pi catalog `thinkingLevelMap`) | DeepSeek V4.1 Flash 1017 (Fast): off(`none`)/low/medium/high/max. GLM-5.3 Flash: **low/high/max** only (no off; Pi sends `high` for medium). Sent as `reasoning_effort` (captured payload). Defaults: DeepSeek `medium`, judge `high` (explicit). |
| Effective reasoning | verified: `thinkingLevel` = the level Pi sent (`medium` for DeepSeek; `high` for GLM when `medium` was requested). A requested ≠ effective level is a config warning (known models) and a `reasoning_level_mismatch` run warning. |
| Rate limits | Baseten tiers (docs): Basic 15–120 RPM / 100k–500k TPM, Pro 120 RPM / 1M TPM. Handled by Pi's retries, then the step retry (see "Retries"). |

### Baseten reasoning tokens (probe 2026-11-09, by user request)
Question: `usage.reasoning` was 0 for both models in the smoke run, while the GLM run took 75 s for ~140 visible output tokens. Are reasoning tokens hidden, unreported or unbilled?

**Smoke run, from the raw streams** (`fractory-smoke-10Mzg6`). The raw files have no per-line receive times, so time to the first text delta can't be measured from them. Pi's per-message `durationMs` and message timestamps give the rest:

| Call | Spawn → `session` | Turn 1 (`durationMs`) | Turn 2 | Total (spawn → last write) | Thinking content | Output tokens (turn 1 + 2) | `reasoning` |
|---|---|---|---|---|---|---|---|
| DeepSeek, medium | 0.45 s | 6.99 s (text + 2 tool calls) | 0.39 s | ~7.6 s | none (no `thinking_*` events) | 213 + 94 | 0 + 0 |
| GLM, medium → high | 0.32 s | **72.8 s** (2 tool calls) | 1.79 s | ~75 s | none | 84 + 57 | 0 + 0 |

**Direct requests.** The probe captured Pi's exact request payload with a `before_provider_request` extension, then replayed the first turn to `https://inference.baseten.co/v1/chat/completions`. The payload was `stream: true`, `stream_options.include_usage`, `max_tokens` = catalog max and `reasoning_effort`, with the smoke prompt, 4 tools and the system prompt. Script: session scratchpad `probe/probe.mjs`; the key came from `.dev.vars` and was never printed.

| Model, `reasoning_effort` | Headers | First reasoning delta | First content / tool delta | Total | Reasoning chars | `completion_tokens` | `reasoning_tokens` |
|---|---|---|---|---|---|---|---|
| DeepSeek, `none` | 0.75 s | – | 0.75 s | 0.79 s | 0 | 187 | 0 |
| DeepSeek, `medium` (as Pi) | 1.22 s | – | 1.22 s | 1.26 s | 0 | 188 | 0 |
| DeepSeek, `high` | 0.47 s | – | 0.47 s | 0.54 s | 0 | 188 | 0 |
| DeepSeek, omitted | 1.26 s | – | 1.26 s | 1.35 s | 0 | 188 | 0 |
| GLM, `low` | 1.12 s | – | 1.13 s | 1.26 s | 0 | 70 | 0 |
| GLM, `high` (as Pi) | 0.56 s | – | 0.56 s | 2.09 s | 0 | 70 | 0 |
| GLM, `max` | 0.43 s | 0.43 s | 2.24 s | 2.78 s | 473 | 170 | **100** |
| GLM, omitted | 5.68 s | 6.64 s | 7.66 s | 13.32 s | 35 | 78 | 8 |

Pi's own runs during the probe (same prompt, Pi defaults then) gave these turn durations: DeepSeek 1.1 s, 1.0 s and 0.6 s (turn 2 had 52 chars of thinking, `reasoning: 11`); GLM 5.2 s and 1.0 s (`reasoning: 0`).

Each `usage` object had `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details{cached_tokens,audio_tokens[,image_tokens]}` and `completion_tokens_details{reasoning_tokens,accepted_prediction_tokens,rejected_prediction_tokens,audio_tokens}`. The prediction fields come from speculative decoding.

Findings:
- **Reported by Pi:** yes. Pi's `usage.output` = Baseten's `completion_tokens`, and `usage.reasoning` = `completion_tokens_details.reasoning_tokens` (DeepSeek: 11 in a Pi turn with visible thinking).
- **Included in `output`:** yes. With GLM at `max`, 100 of 170 completion tokens were reasoning; the visible tool calls account for ~70.
- **Billed:** inferred, not checked against an invoice. Baseten bills output by `completion_tokens`, which includes reasoning, so fractory's cost (tokens × price) already includes it. No estimate is needed, and no `estimated` cost flag was added.
- **The 75 s GLM turn was not hidden reasoning.** It reported 0 reasoning tokens and no reasoning deltas, for 84 output tokens. The same request answered in 0.56–2.1 s directly and in 5.2 s through Pi, and one direct call waited 5.7 s just for response headers. Most likely provider-side queueing or a cold start on Baseten's shared capacity; the probe didn't pin this down.
- **DeepSeek `medium` vs `none`/`high`:** no measurable difference on this prompt (0 reasoning tokens and the same 187–188 completion tokens at every level). The prompt is trivial, so the model may simply not think on it. A harder prompt is needed to see whether the level matters.
- **GLM `high` vs `low`:** no difference on this prompt either. Only `max` produced visible reasoning here.

## 2a. OpenAI through Pi (review workflow reviewer, 2026-11-09)

The review workflow's default reviewer is `gpt-6.1-sol` via Pi's built-in `openai` provider: same adapter, same path guard, same gates. **Not yet verified with a real call.** Everything below comes from Pi 1.5.0's bundled sources; run `npm run smoke -- --gpt` to verify.

| | Source / status |
|---|---|
| Provider id `openai`, key env `OPENAI_API_KEY` | Pi source (`pi-ai/dist/env-api-keys.js`, `providers/openai.js`). `pi --list-models` lists nothing without a key in the agent dir, so the catalog was read from `pi-ai/dist/providers/data/openai.json`. |
| Model `gpt-6.1-sol`, `api: "openai-responses"`, context 272k, max output 128k | Pi catalog |
| Reasoning (`thinkingLevelMap`) | off/minimal → `null` (not sent); low/medium/high/xhigh/max → the same `reasoning.effort`. Default `medium`. |
| Prices, USD per 1M | input 2, output 10, cache read 0.10 (prompts ≤ 272k). Pi's catalog agrees with third-party trackers (pricepertoken.com, getdeploying.com). **Not checked on openai.com** (developers.openai.com/api/docs/pricing); one tracker listed a different cache rate. Pi's catalog also has a cache-write price (2.5); OpenAI's caching is automatic, so fractory sets none, and a non-zero `cacheWrite` count would make the cost unknown, not guessed. |
| Stream shape, `usage`, `thinkingLevel`, `stopReason: "error"` on OpenAI | not observed; assumed to match §2 (Pi normalizes providers) |

The worker's `passEnv` is `["OPENAI_API_KEY"]`. That filter applies to the **shell** environment only. Every value from `envFile` is passed to every Pi worker (unchanged behaviour), so with both keys in `.dev.vars`, all three Pi workers receive both. Claude and the checks receive neither. See `docs/decisions-todo.md`, "Review workflow".

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
  - Pi: the path-guard read allowlist must include the step's own `inputs/` dir (§8.12). Anything not on the allowlist is blocked.
  - Input integrity: `inputs/` is hashed before and after every step (§8.19).
  - Inputs live outside the worktree, so worktree snapshots don't change.

## 5. Model id and reasoning-level logging (verified)

| | Claude | Pi |
|---|---|---|
| Requested | `--model opus` | `--provider together --model <id>` |
| Resolved id | `system/init.model` (`claude-opus-5`) + `result.modelUsage` keys (includes background Haiku) | `message_end.message.{provider,model}` (echo of request; no `responseModel` from Together) |
| Reasoning flag | `--effort low\|medium\|high\|xhigh\|max` | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` |
| Effective level reported? | **No.** `init` has no effort field. We log the requested value. | **Yes**, `message_end.message.thinkingLevel`. On Together, for DeepSeek-V4.1-Flash only **`off`** and **`high`** are effective; `minimal/low/medium/max` all clamp to `high`. For the Baseten models, see §2 "Provider switch to Baseten". |

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
| FS confinement | cwd + `--add-dir` (verified, read and write) | path-guard extension allowlist (verified). None without it. |
| Config isolation | `--setting-sources "" --strict-mcp-config` | `PI_CODING_AGENT_DIR=<own>`, `--no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files` |
| Orchestrator gates | before/after `--porcelain --ignored` snapshots of worktree **and** main repo (§8.2, §8.4) | same |

---

## 8. Requirements from the M0 review (binding for M1/M2)

1. **Cost.** The orchestrator computes cost from token counts × a configured price table per `provider/model` (`input`, `output`, `cacheRead`, `cacheWrite` USD per 1M). Default entries for `together/deepseek-ai/DeepSeek-V4.1-Flash-1017` **and** `together/deepseek-ai/DeepSeek-V4.1-Flash`: **input $0.30, output $1.20, cacheRead $0.006** per 1M. Source: together.ai/pricing "Serverless Inference" table and together.ai/models/deepseek-v4-1-flash, checked 2026-11-07. Together lists no cache-write price, and Pi reported `cacheWrite: 0` in all spikes. Entries carry a `source`/`checkedAt` field. A missing price component makes the cost `null` with a warning (no guessing). Vendor fields (`usage.cost`, `total_cost_usd`) are stored as `vendorReportedCostUsd`, informational only. Claude on Pro: tokens recorded, cost shown as API-equivalent and labelled as such. An unknown model → cost `null` + warning (never a guess).
2. **Out-of-worktree writes.** Before and after **every** step, snapshot `git status --porcelain=v1 -z --ignored --untracked-files=all` for the **main repo** and **every sibling worktree of the run**. Allowed changes: only the worker's own worktree, only in edit steps. Snapshot entries include content hashes (§8.13). How a difference is handled depends on where it is (§8.14): main repo → `needs_attention`; any worktree → hard failure.
3. **Destructive git safety.** `reset --hard` / `clean -fdx` / `worktree remove` go through one guarded function. It resolves the target with `fs.realpath` and asserts it's strictly inside `<dataDir>/worktrees/`, case-insensitively on Windows and macOS. It also asserts the target isn't the main repo or one of its ancestors. A unit test asserts it throws for the main repo path, its parent, a sibling outside the data dir, and `..`-traversal and symlink/junction escapes.
4. **Read-only gate = snapshot equality.** It does *not* require `--porcelain` to be empty, because the target repo may already be dirty. Before/after snapshots (porcelain line + content hash, §8.13) of the step's worktree must be identical. Content-identical rewrites compare equal. On mismatch the step fails and the worktree is restored to its pre-step checkpoint (§8.8) via the guarded reset.
5. **Pi structured output.** The prompt designates `steps/<id>/out/result.json`, which is outside the worktree. Pi gets `write` for that step (verified: Pi can write there). The gate checks that the worktree snapshot is unchanged and that the file exists. The file is zod-validated. On failure there's **one** repair attempt: resume the same Pi session with the zod error text and the bad file's path. A second failure fails the step. Claude keeps `--json-schema` (`result.structured_output`), validated by the same zod schema with the same single repair attempt.
6. **Context parity.** Per §6: both disabled, and the orchestrator injects identical text. Verified for all sources, including global `~/.claude/CLAUDE.md`.
7. **Edit-mode parity: no shell for either worker.** Edit steps use the toolsets in §7. After implementation the orchestrator runs the configured checks. On failure it resumes the same worker session with the failure output (written to an input file, §4), up to `maxFixIterations` (config, default 2). Every fix iteration is a checkpointed edit step (§8.8).
8. **Edit-step checkpoints.** At the start of every edit step (implement, fix_i, apply), the orchestrator commits the worktree state on the worker branch (`git add -A` + the hook-free commit of §8.17 with `--allow-empty -m "fractory: checkpoint <stepId>"`) and records the sha in a `checkpoint_created` event. Retrying the step = guarded `reset --hard <sha>` + `clean -fdx`, then rerun. After the step, the orchestrator commits the result (`fractory: <stepId> result`).
9. **Model and reasoning logging.** Per §5. Config has explicit `claude.effort` (default `high`) and `pi.thinking` (default `high`; config validation allows only `off|high` for the DeepSeek Flash default and warns otherwise). Both are logged requested-vs-effective per step.
10. **Transport.** Per §4: prompts via stdin. Large inputs go to `steps/<id>/inputs/` files the agent reads (Claude via `--add-dir`).
11. **Pre-flight quota check.** The most recent `rate_limit_info` is persisted to `<dataDir>/quota.json`. At run start, if the last known 5-hour or 7-day utilization ≥ `quota.warnUtilization` (default 0.8) and its `resetsAt` hasn't passed, emit `quota_warning` and print it (CLI) / show it (GUI). On the **first** live `rate_limit_event` of a run the threshold is re-checked. If the config has `quota.abortUtilization` (optional), the run pauses as `paused_quota` instead of continuing.

12. **Pi path guard.** Every Pi invocation loads the fractory path-guard extension (`--no-extensions -e <asset>`; §2 "Path-guard extension"), with an allowlist built per step:
    - read: own worktree + own `steps/<id>/inputs/`
    - write: own worktree (edit steps only) and/or the step's designated `out/result.json`
    - never the sibling worktree, the main repo, or other steps' dirs.

    This makes duel/consensus **independence** enforceable as well as safe: a worker cannot read the other's proposal or code before the critique step hands it over as an input file. The adapter asserts the extension is loaded on every run. It counts `tool_blocked` events, logs them, and surfaces the count to the GUI. Blocks are not failures by themselves; the gates decide. Unit tests (no model) exercise the guard's `canonical`/`inside` logic directly: traversal, junction/symlink, case, `@`/`~` prefixes, glob escapes, fail-closed.
13. **Content-aware snapshots.** A snapshot is a map `path → {porcelainXY, hash}` from `git status --porcelain=v1 -z --ignored --untracked-files=all`.
    - Hashes: `git hash-object` for modified/untracked files, batched via `--stdin-paths`. Ignored files are hashed only up to `snapshot.maxIgnoredFileBytes` (default 1 MiB). Larger files are recorded as `{size, mtimeMs}` instead.
    - `snapshot.excludeDirs` (default `node_modules`, `.venv`, `dist`, `build`, `target`, `.next`, `.turbo`) skips ignored dirs wholesale. An excluded dir is recorded as present/absent only.
    - **Documented blind spot:** changes inside excluded dirs, and same-size same-mtime changes to oversized ignored files, are not detected.
    - The snapshot also records symlinks/junctions in worktrees and their targets (see §2 residual).
    - Snapshot equality = same key set and same `{XY, hash}` per key.
14. **Snapshot failure policy.**
    - **Main repo changed during a step** (you edit it concurrently): the step's own result stands, and the run moves to `needs_attention` with the changed-file list (path, before/after XY and hash). `fractory resume <id>` continues and `fractory cancel <id>` aborts (GUI: Continue/Abort buttons). The main-repo baseline is re-taken on continue.
    - **Unexpected change in any worktree** fails the step hard: a change in a read-only step, any change to the *other* worker's worktree, or a change outside the allowed set. The offending worktree is restored via the guarded reset to its checkpoint (§8.8, §8.15).
15. **Per-repo setup.** Config `setup: {argv: string[], timeoutMs, env?}[]` (e.g. `["npm","ci"]`). It runs in each worktree after creation and after **every** guarded clean. `preserveOnClean: string[]` patterns are passed as `git clean -fdx -e <pattern>…` (e.g. keep `node_modules/` and skip setup time). Setup output is stored in the step dir. A non-zero exit is an **environment error**: the run fails as `env_error` with the log tail. It is never fed to a worker as a check failure, and it never counts toward `maxFixIterations`.

16. **Neutral identities at the source.**
    - Each run assigns every worker a random label (4 hex chars, unique within the run, e.g. `a7f2`). Worktree dirs are `<dataDir>/worktrees/<runId>/<label>`, branches are `fractory/<runId>/<label>`, and step ids use the label.
    - The label→worker mapping lives **only** in run state (`run_created` event). It is never written into worktrees, branch names, commit messages or judge inputs.
    - All cited paths (`path:line` refs, absolute paths in prose) are normalized to **repo-relative** before any judge input is written, so no worktree path leaks a label or a data-dir layout.
    - **Anonymization scrubs prose only**: proposals, critiques, revisions, commit messages, `Co-Authored-By:` trailers. **Code inside diffs is never rewritten.** Diffs are passed verbatim except for the path normalization above, which comes for free since `git diff` paths are already repo-relative.
    - Default patterns are unambiguous only, case-insensitive with word boundaries: `Claude`, `Anthropic`, `DeepSeek`, `Opus`, `pi-coding-agent`, plus every configured model id (`claude-opus-*`, `deepseek-ai/…`). Bare `Pi` and `Together` are **not** defaults (too ambiguous: π, "together"). Each match → `[agent]`. Patterns are configurable.
    - The **leak check** runs on scrubbed prose only and fails the judge step if any pattern still matches. Rewrites are logged with counts but no content.
17. **Orchestrator commits are hook- and signing-free.** Every commit fractory makes (checkpoints, step results) uses `git -c core.hooksPath=<dataDir>/empty-hooks -c commit.gpgsign=false -c user.name=fractory -c user.email=fractory@localhost commit --no-verify …`. `<dataDir>/empty-hooks` is created empty at startup. Unit test: a temp repo with a failing `pre-commit` hook, a failing `commit-msg` hook, and `commit.gpgsign=true` (with no key) still gets the orchestrator commit, with author `fractory <fractory@localhost>`.
18. **Check runs never touch branches.** After each check run (build/test/lint) in a worktree, the orchestrator does a guarded `reset --hard <post-step commit>` + `clean -fdx -e <preserveOnClean>…`, then runs `setup` if the clean removed anything setup produces (§8.15). Files the checks produce (coverage, reports, snapshots) are copied into `steps/<id>/artifacts/` first, when they match `checks[].artifacts` globs. They are never committed to the worker branch. The snapshot after the reset must equal the post-step snapshot.
19. **Input integrity.** `steps/<id>/inputs/` is hashed (sorted list of relative path + sha256) before and after each step. Any difference (changed, added or removed file) is a **hard step failure** for both workers. Claude can reach it via `--add-dir`, and Pi via its guard's read allowlist, which is read-only for that dir. The out file lives in `steps/<id>/out/`, which is separate from `inputs/`.

### Minor requirements
- **Judge/report diffs are always squashed** `git diff <base>..HEAD` of the worker branch (with `-c core.autocrlf=false --ignore-cr-at-eol`, binary marked as such). Per-checkpoint commits never reach the judge.
- **Anonymize judge inputs.** Superseded by §8.16.
- **Spikes use `--model haiku`** for Claude from now on (recorded in CLAUDE.md). The opt-in smoke script defaults to haiku as well, with `--model opus` behind a flag.

## 9. Open caveats
- Parallel edit stages (duel implement/fix): a write into the sibling worktree is indistinguishable from the sibling's own edits by snapshots; isolation there relies on harness confinement (Pi guard, Claude cwd confinement). See docs/decisions-todo.md M4.
- Claude quota-rejected payload not observed live (§1).
- Path-guard residual: recursive tools may follow links inside an allowed dir (§2). Mitigated by the snapshot symlink check (§8.13).
- Snapshot blind spots for excluded dirs and oversized ignored files (§8.13).
- Line endings: `core.autocrlf=true` on this machine (git warned `LF will be replaced by CRLF`). Diffs use `-c core.autocrlf=false` plus `--ignore-cr-at-eol`, verified in M2 tests.
