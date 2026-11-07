import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerEventInput } from "../schemas/worker-events.js";
import type { Worker, WorkerTask } from "./types.js";

export type FakeAction =
  | { emit: WorkerEventInput }
  | { delayMs: number }
  /** Waits until aborted or timed out. */
  | { hang: true }
  /** Path relative to the task cwd (or absolute). */
  | { writeFile: { path: string; content: string } }
  | { removeFile: string }
  /** Simulates an adapter bug (the generator throws). */
  | { throw: string };

export interface FakeScript {
  /** Substring of the prompt, regex, or predicate. Omitted = matches anything. */
  match?: string | RegExp | ((task: WorkerTask) => boolean);
  /** Script stays available after use. */
  repeat?: boolean;
  actions?: FakeAction[];
  sessionId?: string;
  finalText?: string;
  structured?: unknown;
  /** End without a done event (protocol violation). */
  noDone?: boolean;
}

type Resolver = (task: WorkerTask, callIndex: number) => FakeScript | undefined;

/**
 * Deterministic scripted worker. All automated tests use this; no model is ever called.
 */
export class FakeWorker implements Worker {
  readonly calls: WorkerTask[] = [];
  readonly #scripts: FakeScript[];
  readonly #used = new Set<number>();
  readonly #resolver: Resolver | undefined;

  constructor(
    readonly id: string,
    scripts: FakeScript[] | Resolver,
  ) {
    if (typeof scripts === "function") {
      this.#scripts = [];
      this.#resolver = scripts;
    } else {
      this.#scripts = scripts;
      this.#resolver = undefined;
    }
  }

  #pick(task: WorkerTask, n: number): FakeScript | undefined {
    if (this.#resolver) return this.#resolver(task, n);
    for (let i = 0; i < this.#scripts.length; i++) {
      const s = this.#scripts[i]!;
      if (this.#used.has(i)) continue;
      const m = s.match;
      const ok =
        m === undefined ||
        (typeof m === "string" && task.prompt.includes(m)) ||
        (m instanceof RegExp && m.test(task.prompt)) ||
        (typeof m === "function" && m(task));
      if (!ok) continue;
      if (!s.repeat) this.#used.add(i);
      return s;
    }
    return undefined;
  }

  async *run(task: WorkerTask): AsyncGenerator<WorkerEventInput> {
    const n = this.calls.push(task) - 1;
    const script = this.#pick(task, n);
    if (!script) {
      yield { type: "error", kind: "protocol", message: `FakeWorker ${this.id}: no script for call #${n}` };
      return;
    }
    const deadline = Date.now() + task.timeoutMs;
    const sessionId = script.sessionId ?? task.sessionId ?? `fake-${this.id}-${n}`;
    yield { type: "start", sessionId, resolvedModel: `fake/${this.id}` };

    for (const a of script.actions ?? []) {
      if (task.signal.aborted) {
        yield { type: "error", kind: "killed", message: "aborted" };
        return;
      }
      if ("emit" in a) {
        yield a.emit;
        if (a.emit.type === "error") return;
      } else if ("delayMs" in a || "hang" in a) {
        const r = await wait("hang" in a ? Infinity : a.delayMs, task.signal, deadline);
        if (r === "timeout") {
          yield { type: "error", kind: "timeout", message: `timed out after ${task.timeoutMs}ms` };
          return;
        }
        if (r === "aborted") {
          yield { type: "error", kind: "killed", message: "aborted" };
          return;
        }
      } else if ("writeFile" in a) {
        const p = path.resolve(task.cwd, a.writeFile.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, a.writeFile.content);
      } else if ("removeFile" in a) {
        fs.rmSync(path.resolve(task.cwd, a.removeFile), { force: true, recursive: true });
      } else {
        throw new Error(a.throw);
      }
    }
    if (script.noDone) return;
    const done: WorkerEventInput = {
      type: "done",
      sessionId,
      finalText: script.finalText ?? "",
      resolvedModels: [`fake/${this.id}`],
    };
    if (script.structured !== undefined) done.structured = script.structured;
    yield done;
  }
}

function wait(ms: number, signal: AbortSignal, deadline: number): Promise<"ok" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const untilDeadline = deadline - Date.now();
    const timedOut = untilDeadline <= ms;
    const delay = Math.max(0, Math.min(ms, untilDeadline));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(timedOut ? "timeout" : "ok");
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Actions that simulate a Claude usage-limit hit. */
export function fakeQuotaExhausted(resetsAt: number): FakeAction[] {
  return [
    { emit: { type: "rate_limit", status: "rejected", resetsAt, windows: { five_hour: { utilization: 1, resetsAt } } } },
    { emit: { type: "error", kind: "quota", message: "usage limit reached", resetsAt } },
  ];
}
