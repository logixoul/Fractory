import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import { LineSplitter } from "./jsonl.js";

/**
 * Process spawning for workers, git, checks and setup. Rules: argv arrays only (never a
 * shell string), whole-tree kill on timeout/abort on every OS (tree-kill → taskkill /T /F
 * on Windows), stdin carries prompts.
 */
export interface SpawnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Complete child environment (not merged with process.env). */
  env: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. Omitted = stdin closed immediately. */
  stdin?: string | Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type EndReason = "exit" | "timeout" | "aborted" | "spawn_error";

export interface ProcEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: EndReason;
  error?: string;
  durationMs: number;
}

export type ProcItem = { kind: "stdout" | "stderr"; line: string } | ({ kind: "end" } & ProcEnd);

/** Kills the whole process tree and resolves once the kill command finished. */
export function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  return new Promise((resolve) => treeKill(pid, "SIGKILL", () => resolve()));
}

interface Started {
  child: ChildProcess;
  ended: Promise<ProcEnd>;
}

function start(spec: SpawnSpec, onData: (stream: "stdout" | "stderr", chunk: Buffer) => void): Started {
  const t0 = Date.now();
  let reason: EndReason = "exit";
  let spawnError: string | undefined;
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const kill = (why: EndReason) => {
    if (reason !== "exit") return;
    reason = why;
    void killTree(child.pid);
  };
  const timer = setTimeout(() => kill("timeout"), spec.timeoutMs);
  const onAbort = () => kill("aborted");
  if (spec.signal?.aborted) queueMicrotask(onAbort);
  else spec.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout?.on("data", (c: Buffer) => onData("stdout", c));
  child.stderr?.on("data", (c: Buffer) => onData("stderr", c));
  // A child that exits before reading stdin makes the write fail with EPIPE; that is not our error.
  child.stdin?.on("error", () => {});
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  else child.stdin?.end();

  const ended = new Promise<ProcEnd>((resolve) => {
    let settled = false;
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: sig,
        reason: spawnError !== undefined ? "spawn_error" : reason,
        ...(spawnError !== undefined ? { error: spawnError } : {}),
        durationMs: Date.now() - t0,
      });
    };
    child.on("error", (e) => {
      spawnError = e.message;
      // 'close' may never follow a failed spawn.
      setTimeout(() => finish(null, null), 50);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
  return { child, ended };
}

/**
 * Streams stdout/stderr as lines (split on \n only; see util/jsonl.ts), then one `end` item.
 * Breaking out of the iteration kills the process tree.
 */
export async function* streamProcess(spec: SpawnSpec): AsyncGenerator<ProcItem> {
  const queue: ProcItem[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
  const { child, ended } = start(spec, (stream, chunk) => {
    for (const line of splitters[stream].push(chunk)) queue.push({ kind: stream, line });
    notify();
  });
  let done = false;
  void ended.then((end) => {
    for (const s of ["stdout", "stderr"] as const) for (const line of splitters[s].end()) queue.push({ kind: s, line });
    queue.push({ kind: "end", ...end });
    done = true;
    notify();
  });
  try {
    for (;;) {
      const item = queue.shift();
      if (item) {
        yield item;
        if (item.kind === "end") return;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    if (!done) {
      await killTree(child.pid);
      await ended;
    }
  }
}

export interface RunResult extends ProcEnd {
  stdout: Buffer;
  stderr: Buffer;
  /** True when output beyond maxBufferBytes was dropped (the head is kept). */
  truncated: boolean;
}

export interface RunSpec extends SpawnSpec {
  /** Per stream; default 64 MiB. */
  maxBufferBytes?: number;
  /** Also append combined stdout+stderr here as it arrives. */
  logFile?: string;
}

/** Runs to completion, buffering output. */
export async function runProcess(spec: RunSpec): Promise<RunResult> {
  const max = spec.maxBufferBytes ?? 64 * 1024 * 1024;
  const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  let truncated = false;
  const log = spec.logFile ? fs.openSync(spec.logFile, "a") : undefined;
  try {
    const { ended } = start(spec, (stream, chunk) => {
      if (log !== undefined) fs.writeSync(log, chunk);
      const room = max - sizes[stream];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      bufs[stream].push(part);
      sizes[stream] += part.length;
    });
    const end = await ended;
    return { ...end, stdout: Buffer.concat(bufs.stdout), stderr: Buffer.concat(bufs.stderr), truncated };
  } finally {
    if (log !== undefined) fs.closeSync(log);
  }
}

/** Last `maxChars` of a text, for error messages and log tails. */
export function tail(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : `…${text.slice(text.length - maxChars)}`;
}
