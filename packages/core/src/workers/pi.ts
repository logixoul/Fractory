import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { PiWorkerConfig } from "../schemas/config.js";
import type { WorkerEventInput } from "../schemas/worker-events.js";
import { CLAUDE_SCRUBBED_ENV, withEnv, withoutEnv } from "../util/env.js";
import { writeFileAtomicSync } from "../util/fsx.js";
import type { ProcEnd } from "../util/proc.js";
import { SECRET_ENV_NAME_RE, type Redactor } from "../util/redact.js";
import { classifyError, endError, runCli, textParts, truncate, type StreamParser } from "./cli-run.js";
import type { Worker, WorkerTask } from "./types.js";

type PiCfg = z.infer<typeof PiWorkerConfig>;

/** The path-guard extension shipped with core (assets/ sits next to src/ and dist/). */
export const PI_GUARD_ASSET = fileURLToPath(new URL("../../assets/pi-path-guard.ts", import.meta.url));

export const PI_TOOLS = {
  "read-only": ["read", "grep", "find", "ls"],
  edit: ["read", "edit", "write", "grep", "find", "ls"],
} as const;

/** Pi's internal retries are disabled so every retry is the orchestrator's decision (§2). */
export const PI_AGENT_SETTINGS = { retry: { enabled: false, provider: { maxRetries: 0 } } };

export function ensurePiAgentDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  const want = JSON.stringify(PI_AGENT_SETTINGS, null, 2) + "\n";
  let have: string | undefined;
  try {
    have = fs.readFileSync(file, "utf8");
  } catch {
    have = undefined;
  }
  if (have !== want) writeFileAtomicSync(file, want);
}

export interface GuardAllowlist {
  read: string[];
  write: string[];
}

/** Per-step allowlist (§8.12): own worktree + own inputs/ for reading; writes only where the step may write. */
export function piGuardAllowlist(task: WorkerTask): GuardAllowlist {
  const read = [task.cwd, ...(task.inputsDir ? [task.inputsDir] : [])];
  const write = [...(task.mode === "edit" ? [task.cwd] : []), ...(task.outFile ? [task.outFile] : [])];
  return { read, write };
}

export function piArgs(cfg: Pick<PiCfg, "provider" | "model" | "thinking">, task: WorkerTask, o: { guardAsset: string; sessionDir: string }): string[] {
  const tools: string[] = [...PI_TOOLS[task.mode]];
  if (task.outFile && !tools.includes("write")) tools.push("write");
  const args = ["--mode", "json", "--provider", cfg.provider, "--model", cfg.model, "--thinking", cfg.thinking];
  args.push("--no-extensions", "-e", o.guardAsset, "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-context-files");
  args.push("--tools", tools.join(","), "--session-dir", o.sessionDir);
  if (task.sessionId) args.push("--session", task.sessionId);
  return args;
}

export interface PiWorkerOptions {
  /** Base env (default process.env). Secret-looking vars are stripped, then `secretEnv` is added. */
  env?: NodeJS.ProcessEnv;
  /** Values from envFile (e.g. BASETEN_API_KEY). */
  secretEnv?: Record<string, string>;
  /** <dataDir>/pi-agent (PI_CODING_AGENT_DIR) and <dataDir>/pi-sessions. */
  agentDir: string;
  sessionDir: string;
  redactor: Redactor;
  guardAsset?: string;
  /** Test hook: argv inserted before the Pi args. */
  prefixArgs?: readonly string[];
}

export class PiWorker implements Worker {
  constructor(
    readonly id: string,
    private readonly cfg: PiCfg,
    private readonly opts: PiWorkerOptions,
  ) {}

  run(task: WorkerTask): AsyncIterable<WorkerEventInput> {
    return this.#run(task);
  }

  async *#run(task: WorkerTask): AsyncGenerator<WorkerEventInput> {
    const guardAsset = this.opts.guardAsset ?? PI_GUARD_ASSET;
    if (!fs.existsSync(guardAsset)) {
      yield { type: "error", kind: "process", message: `Pi path-guard extension missing at ${guardAsset}` };
      return;
    }
    ensurePiAgentDir(this.opts.agentDir);
    fs.mkdirSync(this.opts.sessionDir, { recursive: true });
    const nonce = randomBytes(16).toString("hex");
    const ack = path.join(task.stepDir ?? os.tmpdir(), `pi-guard-ack-${nonce}`);
    const allow = piGuardAllowlist(task);
    const base = this.opts.env ?? process.env;
    const pass = new Set(this.cfg.passEnv.map((k) => k.toUpperCase()));
    const secretLooking = Object.keys(base).filter((k) => SECRET_ENV_NAME_RE.test(k) && !pass.has(k.toUpperCase()));
    const stripped = withoutEnv(base, [...CLAUDE_SCRUBBED_ENV, ...secretLooking]);
    const env = withEnv(stripped, {
      ...(this.opts.secretEnv ?? {}),
      PI_CODING_AGENT_DIR: this.opts.agentDir,
      FRACTORY_PI_GUARD: JSON.stringify({ ...allow, ack, nonce }),
    });
    if (task.outFile) fs.mkdirSync(path.dirname(task.outFile), { recursive: true });

    const parser = new PiStreamParser({
      requestedModel: `${this.cfg.provider}/${this.cfg.model}`,
      requestedReasoning: this.cfg.thinking,
      guardLoaded: () => {
        try {
          return fs.readFileSync(ack, "utf8") === nonce;
        } catch {
          return false;
        }
      },
      ...(task.outFile ? { outFile: task.outFile } : {}),
    });
    try {
      yield* runCli({
        spawn: {
          command: this.cfg.command,
          args: [...(this.opts.prefixArgs ?? []), ...piArgs(this.cfg, task, { guardAsset, sessionDir: this.opts.sessionDir })],
          cwd: task.cwd,
          env,
          stdin: task.prompt,
          timeoutMs: task.timeoutMs,
          signal: task.signal,
        },
        parser,
        redactor: this.opts.redactor,
        ...(task.stepDir ? { stepDir: task.stepDir } : {}),
        rawPrefix: `worker-${this.id}`,
      });
    } finally {
      fs.rmSync(ack, { force: true });
    }
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const GUARD_BLOCK_PREFIX = "fractory path guard:";

interface PiMeta {
  requestedModel: string;
  requestedReasoning: string;
  /** Checked before `done`: the guard wrote its ack (the extension really was loaded). */
  guardLoaded: () => boolean;
  /** Structured output file (§8.5); parsed into done.structured when valid JSON. */
  outFile?: string;
}

/** Pi `--mode json` → WorkerEvents (§2 "Stream"). */
export class PiStreamParser implements StreamParser {
  fatal = false;
  terminated = false;
  #sessionId: string | undefined;
  #models: string[] = [];
  #last: Obj | undefined;
  #thinking: string | null = null;

  constructor(private readonly meta: PiMeta) {}

  record(o: Obj): WorkerEventInput[] {
    switch (o.type) {
      case "session":
        if (typeof o.id !== "string") return [];
        this.#sessionId = o.id;
        return [{ type: "start", sessionId: o.id, requestedModel: this.meta.requestedModel, requestedReasoning: this.meta.requestedReasoning }];
      case "message_update": {
        const e = obj(o.assistantMessageEvent);
        if (typeof e.delta !== "string" || e.delta === "") return [];
        if (e.type === "text_delta") return [{ type: "text", text: e.delta }];
        if (e.type === "thinking_delta") return [{ type: "thinking", text: e.delta }];
        return [];
      }
      case "tool_execution_start":
        return [{ type: "tool_call", id: String(o.toolCallId ?? ""), name: String(o.toolName ?? ""), input: o.args ?? null }];
      case "tool_execution_end": {
        const text = textParts(obj(o.result).content);
        const id = String(o.toolCallId ?? "");
        if (o.isError === true && text.startsWith(GUARD_BLOCK_PREFIX)) {
          return [{ type: "tool_blocked", id, name: String(o.toolName ?? ""), reason: text }];
        }
        return [{ type: "tool_result", id, isError: o.isError === true, output: truncate(text) }];
      }
      case "message_end": {
        const m = obj(o.message);
        if (m.role !== "assistant") return [];
        this.#last = m;
        const provider = typeof m.provider === "string" ? m.provider : "unknown";
        const model = typeof m.model === "string" ? m.model : "unknown";
        const key = `${provider}/${model}`;
        if (!this.#models.includes(key)) this.#models.push(key);
        if (typeof m.thinkingLevel === "string") this.#thinking = m.thinkingLevel;
        const u = obj(m.usage);
        const cost = obj(u.cost);
        return [
          {
            type: "usage",
            provider,
            model,
            tokens: {
              input: num(u.input),
              output: num(u.output),
              cacheRead: num(u.cacheRead),
              cacheWrite: num(u.cacheWrite),
              ...(typeof u.reasoning === "number" ? { reasoning: u.reasoning } : {}),
            },
            ...(typeof cost.total === "number" ? { vendorCostUsd: cost.total } : {}),
          },
        ];
      }
      case "agent_settled":
        return this.#settle(o.aborted === true);
      default:
        return [];
    }
  }

  #settle(aborted: boolean): WorkerEventInput[] {
    this.terminated = true;
    if (aborted) return [{ type: "error", kind: "killed", message: "Pi reported the agent run as aborted" }];
    const last = this.#last;
    if (!last) return [{ type: "error", kind: "protocol", message: "Pi settled without an assistant message" }];
    const stop = last.stopReason;
    if (stop === "error" || stop === "aborted" || stop === "length") {
      const message = `stopReason=${String(stop)}: ${typeof last.errorMessage === "string" ? last.errorMessage : "no error message"}`;
      return [{ type: "error", kind: stop === "aborted" ? "killed" : classifyError(message, { vendor: "pi" }), message }];
    }
    if (!this.#sessionId) return [{ type: "error", kind: "protocol", message: "Pi stream had no session record" }];
    if (!this.meta.guardLoaded()) {
      return [{ type: "error", kind: "protocol", message: "fractory path guard did not acknowledge loading; refusing the result" }];
    }
    let structured: unknown;
    if (this.meta.outFile) {
      try {
        structured = JSON.parse(fs.readFileSync(this.meta.outFile, "utf8"));
      } catch {
        structured = undefined; // the workflow's exit check reports the missing/invalid file (§8.5)
      }
    }
    return [
      {
        type: "done",
        sessionId: this.#sessionId,
        finalText: textParts(last.content),
        ...(structured !== undefined ? { structured } : {}),
        resolvedModels: this.#models,
        effectiveReasoning: this.#thinking,
      },
    ];
  }

  finish(end: ProcEnd, stderrTail: string): WorkerEventInput[] {
    this.terminated = true;
    return [endError(end, stderrTail, "pi")];
  }
}
