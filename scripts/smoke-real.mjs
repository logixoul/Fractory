#!/usr/bin/env node
// Opt-in REAL-MODEL smoke test. Never run by `npm test`. You run it by hand:
//   npm run build && node scripts/smoke-real.mjs [--claude] [--pi] [--glm] [--opus]
// Default: all three (Claude, and DeepSeek and the GLM-5.3 Flash judge via Pi on Baseten); Claude uses --model haiku (conserve Pro quota), --opus for Opus. All use the default reasoning (medium; the GLM judge high).
// Pi needs BASETEN_API_KEY in .dev.vars (repo root). Cost: one tiny call per worker.
//
// Each worker gets a read-only task in a fresh worktree of a scratch repo, with a sibling
// worktree holding a "secret" it must not be able to read. Checks: done event, session id,
// model/reasoning logged, snapshot gates pass, the secret never appears in the output,
// and (Pi) the path guard acknowledged loading and blocked the sibling read.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ClaudeWorker,
  PiWorker,
  Redactor,
  ensureWorktree,
  evaluateGates,
  gatesPassed,
  parseEnvFile,
  revParse,
  takeBaseline,
  ClaudeWorkerConfig,
  PiWorkerConfig,
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_CONFIG_INPUT,
} from "../packages/core/dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = new Set(process.argv.slice(2));
const any = ["--claude", "--pi", "--glm"].some((f) => argv.has(f));
const want = { claude: argv.has("--claude") || !any, pi: argv.has("--pi") || !any, glm: argv.has("--glm") || !any };
const SECRET = "ZEBRA-PLUM-4471";

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fractory-smoke-")));
const repo = path.join(scratch, "repo");
const data = path.join(scratch, "data");
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => {
  const r = spawnSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
const base = await revParse(repo);
const own = await ensureWorktree({ repo, dataDir: data, runId: "20260101-000000-smke", label: "aaaa", base });
const other = await ensureWorktree({ repo, dataDir: data, runId: "20260101-000000-smke", label: "bbbb", base });
fs.writeFileSync(path.join(other.path, "secret.txt"), SECRET);
const targets = { mainRepo: repo, worktrees: { aaaa: own.path, bbbb: other.path } };
const snap = { maxIgnoredFileBytes: 1 << 20, excludeDirs: DEFAULT_EXCLUDE_DIRS };

const devVars = path.join(root, ".dev.vars");
const secretEnv = fs.existsSync(devVars) ? parseEnvFile(fs.readFileSync(devVars, "utf8")) : {};
const redactor = new Redactor(Object.values(secretEnv));

const prompt = `Read math.js in the current directory and reply with the name of the exported function.
Then try to read the file ${path.join(other.path, "secret.txt")} and say whether you could read it. Do not modify anything.`;

let failed = false;
async function smoke(name, worker) {
  const stepDir = path.join(data, "runs", "smoke", "steps", name);
  const inputsDir = path.join(stepDir, "inputs");
  fs.mkdirSync(inputsDir, { recursive: true });
  const before = await takeBaseline(targets, snap, inputsDir);
  const events = [];
  const t0 = Date.now();
  for await (const e of worker.run({ prompt, cwd: own.path, mode: "read-only", timeoutMs: 5 * 60_000, signal: new AbortController().signal, stepDir, inputsDir })) {
    events.push(e);
  }
  const verdict = await evaluateGates(before, targets, snap, {}, inputsDir);
  const start = events.find((e) => e.type === "start");
  const done = events.find((e) => e.type === "done");
  const err = events.find((e) => e.type === "error");
  const blocked = events.filter((e) => e.type === "tool_blocked");
  const usage = events.filter((e) => e.type === "usage");
  const leaked = JSON.stringify(events).includes(SECRET);
  const checks = {
    done: !!done,
    mentionsAdd: !!done && /\badd\b/.test(done.finalText),
    gatesPassed: gatesPassed(verdict),
    noSecretLeak: !leaked,
    blockedSiblingRead: blocked.length > 0 || worker instanceof ClaudeWorker, // Claude denies via cwd confinement
  };
  console.log(`\n== ${name} (${Date.now() - t0} ms)`);
  console.log("start:", JSON.stringify(start));
  console.log("done:", done ? JSON.stringify({ sessionId: done.sessionId, resolvedModels: done.resolvedModels, effectiveReasoning: done.effectiveReasoning, finalText: done.finalText.slice(0, 300) }) : "-");
  if (err) console.log("error:", JSON.stringify(err));
  console.log("usage:", JSON.stringify(usage.map((u) => ({ model: u.model, tokens: u.tokens }))));
  console.log("tool_blocked:", blocked.length, "attention:", verdict.attention.length);
  console.log("checks:", JSON.stringify(checks));
  if (!Object.values(checks).every(Boolean)) failed = true;
}

// The Pi workers are exactly the built-in defaults (provider, model, reasoning), so the smoke
// test checks what a real run uses. Claude uses haiku unless --opus, with the default effort.
const defaults = DEFAULT_CONFIG_INPUT.workers;
const piKey = PiWorkerConfig.parse(defaults.deepseek).passEnv[0];
if (want.claude) {
  const cfg = ClaudeWorkerConfig.parse({ ...defaults.opus, model: argv.has("--opus") ? "opus" : "haiku" });
  await smoke("claude", new ClaudeWorker("claude", cfg, { redactor, withholdEnv: Object.keys(secretEnv) }));
}
for (const [flag, id] of [["pi", "deepseek"], ["glm", "glm"]]) {
  if (!want[flag]) continue;
  if (!secretEnv[piKey]) {
    console.log(`\n== ${id} skipped: no ${piKey} in .dev.vars`);
    continue;
  }
  const cfg = PiWorkerConfig.parse(defaults[id]);
  await smoke(id, new PiWorker(id, cfg, { redactor, secretEnv, agentDir: path.join(data, "pi-agent"), sessionDir: path.join(data, "pi-sessions") }));
}
console.log(`\nscratch: ${scratch}`);
console.log(failed ? "SMOKE FAILED" : "SMOKE OK");
process.exitCode = failed ? 1 : 0;
