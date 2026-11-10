# fractory

A local orchestrator that runs two coding agents from different model families on your repository, under a deterministic control plane:

- **Opus** through Claude Code, on your Claude Pro subscription (no Anthropic API key).
- **DeepSeek V4.1 Flash** (LithosAI's "Ultra" tier) through the Pi coding agent, on LithosAI.

The duel's default judge is **GLM-5.3 Flash** (Baseten, via Pi), a third model family. The review workflow's default reviewer is **GPT-6.1 Sol** (OpenAI API, via Pi). **Consensus has its own lineup:** GPT-6.1 Sol and DeepSeek V4.1 Flash Ultra (the same LithosAI model as the duel's, worker `deepseek-std`) write the proposals, and Opus judges (effort medium). Opus and GPT use medium reasoning by default. DeepSeek and the GLM judge use high: LithosAI runs medium as high, and GLM-5.3 Flash has no medium level.

It has three workflows:

- **review** (the default of `fractory run`): Opus implements the task in a git worktree and your checks run, with fix rounds. A reviewer from a different model family then reviews the change. Each finding cites `path:line` refs and can come with a test file. fractory runs those tests itself: a failing test *confirms* the finding, a passing one *refutes* it. Opus answers each finding (fix it, or reject it with reasoning), and the reviewer withdraws or maintains each one in one rebuttal round. You decide the remaining disagreements: apply or dismiss.
- **consensus**: both agents write a design proposal grounded in your code, critique each other's, revise, and an anonymous judge writes a decision with evidence and a list of unresolved disagreements. Read-only.
- **duel**: both agents implement the same task in separate git worktrees, your checks run (with fix rounds), an anonymous judge compares the two, you approve the items you want, and Opus applies them to its branch. fractory never merges or pushes; the branches are left for you.

Workflow logic is plain TypeScript state machines. A model never decides what happens next or whether something is done; every phase ends on a machine-checked condition. Every run is an append-only event log on disk, so it can be resumed after a crash, a quota pause or an approval.

Designed for Windows 11, Linux and macOS. The M7 checks have been run locally on Windows;
the Linux and macOS CI jobs have not yet been verified.

## Requirements

- **Node.js 22.19 or newer** and **git**.
- **Claude Code** (`claude`), logged in with your Pro subscription. fractory never uses `--bare` or an API key. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from Claude's environment, and refuses to run unless Claude reports the subscription login.
- **Pi** (`npm install -g @earendil-works/pi-coding-agent`), a **LithosAI API key** (`LITHOS_API_KEY`, for DeepSeek) and a **Baseten API key** (`BASETEN_API_KEY`, for the GLM judge). Baseten is one of Pi's built-in providers. LithosAI isn't: fractory defines it in the `models.json` of its own Pi agent dir (`<data dir>/pi-agent`), which it keeps in sync before every Pi call.
- For the review workflow's default reviewer: an **OpenAI API key** (`OPENAI_API_KEY`), also used through Pi.
- For the GUI: any current browser.

## Install

```sh
git clone https://github.com/logixoul/Fractory.git
cd Fractory
npm install
npm run build
npx fractory --help          # from inside the clone
# or, to put `fractory` on your PATH:
cd packages/cli && npm link
```

The `npm link` option has not yet been verified; it modifies your global npm installation.

## Configure

fractory merges, in increasing order of precedence: built-in defaults, the **global** `fractory.config.json`, and `fractory.config.json` in the **target repository**.

| OS | Global config dir | Data dir (runs, worktrees) |
|---|---|---|
| Windows | `%APPDATA%\fractory\Config` | `%LOCALAPPDATA%\fractory\Data` |
| macOS | `~/Library/Preferences/fractory` | `~/Library/Application Support/fractory` |
| Linux | `~/.config/fractory` | `~/.local/share/fractory` |

Override them with `FRACTORY_CONFIG_DIR` / `FRACTORY_DATA_DIR`, or `--config-dir` / `--data-dir`.
On Linux, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` replace the respective default parent directories.

The LithosAI, Baseten and OpenAI keys come either from your shell environment (`LITHOS_API_KEY`, `BASETEN_API_KEY`, `OPENAI_API_KEY`) or from a dotenv file named by `envFile`. A relative `envFile` path is resolved against the config file that declares it. Each Pi worker gets only the keys in its `passEnv`; it never reaches Claude, your checks, or any log.

A typical global config:

```jsonc
{
  "envFile": "C:/Users/me/secrets/fractory.vars"
}
```

A per-repo config, with checks (duel and review) and the review's test command:

```jsonc
{
  "setup": [{ "argv": ["npm", "ci"] }],
  "preserveOnClean": ["node_modules/"],
  "checks": [
    { "name": "typecheck", "argv": ["npm", "run", "typecheck"] },
    { "name": "test", "argv": ["npm", "test"], "artifacts": ["coverage/**"] }
  ],
  "duel": { "maxFixIterations": 2 },
  "review": { "testCommand": { "argv": ["npx", "vitest", "run", "{testFile}"] } }
}
```

Other options you may want:

| Key | Default | Meaning |
|---|---|---|
| `workers.opus` | `{ "kind": "claude", "model": "opus", "effort": "medium" }` | Claude worker |
| `workers.deepseek` | `{ "kind": "pi", "provider": "lithos", "model": "deepseek-ai/DeepSeek-V4.1-Flash-ultra", "thinking": "high", "passEnv": ["LITHOS_API_KEY"] }` | Pi worker (effective levels on LithosAI: off/low/high/max) |
| `workers.glm` | `{ "kind": "pi", "provider": "baseten", "model": "zai-org/GLM-5.3-Flash", "thinking": "high" }` | Pi worker used as judge (levels: low/high/max) |
| `workers.gpt` | `{ "kind": "pi", "provider": "openai", "model": "gpt-6.1-sol", "thinking": "medium", "passEnv": ["OPENAI_API_KEY"] }` | Pi worker: review reviewer, consensus contestant |
| `workers.deepseek-std` | same as `workers.deepseek` | Pi worker: consensus contestant |
| `workers.<id>.family` | inferred | model family (`anthropic`, `openai`, `deepseek`, ...); set it when it can't be inferred from the provider or model id |
| `roles` | `{ "contestants": ["opus", "deepseek"], "judge": "glm", "implementer": "opus", "reviewer": "gpt" }` | duel: who competes and judges; review: who implements and reviews (reviewer and implementer must be different families) |
| `review` | `{ "maxRounds": 1, "maxFixIterations": 2, "maxFindings": 30 }` | rebuttal rounds; fix rounds after each edit; findings cap |
| `review.testCommand` | unset | `{ "argv": [..., "{testFile}"], "failExitCodes": [1], "requireFileInOutput": true }`: runs one reviewer test. Exit 0 = refuted, a failure code = confirmed, anything else (or output that doesn't name the file) = error. Without it, reviewer tests aren't run. |
| `consensus` | `{ "maxRounds": 1, "minRefs": 3, "contestants": ["gpt", "deepseek-std"], "judge": "opus" }` | revision rounds; required `path:line` refs per proposal; consensus lineup (instead of `roles`) |
| `judge.swapOrderPass` | `true` | judge a second time with A/B swapped (doubles judge calls). Duel: keep only items both passes credit to the same side. Consensus: keep decisions the second pass also adopts; a different attribution only marks them "attribution unstable" |
| `duel.applyWorker` | first contestant | whose session applies the approved items |
| `retry` | `{ "transientMaxRetries": 2, "backoffMs": [5000, 30000], "rateLimitBackoffMs": [60000, 120000] }` | step retries after 5xx / network / provider 429 errors, once Pi's own retries are used up; a Retry-After in the error is honoured |
| `quota` | `{ "warnUtilization": 0.8 }` | warn when the last known Claude 5-hour or 7-day usage is above this |
| `timeouts` | `{ "workerMs": 1800000, "judgeMs": 1200000 }` | per worker call |
| `prices` | LithosAI for DeepSeek Ultra; Baseten for GLM-5.3 Flash (and the Baseten DeepSeek builds); OpenAI for GPT-6.1 Sol | USD per 1M tokens, keyed `provider/model`; cost is computed by fractory |
| `contextFiles` | `["AGENTS.md", "CLAUDE.md"]` | repo files injected into both agents' prompts, identically |

Commands in `setup` and `checks` are argument arrays, never shell strings. They get no secret-looking environment variables; pass what they need in their `env`.

## Use

```sh
fractory run       --repo path/to/repo --prompt task.md   # review workflow; --workflow duel|consensus for the others
fractory review    --repo path/to/repo --prompt task.md   # the same, explicitly
fractory consensus --repo path/to/repo --prompt task.md
fractory duel      --repo path/to/repo --prompt task.md
```

All of them print live progress. Exit codes: `0` completed, `1` failed or cancelled, `2` paused (quota, approval, or your repo changed during a step), `64` usage error.

| Command | What it does |
|---|---|
| `fractory runs` | list runs |
| `fractory show <id>` | steps, models, tokens and cost, pauses, warnings, result |
| `fractory approve <id> --items 1,3` | approve judge items of a duel, or the review findings to apply (the rest are dismissed); empty list = none |
| `fractory stats [--json]` | per reviewer, over completed review runs: findings per run, confirmed-bug and refuted rates, accepted/rejected/withdrawn/maintained, applied/dismissed |
| `fractory resume <id>` | continue after approval, quota (`--force` before the reset time), or `needs_attention` |
| `fractory resume <id> --retry-failed` | rerun the failed step of a failed run from its checkpoint |
| `fractory cancel <id>` | stop a run; worker process trees are killed |
| `fractory clean <id>` | remove a finished run's worktrees (branches are kept) |
| `fractory gc --older-than <days>` | clean all finished runs older than N days |
| `fractory serve [--repo <path>] [--port <n>]` | start the local daemon on `127.0.0.1:4000` (`--port 0`: any free port) and open the GUI; `--repo` (default: the current directory, if inside a git repo) is pre-filled in the GUI's new-run form |

Things worth knowing:

- **Workers see your last commit, not your working tree.** fractory warns at run start if the repo has uncommitted changes.
- **Quota.** When Claude reports its usage limit, the run pauses with the reset time and never retries by itself. `fractory resume` continues after the reset.
- **Your repo is never written to.** If it changes while a step runs (you're editing), the run pauses in `needs_attention`. Resume to continue, cancel to stop.
- **Duel results** are branches named `fractory/<run>/<label>` in your repo, plus `report.md`. Labels are random per run, and only the run's state maps them to workers.
- **An implementation that changes nothing forfeits.** The other branch is then the result. In a review run, it fails the run.
- **Review results** are the implementer's branch plus `report.md` with every finding, test result, answer, rebuttal and your decision. The reviewer's test files are never committed to that branch; they run in a separate scratch worktree.

## GUI

`fractory serve` starts the daemon on `127.0.0.1` and opens a single-use login link (valid for 60 s; press Enter in the terminal for a new one). It has these screens:

- **Runs:** status, workflow, repo, times; clean-up of old worktrees.
- **New run:** pick the workflow, the repository and type the prompt, then start. The repository field is pre-filled with the `serve` repo (or the most recent run's), offers earlier runs' repos, and is checked as you type (git repo, branch, uncommitted changes, start warnings). The daemon drives the run, so closing the browser doesn't stop it; stopping the daemon pauses it until `fractory resume`.
- **Live:** the phase strip and one pane per worker, streaming text and tool calls (collapsible; blocked calls marked). Each step shows a timing line: wall time, tool calls and rounds, time in tools vs generation, output (and, where reported, reasoning) tokens, tokens per second of generation. `fractory show` prints the same per step.
- **Compare:** proposals and critiques side by side, or duel diffs side by side (Monaco).
- **Verdict:** judge items with checkboxes, approve and resume, the final report. For a review run: the findings with their test results, answers and rebuttals, and apply/dismiss checkboxes for the remaining disagreements.

A `path:line` reference opens the file in-app at the exact commit it was made against, with the line highlighted. "Open in VS Code" is a secondary action and says which copy it opens.

The header shows the Claude quota windows, and token and cost totals per worker. Claude's figure is labelled "API-equivalent", because Pro isn't metered per token.

The daemon only listens on `127.0.0.1`. It needs a per-launch token on every request, checks `Host` and `Origin`, sends no CORS headers, and never puts the token in a URL.

## Try it with real models

Automated tests never call a model. To check your setup end to end (one tiny call per worker; Claude uses `haiku`):

```sh
npm run smoke                 # Claude, both DeepSeek builds and the GLM-5.3 Flash judge
npm run smoke -- --pi         # only DeepSeek (Fast and 1017)
npm run smoke -- --opus       # use Opus instead of haiku
npm run smoke -- --gpt        # only GPT-6.1 Sol, reviewer and consensus contestant (needs OPENAI_API_KEY)
```

## Develop

```sh
npm run typecheck    # tsc for every package + svelte-check
npm test             # vitest: FakeWorker only, real git in temp repos
npm run e2e          # build, then a Playwright smoke test of the GUI (uses your installed Chrome)
```

The CI workflow is configured to run all three on Windows, Linux and macOS with Node 22 and 24, plus `npm audit`
at the moderate severity threshold.

Read these before changing anything:

- [`CLAUDE.md`](CLAUDE.md): the rules every change must keep.
- [`ARCHITECTURE.md`](ARCHITECTURE.md): how it fits together.
- [`docs/interfaces.md`](docs/interfaces.md): the verified Claude Code and Pi interfaces, and the binding requirements.
- [`docs/decisions-todo.md`](docs/decisions-todo.md): every judgment call and its review status.
