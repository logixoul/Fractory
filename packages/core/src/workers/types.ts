import type { WorkerEventInput } from "../schemas/worker-events.js";

export type WorkerMode = "read-only" | "edit";

export interface WorkerTask {
  prompt: string;
  cwd: string;
  mode: WorkerMode;
  /** Resume this session; omitted = fresh session. */
  sessionId?: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** steps/<id>/ — adapters save the raw vendor stream here. */
  stepDir?: string;
  /** Read-only input files the agent may read (Claude: --add-dir; Pi: guard read allowlist). */
  inputsDir?: string;
  /** Designated structured-output file (Pi writes JSON here; §8.5). */
  outFile?: string;
  /** JSON Schema for structured output (Claude: --json-schema). */
  jsonSchema?: object;
}

/**
 * A bounded worker: one task per invocation, fresh or explicitly resumed.
 * Must end with exactly one `done` event, or with an `error` event.
 */
export interface Worker {
  readonly id: string;
  run(task: WorkerTask): AsyncIterable<WorkerEventInput>;
}
