import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { ClaudeWorkerConfig } from "../schemas/config.js";
import type { Overage, WorkerEventInput } from "../schemas/worker-events.js";
import { CLAUDE_SCRUBBED_ENV, withoutEnv } from "../util/env.js";
import type { ProcEnd } from "../util/proc.js";
import type { Redactor } from "../util/redact.js";
import { classifyError, endError, runCli, textParts, truncate, type StreamParser } from "./cli-run.js";
import type { Worker, WorkerTask } from "./types.js";

type ClaudeCfg = z.infer<typeof ClaudeWorkerConfig>;

export const CLAUDE_TOOLS = {
  "read-only": "Read,Grep,Glob",
  edit: "Read,Edit,Write,Glob,Grep",
} as const;

/**
 * Argv for one `claude -p` invocation (docs/interfaces.md §1). Never `--bare` (it breaks the
 * subscription login). Project context is disabled; the orchestrator injects it (§6).
 */
export function claudeArgs(cfg: Pick<ClaudeCfg, "model" | "effort">, task: WorkerTask, sessionId: string): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", cfg.model, "--effort", cfg.effort];
  if (task.sessionId) args.push("-r", task.sessionId);
  else args.push("--session-id", sessionId);
  args.push("--tools", CLAUDE_TOOLS[task.mode], "--permission-mode", task.mode === "edit" ? "acceptEdits" : "dontAsk");
  args.push("--setting-sources", "", "--strict-mcp-config");
  if (task.inputsDir) args.push("--add-dir", task.inputsDir);
  if (task.jsonSchema) args.push("--json-schema", JSON.stringify(task.jsonSchema));
  return args;
}

export interface ClaudeWorkerOptions {
  /** Base env for the child (default process.env). ANTHROPIC_* are always removed. */
  env?: NodeJS.ProcessEnv;
  /** Env names that must never reach this child (e.g. keys from envFile meant for Pi). */
  withholdEnv?: readonly string[];
  redactor: Redactor;
  /** Test hook: argv inserted before the Claude args (e.g. a fake CLI script). */
  prefixArgs?: readonly string[];
}

export class ClaudeWorker implements Worker {
  constructor(
    readonly id: string,
    private readonly cfg: ClaudeCfg,
    private readonly opts: ClaudeWorkerOptions,
  ) {}

  run(task: WorkerTask): AsyncIterable<WorkerEventInput> {
    const sessionId = task.sessionId ?? randomUUID();
    const env = withoutEnv(this.opts.env ?? process.env, [...CLAUDE_SCRUBBED_ENV, ...(this.opts.withholdEnv ?? [])]);
    return runCli({
      spawn: {
        command: this.cfg.command,
        args: [...(this.opts.prefixArgs ?? []), ...claudeArgs(this.cfg, task, sessionId)],
        cwd: task.cwd,
        env,
        stdin: task.prompt,
        timeoutMs: task.timeoutMs,
        signal: task.signal,
      },
      parser: new ClaudeStreamParser({ sessionId, requestedModel: this.cfg.model, requestedReasoning: this.cfg.effort }),
      redactor: this.opts.redactor,
      ...(task.stepDir ? { stepDir: task.stepDir } : {}),
      rawPrefix: `worker-${this.id}`,
    });
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sToMs = (v: unknown): number | undefined => (typeof v === "number" ? v * 1000 : undefined);

/** Claude Code stream-json → WorkerEvents (§1 "Stream"). */
export class ClaudeStreamParser implements StreamParser {
  fatal = false;
  terminated = false;
  #sessionId: string;
  #models: string[] = [];
  #lastResetsAt: number | undefined;
  #sawInit = false;

  constructor(private readonly meta: { sessionId: string; requestedModel: string; requestedReasoning: string }) {
    this.#sessionId = meta.sessionId;
  }

  #model(m: unknown): void {
    if (typeof m === "string" && m && !this.#models.includes(m)) this.#models.push(m);
  }

  #error(ev: Extract<WorkerEventInput, { type: "error" }>): WorkerEventInput[] {
    this.terminated = true;
    return [ev];
  }

  record(o: Obj): WorkerEventInput[] {
    switch (o.type) {
      case "system":
        if (o.subtype !== "init") return [];
        this.#sawInit = true;
        if (typeof o.session_id === "string") this.#sessionId = o.session_id;
        this.#model(o.model);
        if (o.apiKeySource !== "none") {
          this.fatal = true;
          return this.#error({
            type: "error",
            kind: "auth",
            message: `Claude Code reported apiKeySource=${JSON.stringify(o.apiKeySource)}; fractory only runs on the subscription login (expected "none")`,
          });
        }
        return [
          {
            type: "start",
            sessionId: this.#sessionId,
            requestedModel: this.meta.requestedModel,
            requestedReasoning: this.meta.requestedReasoning,
            ...(typeof o.model === "string" ? { resolvedModel: o.model } : {}),
          },
        ];
      case "rate_limit_event": {
        const info = obj(o.rate_limit_info);
        const windows: Record<string, { utilization: number; resetsAt?: number }> = {};
        for (const [name, w] of Object.entries(obj(info.unifiedWindows))) {
          const wo = obj(w);
          if (typeof wo.utilization !== "number") continue;
          const r = sToMs(wo.resetsAt);
          windows[name] = { utilization: wo.utilization, ...(r !== undefined ? { resetsAt: r } : {}) };
        }
        const resetsAt = sToMs(info.resetsAt);
        if (resetsAt !== undefined) this.#lastResetsAt = resetsAt;
        // Extra usage: only reported once relevant (observed with `overageStatus` set).
        let overage: Overage | undefined;
        if (typeof info.overageStatus === "string") {
          const r = sToMs(info.overageResetsAt);
          overage = {
            status: info.overageStatus,
            inUse: info.isUsingOverage === true,
            ...(r !== undefined ? { resetsAt: r } : {}),
            ...(typeof info.overageDisabledReason === "string" ? { disabledReason: info.overageDisabledReason } : {}),
          };
        }
        return [
          {
            type: "rate_limit",
            status: String(info.status ?? "unknown"),
            windows,
            ...(resetsAt !== undefined ? { resetsAt } : {}),
            ...(overage ? { overage } : {}),
          },
        ];
      }
      case "assistant": {
        const out: WorkerEventInput[] = [];
        const msg = obj(o.message);
        this.#model(msg.model);
        for (const part of Array.isArray(msg.content) ? msg.content : []) {
          const p = obj(part);
          if (p.type === "text" && typeof p.text === "string" && p.text) out.push({ type: "text", text: p.text });
          else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking) out.push({ type: "thinking", text: p.thinking });
          else if (p.type === "tool_use") out.push({ type: "tool_call", id: String(p.id ?? ""), name: String(p.name ?? ""), input: p.input ?? null });
        }
        return out;
      }
      case "user": {
        const out: WorkerEventInput[] = [];
        const content = obj(o.message).content;
        for (const part of Array.isArray(content) ? content : []) {
          const p = obj(part);
          if (p.type !== "tool_result") continue;
          const text = typeof p.content === "string" ? p.content : textParts(p.content);
          out.push({ type: "tool_result", id: String(p.tool_use_id ?? ""), isError: p.is_error === true, output: truncate(text) });
        }
        return out;
      }
      case "result":
        return this.#result(o);
      default:
        return [];
    }
  }

  #result(o: Obj): WorkerEventInput[] {
    const out: WorkerEventInput[] = [];
    for (const d of Array.isArray(o.permission_denials) ? o.permission_denials : []) {
      const dd = obj(d);
      out.push({ type: "tool_blocked", id: String(dd.tool_use_id ?? ""), name: String(dd.tool_name ?? ""), reason: "permission denied by Claude Code" });
    }
    const mu = obj(o.modelUsage);
    if (Object.keys(mu).length > 0) {
      for (const [model, u] of Object.entries(mu)) {
        const uu = obj(u);
        this.#model(model);
        out.push({
          type: "usage",
          provider: "anthropic",
          model,
          tokens: {
            input: num(uu.inputTokens),
            output: num(uu.outputTokens),
            cacheRead: num(uu.cacheReadInputTokens),
            cacheWrite: num(uu.cacheCreationInputTokens),
          },
          ...(typeof uu.costUSD === "number" ? { vendorCostUsd: uu.costUSD } : {}),
        });
      }
    } else if (o.usage) {
      const u = obj(o.usage);
      out.push({
        type: "usage",
        provider: "anthropic",
        model: this.#models[0] ?? this.meta.requestedModel,
        tokens: {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        },
        ...(typeof o.total_cost_usd === "number" ? { vendorCostUsd: o.total_cost_usd } : {}),
      });
    }
    if (typeof o.session_id === "string") this.#sessionId = o.session_id;
    this.terminated = true;
    if (o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success")) {
      const status = typeof o.api_error_status === "number" ? o.api_error_status : null;
      const message = [o.subtype, typeof o.result === "string" ? o.result : "", Array.isArray(o.errors) ? o.errors.join("; ") : ""]
        .filter(Boolean)
        .join(": ");
      // Text matching only on an actual error result (is_error === true), never on model output.
      const kind = o.is_error === true ? classifyError(message, { status, vendor: "claude" }) : "model";
      out.push({ type: "error", kind, message: message || "Claude Code reported an error", ...(kind === "quota" && this.#lastResetsAt !== undefined ? { resetsAt: this.#lastResetsAt } : {}) });
      return out;
    }
    out.push({
      type: "done",
      sessionId: this.#sessionId,
      finalText: typeof o.result === "string" ? o.result : "",
      ...(o.structured_output !== undefined ? { structured: o.structured_output } : {}),
      resolvedModels: this.#models,
      // Claude does not report the effective effort (§5); the requested one is logged on start.
      effectiveReasoning: null,
    });
    return out;
  }

  finish(end: ProcEnd, stderrTail: string): WorkerEventInput[] {
    this.terminated = true;
    const ev = endError(end, stderrTail, "claude");
    if (ev.type === "error" && ev.kind === "process" && !this.#sawInit && classifyError(stderrTail, { vendor: "claude" }) === "auth") {
      return [{ ...ev, kind: "auth" }];
    }
    return [ev];
  }
}
