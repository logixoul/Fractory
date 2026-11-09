import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerEventInput } from "../schemas/worker-events.js";
import { parseJsonLine } from "../util/jsonl.js";
import { streamProcess, tail, type ProcEnd, type SpawnSpec } from "../util/proc.js";
import type { Redactor } from "../util/redact.js";

/** Translates one vendor JSONL stream into normalized worker events. */
export interface StreamParser {
  /** One parsed JSON record from stdout. */
  record(obj: Record<string, unknown>): WorkerEventInput[];
  /** Process ended. Returns the terminal event if the stream did not produce one. */
  finish(end: ProcEnd, stderrTail: string): WorkerEventInput[];
  /** Set when the stream must be stopped now (e.g. wrong auth); the process tree is killed. */
  readonly fatal: boolean;
  /** A done or error event was produced. */
  readonly terminated: boolean;
}

const MAX_NOISE_EVENTS = 200;
const MAX_STDERR_TAIL = 8000;

export interface CliRunOptions {
  spawn: SpawnSpec;
  parser: StreamParser;
  redactor: Redactor;
  /** steps/<id>/: raw stream and stderr are appended to <rawPrefix>.raw.jsonl / .stderr.log. */
  stepDir?: string;
  rawPrefix: string;
}

/**
 * Spawns a worker CLI and yields normalized events. The raw vendor stream is saved per step
 * (redacted) for debugging. Exactly one terminal event (done or error) is produced.
 */
export async function* runCli(o: CliRunOptions): AsyncGenerator<WorkerEventInput> {
  const raw = o.stepDir ? path.join(o.stepDir, `${o.rawPrefix}.raw.jsonl`) : undefined;
  const errLog = o.stepDir ? path.join(o.stepDir, `${o.rawPrefix}.stderr.log`) : undefined;
  const write = (file: string | undefined, text: string) => {
    if (file) fs.appendFileSync(file, o.redactor.string(text));
  };
  write(raw, JSON.stringify({ fractory: "invocation", ts: new Date().toISOString(), argv: [o.spawn.command, ...o.spawn.args] }) + "\n");

  let stderrTail = "";
  let noise = 0;
  const proc = streamProcess(o.spawn);
  try {
    for await (const item of proc) {
      if (item.kind === "end") {
        if (!o.parser.terminated) yield* o.parser.finish(item, o.redactor.string(tail(stderrTail, MAX_STDERR_TAIL)));
        return;
      }
      if (item.kind === "stderr") {
        write(errLog, item.line + "\n");
        stderrTail = tail(stderrTail + item.line + "\n", MAX_STDERR_TAIL);
        if (noise++ < MAX_NOISE_EVENTS) yield { type: "noise", stream: "stderr", text: item.line };
        continue;
      }
      write(raw, item.line + "\n");
      const p = parseJsonLine(item.line);
      if (!p.ok || typeof p.value !== "object" || p.value === null || Array.isArray(p.value)) {
        if (noise++ < MAX_NOISE_EVENTS) yield { type: "noise", stream: "stdout", text: item.line };
        continue;
      }
      if (o.parser.terminated) continue;
      yield* o.parser.record(p.value as Record<string, unknown>);
      if (o.parser.fatal) return; // finally{} kills the tree
    }
  } finally {
    await proc.return(undefined);
  }
}

/** Joins the text parts of a vendor content array. */
export function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => c.text)
    .join("");
}

export const MAX_TOOL_OUTPUT = 8000;

export function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more chars]`;
}

const QUOTA_RE = /usage limit|rate.?limit|limit reached|quota|\b429\b|too many requests/i;
const AUTH_RE = /\b401\b|\b403\b|invalid.?api.?key|unauthori[sz]ed|authenticat|not logged in|please (run )?\/?log ?in/i;
const TRANSIENT_RE =
  /\b5\d\d\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|temporarily unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error/i;
const PI_RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;

export type ErrorClass = "quota" | "transient" | "auth" | "model";

/**
 * Classifies a vendor error. Only ever applied to an error result (Claude is_error === true,
 * Pi stopReason=error): successful model output is never text-matched.
 *  - Claude: 429 / usage-limit text = Pro quota (pause, never retried).
 *  - Pi/Together: 429 = provider rate limit, transient (retried with backoff).
 *  - 5xx / overloaded / network = transient.
 */
export function classifyError(message: string, o: { status?: number | null; vendor: "claude" | "pi" }): ErrorClass {
  const s = o.status ?? null;
  if (s !== null && s >= 500) return "transient";
  if (s === 401 || s === 403) return "auth";
  if (o.vendor === "claude" && (s === 429 || QUOTA_RE.test(message))) return "quota";
  if (o.vendor === "pi" && (s === 429 || PI_RATE_LIMIT_RE.test(message))) return "transient";
  if (AUTH_RE.test(message)) return "auth";
  if (TRANSIENT_RE.test(message)) return "transient";
  return "model";
}

/** Maps an abnormal process end (no terminal event in the stream) to an error event. */
export function endError(end: ProcEnd, stderrTail: string, what: string): WorkerEventInput {
  if (end.reason === "timeout") return { type: "error", kind: "timeout", message: `${what} timed out after ${end.durationMs}ms` };
  if (end.reason === "aborted") return { type: "error", kind: "killed", message: `${what} was cancelled` };
  if (end.reason === "spawn_error") return { type: "error", kind: "process", message: `could not start ${what}: ${end.error}` };
  const detail = stderrTail.trim() ? `; stderr: ${stderrTail.trim()}` : "";
  return {
    type: "error",
    kind: "process",
    message: `${what} exited (code ${end.code ?? "null"}, signal ${end.signal ?? "none"}) without a final result${detail}`,
  };
}
