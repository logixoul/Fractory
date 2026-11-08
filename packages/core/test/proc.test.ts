import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv, withoutEnv } from "../src/util/env.js";
import { isPidAlive } from "../src/util/fsx.js";
import { runProcess, streamProcess, type ProcItem } from "../src/util/proc.js";
import { tmpDir, waitFor } from "./helpers.js";

const node = process.execPath;
const base = (args: string[], over: Partial<Parameters<typeof streamProcess>[0]> = {}) => ({
  command: node,
  args,
  cwd: tmpDir(),
  env: process.env,
  timeoutMs: 10_000,
  ...over,
});

async function collect(it: AsyncIterable<ProcItem>): Promise<ProcItem[]> {
  const out: ProcItem[] = [];
  for await (const i of it) out.push(i);
  return out;
}

describe("process runner", () => {
  it("streams stdout/stderr lines, passes stdin, reports the exit code", async () => {
    const items = await collect(
      streamProcess(
        base([
          "-e",
          "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write('a\\r\\nb:'+s+'\\n');process.stderr.write('warn\\n');process.exit(3)})",
        ], { stdin: "hello" }),
      ),
    );
    expect(items.filter((i) => i.kind === "stdout").map((i) => (i as { line: string }).line)).toEqual(["a", "b:hello"]);
    expect(items.filter((i) => i.kind === "stderr")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ kind: "end", code: 3, reason: "exit" });
  });

  it("kills the whole process tree on timeout (no orphan grandchild)", async () => {
    const dir = tmpDir();
    const pidFile = path.join(dir, "pid");
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const t0 = Date.now();
    const r = await runProcess(base(["-e", script], { timeoutMs: 1500 }));
    expect(r.reason).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(8000);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => !isPidAlive(grandchild), 5000);
  });

  it("kills on abort and when the consumer stops iterating", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runProcess(base(["-e", "setInterval(()=>{},1000)"], { signal: ac.signal }));
    expect(r.reason).toBe("aborted");

    const gen = streamProcess(base(["-e", "console.log('x');setInterval(()=>{},1000)"]));
    const first = await gen.next();
    expect(first.value).toMatchObject({ kind: "stdout", line: "x" });
    const t0 = Date.now();
    await gen.return(undefined);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("reports a missing executable as spawn_error", async () => {
    const r = await runProcess(base([], { command: "fractory-definitely-not-a-command" }));
    expect(r.reason === "spawn_error" || (r.reason === "exit" && r.code !== 0)).toBe(true);
  });

  it("removes env vars case-insensitively", () => {
    const env = withoutEnv({ ANTHROPIC_API_KEY: "a", anthropic_base_url: "b", PATH: "p" }, ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    expect(env).toEqual({ PATH: "p" });
    expect(withEnv({ Path: "x" }, { PATH: "y" })).toEqual({ PATH: "y" });
  });
});
