import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { reduceAll } from "../src/state/reducer.js";
import { CorruptLogError, LockedError, RunNotFoundError, RunStore, readEventsFile } from "../src/store/run-store.js";
import { REDACTED, Redactor } from "../src/util/redact.js";
import { newTestRun, tmpDir } from "./helpers.js";

const store = () => new RunStore(tmpDir(), new Redactor([]));

describe("RunStore", () => {
  it("appends events with monotonic seq and a matching state.json", () => {
    const s = store();
    const run = newTestRun(s);
    const release = run.acquireWriter();
    run.append({ type: "driver_started", pid: 1, hostname: "h" });
    run.append({ type: "step_started", stepId: "a", attempt: 1 });
    run.append({ type: "step_completed", stepId: "a", attempt: 1, result: { x: 1 }, durationMs: 3 });
    release();
    const events = run.events();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(fs.readFileSync(run.stateFile, "utf8"))).toEqual(reduceAll(events));
    expect(run.state().steps.a?.status).toBe("completed");
  });

  it("only the writer may append; a second writer is locked out", () => {
    const s = store();
    const run = newTestRun(s);
    expect(() => run.append({ type: "cancel_requested" })).toThrow(/writer lock/);
    const release = run.acquireWriter();
    const other = s.open(run.runId);
    expect(() => other.acquireWriter()).toThrow(LockedError);
    release();
    const r2 = other.acquireWriter();
    other.append({ type: "cancel_requested" });
    r2();
    expect(run.events()).toHaveLength(2);
  });

  it("takes over a stale lock left by a dead process", () => {
    const s = store();
    const run = newTestRun(s);
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    fs.writeFileSync(
      path.join(run.dir, "driver.lock"),
      JSON.stringify({ pid: deadPid, hostname: os.hostname(), startedAt: "x", token: "t" }),
    );
    const release = run.acquireWriter();
    release();
    expect(fs.existsSync(path.join(run.dir, "driver.lock"))).toBe(false);
  });

  it("ignores a torn final line on read and repairs it when a writer opens", () => {
    const s = store();
    const run = newTestRun(s);
    fs.appendFileSync(run.eventsFile, '{"seq":2,"ts":"x","type":"cancel_req');
    const r = readEventsFile(run.eventsFile);
    expect(r.events).toHaveLength(1);
    expect(r.tornTailBytes).toBeGreaterThan(0);
    const reader = s.open(run.runId);
    expect(reader.state().lastSeq).toBe(1);
    const release = reader.acquireWriter();
    const ev = reader.append({ type: "cancel_requested" });
    release();
    expect(ev.seq).toBe(2);
    const after = readEventsFile(run.eventsFile);
    expect(after.tornTailBytes).toBe(0);
    expect(after.events.map((e) => e.type)).toEqual(["run_created", "cancel_requested"]);
  });

  it("refuses a log with a corrupt line in the middle or a seq gap", () => {
    const s = store();
    const run = newTestRun(s);
    fs.appendFileSync(run.eventsFile, "garbage\n");
    expect(() => s.open(run.runId)).toThrow(CorruptLogError);
    const run2 = newTestRun(s);
    fs.appendFileSync(run2.eventsFile, JSON.stringify({ seq: 5, ts: "x", type: "cancel_requested" }) + "\n");
    expect(() => s.open(run2.runId)).toThrow(/expected seq 2/);
  });

  it("redacts secrets before anything reaches disk", () => {
    const s = new RunStore(tmpDir(), new Redactor(["supersecretvalue"]));
    const run = newTestRun(s);
    const release = run.acquireWriter();
    run.append({ type: "step_started", stepId: "a", attempt: 1 });
    run.append({
      type: "worker_event",
      stepId: "a",
      attempt: 1,
      event: { type: "noise", stream: "stderr", text: "key=supersecretvalue" },
    });
    release();
    const raw = fs.readFileSync(run.eventsFile, "utf8") + fs.readFileSync(run.stateFile, "utf8");
    expect(raw).not.toContain("supersecretvalue");
    expect(raw).toContain(REDACTED);
  });

  it("rejects path-traversing run ids and invalid step ids", () => {
    const s = store();
    expect(() => s.open("../../etc")).toThrow(RunNotFoundError);
    expect(() => s.create({ ...baseInit(), runId: "../x" })).toThrow(/invalid run id/);
    const run = newTestRun(s);
    expect(() => run.stepDir("../escape")).toThrow(/invalid step id/);
    const d = run.stepDir("propose.a7f2");
    for (const sub of ["inputs", "out", "artifacts"]) expect(fs.statSync(path.join(d, sub)).isDirectory()).toBe(true);
  });

  it("lists runs newest first", () => {
    const s = store();
    const a = s.create({ ...baseInit(), runId: "20260101-000000-aaaa" });
    const b = s.create({ ...baseInit(), runId: "20260102-000000-bbbb" });
    expect(s.list().map((r) => r.runId)).toEqual([b.runId, a.runId]);
    expect(s.list()[0]?.state?.status).toBe("running");
  });
});

function baseInit() {
  return {
    workflow: "test" as const,
    repo: "/r",
    promptFile: "p",
    promptSha256: "x",
    labels: { a1b2: "opus", c3d4: "deepseek" },
    roles: { contestants: ["opus", "deepseek"] as [string, string], judge: "deepseek" },
    seed: 1,
    config: {},
    fractoryVersion: "test",
  };
}
