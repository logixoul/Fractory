import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeWorkerConfig, PiWorkerConfig } from "../src/schemas/config.js";
import { WorkerEvent, type WorkerEventInput } from "../src/schemas/worker-events.js";
import { ClaudeStreamParser, ClaudeWorker, claudeArgs } from "../src/workers/claude.js";
import { PI_GUARD_ASSET, PiStreamParser, PiWorker, piArgs } from "../src/workers/pi.js";
import type { WorkerTask } from "../src/workers/types.js";
import { REDACTED, Redactor } from "../src/util/redact.js";
import { tmpDir } from "./helpers.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_CLI = path.join(FIX, "fake-cli.mjs");

const lines = (name: string) =>
  fs
    .readFileSync(path.join(FIX, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function feed(parser: ClaudeStreamParser | PiStreamParser, name: string): WorkerEventInput[] {
  const out: WorkerEventInput[] = [];
  for (const o of lines(name)) out.push(...parser.record(o));
  for (const e of out) WorkerEvent.parse(e); // every normalized event is schema-valid
  return out;
}

const task = (over: Partial<WorkerTask> = {}): WorkerTask => ({
  prompt: "do it",
  cwd: tmpDir(),
  mode: "read-only",
  timeoutMs: 10_000,
  signal: new AbortController().signal,
  ...over,
});

async function collect(it: AsyncIterable<WorkerEventInput>): Promise<WorkerEventInput[]> {
  const out: WorkerEventInput[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const claudeCfg = ClaudeWorkerConfig.parse({ kind: "claude", command: process.execPath });
const piCfg = PiWorkerConfig.parse({ kind: "pi", command: process.execPath, model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });

describe("Claude argv", () => {
  it("fresh vs resumed session, read-only vs edit, isolation flags, no --bare", () => {
    const fresh = claudeArgs(claudeCfg, task({ inputsDir: "/in", jsonSchema: { type: "object" } }), "uuid-1");
    expect(fresh).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--session-id", "uuid-1"]));
    expect(fresh.join(" ")).toContain("--tools Read,Grep,Glob --permission-mode dontAsk");
    expect(fresh[fresh.indexOf("--setting-sources") + 1]).toBe("");
    expect(fresh).toEqual(expect.arrayContaining(["--strict-mcp-config", "--add-dir", "/in", "--json-schema", '{"type":"object"}']));
    const resumed = claudeArgs(claudeCfg, task({ mode: "edit", sessionId: "s-9" }), "ignored");
    expect(resumed).toEqual(expect.arrayContaining(["-r", "s-9"]));
    expect(resumed).not.toContain("--session-id");
    expect(resumed.join(" ")).toContain("--tools Read,Edit,Write,Glob,Grep --permission-mode acceptEdits");
    for (const a of [fresh, resumed]) {
      expect(a).not.toContain("--bare");
      expect(a.join(" ")).not.toMatch(/Bash|PowerShell/);
      expect(a).not.toContain("do it"); // prompt goes over stdin, never argv
    }
  });
});

describe("Claude stream parser (recorded fixtures)", () => {
  it("normalizes a structured-output run", () => {
    const p = new ClaudeStreamParser({ sessionId: "x", requestedModel: "opus", requestedReasoning: "high" });
    const evs = feed(p, "claude-structured.jsonl");
    expect(evs[0]).toMatchObject({ type: "start", resolvedModel: "claude-opus-5", requestedModel: "opus", requestedReasoning: "high" });
    const rl = evs.find((e) => e.type === "rate_limit");
    expect(rl).toMatchObject({ status: "allowed", resetsAt: 1794079200_000 });
    expect((rl as { windows: Record<string, unknown> }).windows.seven_day).toMatchObject({ utilization: 0.23 });
    expect(evs.some((e) => e.type === "tool_call")).toBe(true);
    const usage = evs.filter((e) => e.type === "usage");
    expect(usage).toEqual([
      expect.objectContaining({ provider: "anthropic", model: "claude-opus-5", tokens: { input: 2, output: 294, cacheRead: 0, cacheWrite: 7014 } }),
    ]);
    const done = evs.at(-1) as Extract<WorkerEventInput, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.structured).toMatchObject({ noChanges: true });
    expect(done.effectiveReasoning).toBeNull();
    expect(p.terminated).toBe(true);
  });

  it("maps permission denials to tool_blocked", () => {
    const p = new ClaudeStreamParser({ sessionId: "x", requestedModel: "opus", requestedReasoning: "high" });
    const evs = feed(p, "claude-denied.jsonl");
    expect(evs.filter((e) => e.type === "tool_blocked")).toEqual([expect.objectContaining({ name: "Read" })]);
    expect(evs.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
  });

  it("refuses any auth source but the subscription login", () => {
    const p = new ClaudeStreamParser({ sessionId: "x", requestedModel: "opus", requestedReasoning: "high" });
    const evs = p.record({ type: "system", subtype: "init", session_id: "x", apiKeySource: "ANTHROPIC_API_KEY", model: "m" });
    expect(evs).toEqual([expect.objectContaining({ type: "error", kind: "auth" })]);
    expect(p.fatal).toBe(true);
  });

  it("parses extra-usage (overage) state from rate_limit_event", () => {
    const p = new ClaudeStreamParser({ sessionId: "x", requestedModel: "opus", requestedReasoning: "high" });
    const info = { status: "rejected", resetsAt: 1794273000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1794273000 } } };
    // shapes observed in run 20261110-001205-0e94
    expect(p.record({ type: "rate_limit_event", rate_limit_info: { ...info, overageStatus: "allowed", overageResetsAt: 1796083200, isUsingOverage: true, overageInUse: true } })).toEqual([
      { type: "rate_limit", status: "rejected", resetsAt: 1794273000_000, windows: { five_hour: { utilization: 1, resetsAt: 1794273000_000 } }, overage: { status: "allowed", inUse: true, resetsAt: 1796083200_000 } },
    ]);
    expect(p.record({ type: "rate_limit_event", rate_limit_info: { ...info, overageStatus: "rejected", overageDisabledReason: "org_level_disabled_until", isUsingOverage: false } })[0]).toMatchObject({
      overage: { status: "rejected", inUse: false, disabledReason: "org_level_disabled_until" },
    });
    expect(p.record({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: false } })[0]).not.toHaveProperty("overage");
  });

  it("classifies a usage-limit result as quota with the last reset time", () => {
    const p = new ClaudeStreamParser({ sessionId: "x", requestedModel: "opus", requestedReasoning: "high" });
    p.record({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1800000000 } });
    const evs = p.record({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1800000000", session_id: "x" });
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "quota", resetsAt: 1800000000_000 });
  });
});

describe("Pi argv and stream parser", () => {
  it("always loads only the path guard, disables context, never offers a shell", () => {
    const ro = piArgs(piCfg, task(), { guardAsset: "/g.ts", sessionDir: "/s" });
    expect(ro.join(" ")).toContain("--no-extensions -e /g.ts --no-skills --no-prompt-templates --no-mcp --no-context-files");
    expect(ro[ro.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(piArgs(piCfg, task({ outFile: "/o/result.json" }), { guardAsset: "/g.ts", sessionDir: "/s" }).join(" ")).toContain("--tools read,grep,find,ls,write");
    const ed = piArgs(piCfg, task({ mode: "edit", sessionId: "abc" }), { guardAsset: "/g.ts", sessionDir: "/s" });
    expect(ed[ed.indexOf("--tools") + 1]).toBe("read,edit,write,grep,find,ls");
    expect(ed).toEqual(expect.arrayContaining(["--session", "abc"]));
    for (const a of [ro, ed]) expect(a.join(" ")).not.toMatch(/bash|powershell|@/);
    expect(fs.existsSync(PI_GUARD_ASSET)).toBe(true);
  });

  const meta = { requestedModel: "together/x", requestedReasoning: "high", guardLoaded: () => true };

  it("normalizes a successful run: text, usage per assistant message, effective thinking", () => {
    const p = new PiStreamParser(meta);
    const evs = feed(p, "pi-hi.jsonl");
    expect(evs[0]).toMatchObject({ type: "start", sessionId: expect.any(String) });
    expect(evs.filter((e) => e.type === "text").length).toBeGreaterThan(0);
    const usage = evs.filter((e) => e.type === "usage");
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0]).toMatchObject({ provider: "together", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    const done = evs.at(-1) as Extract<WorkerEventInput, { type: "done" }>;
    expect(done).toMatchObject({ type: "done", effectiveReasoning: "high", resolvedModels: ["together/deepseek-ai/DeepSeek-V4.1-Flash-1017"] });
    expect(done.finalText).toContain("add(a, b)");
  });

  it("treats stopReason=error with exit 0 as an auth failure", () => {
    const evs = feed(new PiStreamParser(meta), "pi-badkey.jsonl");
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "auth", message: expect.stringContaining("401") });
  });

  it("maps guard blocks to tool_blocked", () => {
    const evs = feed(new PiStreamParser(meta), "pi-guard.jsonl");
    const blocked = evs.filter((e) => e.type === "tool_blocked");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]).toMatchObject({ reason: expect.stringMatching(/^fractory path guard: /) });
    expect(evs.at(-1)).toMatchObject({ type: "done" });
  });

  it("maps Pi's auto_retry_start/end to provider_retry events (docs/json.md shapes)", () => {
    const p = new PiStreamParser(meta);
    const evs = [
      ...p.record({ type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 2000, errorMessage: "429 Too Many Requests" }),
      ...p.record({ type: "auto_retry_end", success: true, attempt: 2 }),
      ...p.record({ type: "auto_retry_end", success: false, attempt: 4, finalError: "503 overloaded" }),
    ];
    for (const e of evs) WorkerEvent.parse(e);
    expect(evs).toEqual([
      { type: "provider_retry", phase: "scheduled", attempt: 1, maxAttempts: 4, delayMs: 2000, message: "429 Too Many Requests" },
      { type: "provider_retry", phase: "finished", attempt: 2, success: true },
      { type: "provider_retry", phase: "finished", attempt: 4, success: false, message: "503 overloaded" },
    ]);
    expect(p.terminated).toBe(false);
  });

  it("refuses the result when the guard did not acknowledge loading", () => {
    const evs = feed(new PiStreamParser({ ...meta, guardLoaded: () => false }), "pi-hi.jsonl");
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "protocol", message: expect.stringContaining("path guard") });
  });
});

describe("adapters end to end with a fake CLI", () => {
  it("Claude: prompt on stdin, ANTHROPIC_* and withheld keys scrubbed, raw stream saved redacted", async () => {
    const stepDir = tmpDir();
    const record = path.join(stepDir, "rec.json");
    const w = new ClaudeWorker("opus", claudeCfg, {
      redactor: new Redactor(["tgp_supersecret_value"]),
      withholdEnv: ["TOGETHER_API_KEY"],
      prefixArgs: [FAKE_CLI],
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
        Anthropic_Base_Url: "http://evil",
        TOGETHER_API_KEY: "tgp_supersecret_value",
        FAKE_CLI_RECORD: record,
        FAKE_CLI_FIXTURE: path.join(FIX, "claude-structured.jsonl"),
        FAKE_CLI_STDERR: "note tgp_supersecret_value",
      },
    });
    const evs = await collect(w.run(task({ stepDir, prompt: "the prompt" })));
    expect(evs.at(-1)).toMatchObject({ type: "done" });
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(rec.stdin).toBe("the prompt");
    expect(Object.keys(rec.env).map((k) => k.toUpperCase())).not.toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY"]),
    );
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "TOGETHER_API_KEY"]) {
      expect(Object.keys(rec.env).some((e) => e.toUpperCase() === k)).toBe(false);
    }
    const raw = fs.readFileSync(path.join(stepDir, "worker-opus.raw.jsonl"), "utf8");
    expect(raw).toContain('"type":"result"');
    const err = fs.readFileSync(path.join(stepDir, "worker-opus.stderr.log"), "utf8");
    expect(err).toContain(REDACTED);
    expect(err).not.toContain("tgp_supersecret_value");
  });

  it("Claude: a process that dies without a result is a process error", async () => {
    const w = new ClaudeWorker("opus", claudeCfg, {
      redactor: new Redactor(),
      prefixArgs: [FAKE_CLI],
      env: { ...process.env, FAKE_CLI_EXIT: "2", FAKE_CLI_STDERR: "boom" },
    });
    const evs = await collect(w.run(task()));
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "process", message: expect.stringContaining("boom") });
  });

  it("Pi: guard config per step, secrets limited to envFile values, structured out file, timeout kills", async () => {
    const data = tmpDir();
    const stepDir = path.join(data, "steps", "s1");
    const inputsDir = path.join(stepDir, "inputs");
    const outFile = path.join(stepDir, "out", "result.json");
    fs.mkdirSync(inputsDir, { recursive: true });
    const record = path.join(data, "rec.json");
    const mk = (extra: Record<string, string>) =>
      new PiWorker("deepseek", piCfg, {
        redactor: new Redactor(),
        secretEnv: { BASETEN_API_KEY: "bt_from_envfile_123" },
        agentDir: path.join(data, "pi-agent"),
        sessionDir: path.join(data, "pi-sessions"),
        prefixArgs: [FAKE_CLI],
        env: { ...process.env, GITHUB_TOKEN: "ghp_shouldnotpass", OTHER_SECRET: "nope-nope-nope", BASETEN_API_KEY: "bt_from_shell_env", ...extra },
      });
    const cwd = tmpDir();
    const evs = await collect(
      mk({ FAKE_CLI_RECORD: record, FAKE_CLI_ACK: "1", FAKE_CLI_OUTFILE: '{"noChanges":true}', FAKE_CLI_FIXTURE: path.join(FIX, "pi-hi.jsonl") }).run(
        task({ cwd, stepDir, inputsDir, outFile }),
      ),
    );
    expect(evs.at(-1)).toMatchObject({ type: "done", structured: { noChanges: true } });
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(rec.env.BASETEN_API_KEY).toBe("bt_from_envfile_123");
    expect(rec.env.GITHUB_TOKEN).toBeUndefined();
    expect(rec.env.OTHER_SECRET).toBeUndefined();
    expect(rec.env.PI_CODING_AGENT_DIR).toBe(path.join(data, "pi-agent"));
    const guard = JSON.parse(rec.env.FRACTORY_PI_GUARD);
    expect(guard.read).toEqual([cwd, inputsDir]);
    expect(guard.write).toEqual([outFile]);
    expect(JSON.parse(fs.readFileSync(path.join(data, "pi-agent", "settings.json"), "utf8"))).toEqual({
      retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 60000, provider: { maxRetries: 4, maxRetryDelayMs: 60000 } },
    });
    // custom providers: the key is an env reference, never a value
    const models = JSON.parse(fs.readFileSync(path.join(data, "pi-agent", "models.json"), "utf8"));
    expect(models.providers.lithos).toMatchObject({ baseUrl: "https://api.lithosai.cloud/v1", api: "openai-completions", apiKey: "$LITHOS_API_KEY" });
    expect(models.providers.lithos.models.map((m: { id: string }) => m.id)).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash-ultra"]);
    expect(fs.readdirSync(stepDir).filter((f) => f.startsWith("pi-guard-ack"))).toEqual([]);

    const t0 = Date.now();
    const hung = await collect(mk({ FAKE_CLI_HANG: "1" }).run(task({ cwd, stepDir, timeoutMs: 1000 })));
    expect(hung.at(-1)).toMatchObject({ type: "error", kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});
