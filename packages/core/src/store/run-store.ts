import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunEvent, type RunCreatedEvent, type RunEventInput } from "../schemas/run-events.js";
import { reduceAll, reduceInto, type RunState } from "../state/reducer.js";
import { isPidAlive, readJsonIfExists, writeAllSync, writeFileAtomicSync } from "../util/fsx.js";
import { RUN_ID_RE, newRunId, randomHex } from "../util/random.js";
import { Redactor } from "../util/redact.js";

const EVENTS = "events.jsonl";
const STATE = "state.json";
const LOCK = "driver.lock";
const CANCEL = "cancel.request";
const STEP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const STATE_THROTTLE_MS = 250;

export class LockedError extends Error {
  override name = "LockedError";
}
export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
}
export class CorruptLogError extends Error {
  override name = "CorruptLogError";
}

export interface ReadEventsResult {
  events: RunEvent[];
  /** Bytes after the last newline: a write torn by a crash. Ignored on read. */
  tornTailBytes: number;
  validBytes: number;
}

/** Reads and validates an events.jsonl file. A torn final line is ignored, never trusted. */
export function readEventsFile(file: string): ReadEventsResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { events: [], tornTailBytes: 0, validBytes: 0 };
    throw e;
  }
  const validBytes = buf.lastIndexOf(0x0a) + 1;
  const events: RunEvent[] = [];
  const lines = buf.subarray(0, validBytes).toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new CorruptLogError(`${file}:${i + 1}: unparseable event line`);
    }
    const parsed = RunEvent.safeParse(obj);
    if (!parsed.success) throw new CorruptLogError(`${file}:${i + 1}: invalid event: ${parsed.error.message}`);
    if (parsed.data.seq !== events.length + 1) {
      throw new CorruptLogError(`${file}:${i + 1}: expected seq ${events.length + 1}, got ${parsed.data.seq}`);
    }
    events.push(parsed.data);
  }
  return { events, tornTailBytes: buf.length - validBytes, validBytes };
}

interface LockBody {
  pid: number;
  hostname: string;
  startedAt: string;
  token: string;
}

function acquireLock(file: string): string {
  const token = randomHex(8);
  const body: LockBody = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), token };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(body), { flag: "wx" });
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: LockBody | undefined;
      try {
        holder = readJsonIfExists<LockBody>(file);
      } catch {
        holder = undefined; // being written right now, or garbage: treat as held
      }
      if (holder === undefined && !fs.existsSync(file)) continue; // released meanwhile
      const stale = holder !== undefined && holder.hostname === os.hostname() && !isPidAlive(holder.pid);
      if (!stale) {
        throw new LockedError(`run is being driven by pid ${holder?.pid ?? "?"} on ${holder?.hostname ?? "?"} (${file})`);
      }
      // Single-user tool: a narrow race between two processes reclaiming the same stale
      // lock is accepted; the loser gets EEXIST on its create and reports LockedError.
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockedError(`could not acquire ${file}`);
}

function releaseLock(file: string, token: string): void {
  try {
    const holder = readJsonIfExists<LockBody>(file);
    if (holder?.token === token) fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

export class RunHandle {
  readonly dir: string;
  readonly eventsFile: string;
  readonly stateFile: string;
  #state!: RunState;
  #writer: { fd: number; token: string } | null = null;
  #stateTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly runId: string,
    dir: string,
    private readonly redactor: Redactor,
  ) {
    this.dir = dir;
    this.eventsFile = path.join(dir, EVENTS);
    this.stateFile = path.join(dir, STATE);
    this.#reload();
  }

  #reload(): void {
    const { events } = readEventsFile(this.eventsFile);
    if (events.length === 0) throw new RunNotFoundError(`run ${this.runId} has no events`);
    this.#state = reduceAll(events);
  }

  /** A copy of the current derived state. */
  state(): RunState {
    return structuredClone(this.#state);
  }

  /** Events with seq > sinceSeq, read from disk (works for non-writer readers too). */
  events(sinceSeq = 0): RunEvent[] {
    return readEventsFile(this.eventsFile).events.filter((e) => e.seq > sinceSeq);
  }

  get isWriter(): boolean {
    return this.#writer !== null;
  }

  /**
   * Becomes the single writer for this run. Repairs a torn tail left by a crash and
   * reloads state from disk. Returns the release function.
   */
  acquireWriter(): () => void {
    if (this.#writer) throw new Error("writer already held by this handle");
    const lockFile = path.join(this.dir, LOCK);
    const token = acquireLock(lockFile);
    try {
      const { tornTailBytes, validBytes } = readEventsFile(this.eventsFile);
      if (tornTailBytes > 0) fs.truncateSync(this.eventsFile, validBytes);
      this.#reload();
      this.#writer = { fd: fs.openSync(this.eventsFile, "a"), token };
    } catch (e) {
      releaseLock(lockFile, token);
      throw e;
    }
    return () => this.#releaseWriter();
  }

  #releaseWriter(): void {
    const w = this.#writer;
    if (!w) return;
    this.flush();
    fs.closeSync(w.fd);
    this.#writer = null;
    releaseLock(path.join(this.dir, LOCK), w.token);
  }

  /** Redacts, validates, assigns seq/ts, appends + fsyncs, then updates derived state. */
  append(input: RunEventInput): RunEvent {
    if (!this.#writer) throw new Error("append requires the writer lock");
    const candidate = this.redactor.value({ ...input, seq: this.#state.lastSeq + 1, ts: new Date().toISOString() });
    const ev = RunEvent.parse(candidate);
    writeAllSync(this.#writer.fd, JSON.stringify(ev) + "\n");
    fs.fsyncSync(this.#writer.fd);
    reduceInto(this.#state, ev);
    if (ev.type === "worker_event") this.#scheduleStateWrite();
    else this.flush();
    return ev;
  }

  #scheduleStateWrite(): void {
    if (this.#stateTimer) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.flush();
    }, STATE_THROTTLE_MS);
    this.#stateTimer.unref();
  }

  /** Writes state.json now (atomically). */
  flush(): void {
    if (this.#stateTimer) {
      clearTimeout(this.#stateTimer);
      this.#stateTimer = null;
    }
    writeFileAtomicSync(this.stateFile, JSON.stringify(this.#state, null, 2) + "\n");
  }

  /** steps/<stepId>/ with inputs/, out/ and artifacts/ subdirectories. */
  stepDir(stepId: string): string {
    if (!STEP_ID_RE.test(stepId)) throw new Error(`invalid step id '${stepId}'`);
    const d = path.join(this.dir, "steps", stepId);
    for (const sub of ["inputs", "out", "artifacts"]) fs.mkdirSync(path.join(d, sub), { recursive: true });
    return d;
  }

  /** Out-of-band cancel request for a driver running in another process. */
  requestCancel(): void {
    fs.writeFileSync(path.join(this.dir, CANCEL), new Date().toISOString());
  }

  cancelRequested(): boolean {
    return fs.existsSync(path.join(this.dir, CANCEL));
  }
}

export interface ListedRun {
  runId: string;
  state?: RunState;
  error?: string;
}

export type NewRunInit = Omit<RunCreatedEvent, "type" | "seq" | "ts" | "runId"> & { runId?: string };

export class RunStore {
  readonly runsDir: string;

  constructor(
    readonly dataDir: string,
    readonly redactor: Redactor = Redactor.fromEnv(),
  ) {
    this.runsDir = path.join(dataDir, "runs");
  }

  create(init: NewRunInit): RunHandle {
    const runId = init.runId ?? newRunId();
    if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id '${runId}'`);
    fs.mkdirSync(this.runsDir, { recursive: true });
    const dir = path.join(this.runsDir, runId);
    fs.mkdirSync(dir); // throws EEXIST: run ids are never reused
    const { runId: _ignored, ...rest } = init;
    const ev = RunEvent.parse(
      this.redactor.value({ ...rest, type: "run_created", runId, seq: 1, ts: new Date().toISOString() }),
    );
    const fd = fs.openSync(path.join(dir, EVENTS), "wx");
    try {
      writeAllSync(fd, JSON.stringify(ev) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const handle = new RunHandle(runId, dir, this.redactor);
    writeFileAtomicSync(handle.stateFile, JSON.stringify(handle.state(), null, 2) + "\n");
    return handle;
  }

  open(runId: string): RunHandle {
    if (!RUN_ID_RE.test(runId)) throw new RunNotFoundError(`invalid run id '${runId}'`);
    const dir = path.join(this.runsDir, runId);
    if (!fs.existsSync(path.join(dir, EVENTS))) throw new RunNotFoundError(`no run ${runId}`);
    return new RunHandle(runId, dir, this.redactor);
  }

  /** Newest first. Uses state.json when present, else reduces the log. */
  list(): ListedRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.runsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: ListedRun[] = [];
    for (const runId of names.filter((n) => RUN_ID_RE.test(n)).sort().reverse()) {
      try {
        const st = readJsonIfExists<RunState>(path.join(this.runsDir, runId, STATE));
        out.push({ runId, state: st ?? this.open(runId).state() });
      } catch (e) {
        out.push({ runId, error: (e as Error).message });
      }
    }
    return out;
  }
}
