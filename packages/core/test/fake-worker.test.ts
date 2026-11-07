import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerEventInput } from "../src/schemas/worker-events.js";
import { FakeWorker } from "../src/workers/fake.js";
import type { WorkerTask } from "../src/workers/types.js";
import { tmpDir } from "./helpers.js";

const task = (over: Partial<WorkerTask> = {}): WorkerTask => ({
  prompt: "do it",
  cwd: tmpDir(),
  mode: "read-only",
  timeoutMs: 5000,
  signal: new AbortController().signal,
  ...over,
});

async function collect(it: AsyncIterable<WorkerEventInput>): Promise<WorkerEventInput[]> {
  const out: WorkerEventInput[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("FakeWorker", () => {
  it("emits start…done, records calls, keeps a resumed session id", async () => {
    const w = new FakeWorker("opus", [{ finalText: "one", repeat: true }]);
    const first = await collect(w.run(task()));
    expect(first[0]).toMatchObject({ type: "start", sessionId: "fake-opus-0" });
    expect(first.at(-1)).toMatchObject({ type: "done", sessionId: "fake-opus-0", finalText: "one" });
    const resumed = await collect(w.run(task({ sessionId: "fake-opus-0" })));
    expect(resumed.at(-1)).toMatchObject({ sessionId: "fake-opus-0" });
    expect(w.calls).toHaveLength(2);
  });

  it("matches scripts by prompt and consumes non-repeating ones", async () => {
    const w = new FakeWorker("w", [
      { match: "critique", finalText: "C" },
      { match: /propose/, finalText: "P" },
    ]);
    expect((await collect(w.run(task({ prompt: "please propose" })))).at(-1)).toMatchObject({ finalText: "P" });
    expect((await collect(w.run(task({ prompt: "critique this" })))).at(-1)).toMatchObject({ finalText: "C" });
    expect((await collect(w.run(task({ prompt: "propose again" })))).at(-1)).toMatchObject({ type: "error", kind: "protocol" });
  });

  it("times out a hang", async () => {
    const w = new FakeWorker("w", [{ actions: [{ hang: true }] }]);
    const t0 = Date.now();
    const evs = await collect(w.run(task({ timeoutMs: 50 })));
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("stops promptly on abort", async () => {
    const ac = new AbortController();
    const w = new FakeWorker("w", [{ actions: [{ hang: true }] }]);
    setTimeout(() => ac.abort(), 20);
    const evs = await collect(w.run(task({ signal: ac.signal })));
    expect(evs.at(-1)).toMatchObject({ type: "error", kind: "killed" });
  });

  it("writes and removes files relative to cwd", async () => {
    const cwd = tmpDir();
    const w = new FakeWorker("w", [
      { actions: [{ writeFile: { path: "src/a.ts", content: "x" } }, { writeFile: { path: "b.txt", content: "y" } }, { removeFile: "b.txt" }] },
    ]);
    await collect(w.run(task({ cwd })));
    expect(fs.readFileSync(path.join(cwd, "src", "a.ts"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
  });
});
