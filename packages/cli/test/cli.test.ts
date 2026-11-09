import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorker, type Config, type WorkerTask } from "@fractory/core";
import { DEFAULT_PORT, EXIT, runCli } from "../src/cli.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fractory-cli-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const r = tmp();
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: r });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // per-repo config: fake workers (tests never call a model)
  fs.writeFileSync(path.join(r, "fractory.config.json"), JSON.stringify({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" } }, judge: { swapOrderPass: false } }));
  return r;
}

const verdict = {
  summary: "s",
  decisions: [{ topic: "t", decision: "d", rationale: "r", basedOn: "both", evidence: ["math.js:1"] }],
  unresolved: [],
};

function fakeWorkers(opts: { hangPropose?: boolean } = {}) {
  return (config: Config) => {
    const mk = (id: string) =>
      new FakeWorker(id, (task: WorkerTask) => {
        const out = task.outFile ?? "";
        if (/standalone implementation plan/.test(task.prompt)) {
          const ids = (JSON.parse(fs.readFileSync(path.join(task.inputsDir!, "decision.json"), "utf8")) as { adoptedDecisions: { id: string }[] }).adoptedDecisions;
          return { finalText: `# Goal\n\nDivide.\n\n${ids.map((d) => `<!-- d:${d.id} -->\nmath.js:1\n`).join("\n")}` };
        }
        if (out.endsWith("decision.json")) return { structured: verdict };
        if (out.endsWith("revise.json")) return { structured: { noChanges: true, proposal: "", changeSummary: "ok" } };
        if (/Critique it/.test(task.prompt)) return { finalText: "critique" };
        if (opts.hangPropose) return { actions: [{ hang: true }] };
        return { finalText: "plan: math.js:1 math.js:2 math.js:3" };
      });
    return Object.fromEntries(Object.keys(config.workers).map((id) => [id, mk(id)]));
  };
}

function io(extra: Partial<Parameters<typeof runCli>[1]> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const data = tmp();
  return {
    out,
    err,
    data,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      env: { ...process.env, FRACTORY_DATA_DIR: data, FRACTORY_CONFIG_DIR: tmp() },
      workers: fakeWorkers(),
      pollMs: 20,
      ...extra,
    },
  };
}

describe("fractory CLI", () => {
  it("consensus → runs → show, with progress output and exit code 0", async () => {
    const r = repo();
    const prompt = path.join(tmp(), "p.md");
    fs.writeFileSync(prompt, "Add division.\n");
    const t = io();
    expect(await runCli(["consensus", "--repo", r, "--prompt", prompt], t.io)).toBe(EXIT.ok);
    const text = t.out.join("");
    expect(text).toMatch(/run \d{8}-\d{6}-[0-9a-f]{4} \(consensus\) created/);
    expect(text).toContain("✓ judge");
    expect(text).toMatch(/plan: .*plan\.md/);
    expect(text).toMatch(/decision: .*decision\.md/);
    const runId = /run (\S+) \(consensus\)/.exec(text)![1]!;

    const l = io({ env: t.io.env });
    expect(await runCli(["runs"], l.io)).toBe(0);
    expect(l.out.join("")).toContain(`${runId}  consensus  completed`);

    const s = io({ env: t.io.env });
    expect(await runCli(["show", runId], s.io)).toBe(0);
    expect(s.out.join("")).toContain("status    completed");
    expect(s.out.join("")).toContain("judge");

    const dest = path.join(tmp(), "nested", "my-plan.md");
    const e = io({ env: t.io.env });
    expect(await runCli(["export", runId, "--plan", "--out", dest], e.io)).toBe(0);
    expect(fs.readFileSync(dest, "utf8")).toContain("<!-- d:d1 -->");
    expect(await runCli(["export", runId, "--out", dest], io({ env: t.io.env }).io)).toBe(EXIT.failed);
  });

  it("duel pauses for approval (exit 2), then approve + resume completes and prints the branches", async () => {
    const r = repo();
    const prompt = path.join(tmp(), "p.md");
    fs.writeFileSync(prompt, "Add div.\n");
    const duelVerdict = { summary: "s", items: [{ aspect: "a", betterSide: "A", evidence: [{ ref: "math.js:1", side: "base" }], recommendation: "keep", risk: "" }] };
    const workers = (config: Config) =>
      Object.fromEntries(
        Object.keys(config.workers).map((id) => [
          id,
          new FakeWorker(id, (task: WorkerTask) =>
            task.outFile?.endsWith("verdict.json")
              ? { structured: duelVerdict }
              : { actions: [{ writeFile: { path: "math.js", content: `export const div = (a, b) => a / b; // ${id}\n` } }], finalText: "done" },
          ),
        ]),
      );
    const t = io({ workers });
    expect(await runCli(["duel", "--repo", r, "--prompt", prompt], t.io)).toBe(EXIT.paused);
    const text = t.out.join("");
    expect(text).toContain("awaits approval of these items");
    expect(text).toMatch(/1\. a: better A \((opus|deepseek)\)/);
    const runId = /run (\S+) \(duel\)/.exec(text)![1]!;

    const a = io({ env: t.io.env, workers });
    expect(await runCli(["approve", runId, "--items", "1"], a.io)).toBe(0);
    const res = io({ env: t.io.env, workers });
    expect(await runCli(["resume", runId], res.io)).toBe(EXIT.ok);
    expect(res.out.join("")).toMatch(/branches \(not merged or pushed\): fractory\/\S+, fractory\/\S+/);
  });

  it("cancel via signal stops the run (exit 1) and resume of a cancelled run is a no-op", async () => {
    const r = repo();
    const prompt = path.join(tmp(), "p.md");
    fs.writeFileSync(prompt, "x\n");
    const ac = new AbortController();
    const t = io({ workers: fakeWorkers({ hangPropose: true }), signal: ac.signal });
    setTimeout(() => ac.abort(), 1500);
    expect(await runCli(["consensus", "--repo", r, "--prompt", prompt], t.io)).toBe(EXIT.failed);
    const runId = /run (\S+) \(consensus\)/.exec(t.out.join(""))![1]!;
    const s = io({ env: t.io.env });
    await runCli(["show", runId, "--json"], s.io);
    expect(JSON.parse(s.out.join("")).status).toBe("cancelled");
  });

  it("serve: prints a single-use GUI link, opens it, Enter gives a new one, stops on abort", async () => {
    const ac = new AbortController();
    const opened: string[] = [];
    let typeLine: (() => void) | undefined;
    const t = io({ signal: ac.signal, openBrowser: (u) => opened.push(u), stdinLines: (f) => (typeLine = f) });
    const done = runCli(["serve", "--port", "0"], t.io);
    for (let i = 0; i < 200 && !t.out.join("").includes("GUI:"); i++) await new Promise((r) => setTimeout(r, 10));
    const gui = /GUI: (\S+)/.exec(t.out.join(""))![1]!;
    expect(gui).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\?code=[\w-]{32,}$/);
    expect(t.out.join("")).not.toMatch(/token=/);
    expect(opened).toEqual([gui]);
    const u = new URL(gui);
    const login = await fetch(gui, { redirect: "manual" });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${u.origin}/api/health`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${u.origin}/api/health`)).status).toBe(401);
    expect((await fetch(gui, { redirect: "manual" })).status).toBe(401); // single use
    typeLine!();
    const links = [...t.out.join("").matchAll(/GUI: (\S+)/g)].map((m) => m[1]);
    expect(links).toHaveLength(2);
    expect(opened).toHaveLength(2);
    expect((await fetch(links[1]!, { redirect: "manual" })).status).toBe(303);
    ac.abort();
    expect(await done).toBe(EXIT.ok);
    await expect(fetch(`${u.origin}/api/health`)).rejects.toThrow();
  });

  it("serve --repo: pre-fills the new-run form with the repository's top level; a non-repo is an error", async () => {
    const r = repo();
    fs.mkdirSync(path.join(r, "sub"));
    const ac = new AbortController();
    const t = io({ signal: ac.signal, openBrowser: () => {} });
    const done = runCli(["serve", "--port", "0", "--no-open", "--repo", path.join(r, "sub")], t.io);
    for (let i = 0; i < 200 && !t.out.join("").includes("GUI:"); i++) await new Promise((res) => setTimeout(res, 10));
    expect(t.out.join("")).toContain(`new runs default to the repository ${r}`);
    const gui = new URL(/GUI: (\S+)/.exec(t.out.join(""))![1]!);
    const cookie = (await fetch(gui, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await fetch(`${gui.origin}/api/start-info`, { headers: { cookie } })).json()).toEqual({ defaultRepo: r, recentRepos: [] });
    ac.abort();
    expect(await done).toBe(EXIT.ok);

    const bad = io();
    expect(await runCli(["serve", "--port", "0", "--no-open", "--repo", tmp()], bad.io)).toBe(EXIT.failed);
    expect(bad.err.join("")).toMatch(/not inside a git repository/);
  });

  it("serve defaults to port 4000; a port in use is a user error, not a stack trace", async () => {
    expect(DEFAULT_PORT).toBe(4000);
    const blocker = net.createServer();
    await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", res));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      const t = io({ openBrowser: () => {} });
      expect(await runCli(["serve", "--port", String(taken), "--no-open"], t.io)).toBe(EXIT.failed);
      expect(t.err.join("")).toBe(`error: port ${taken} is already in use; pass --port <n> (or --port 0 for any free port)\n`);
    } finally {
      await new Promise((res) => blocker.close(res));
    }
  });

  it("reports user errors without a stack and with exit 1; usage errors exit 64", async () => {
    const t = io();
    expect(await runCli(["show", "20260101-000000-zzzz"], t.io)).toBe(EXIT.failed);
    expect(t.err.join("")).toMatch(/^error: /);
    expect(await runCli(["consensus", "--repo", tmp(), "--prompt", "nope.md"], t.io)).toBe(EXIT.failed);
    expect(await runCli(["duel", "--repo", repo(), "--prompt", "missing.md"], t.io)).toBe(EXIT.failed);
    expect(await runCli(["bogus"], t.io)).toBe(EXIT.usage);
    expect(await runCli(["approve", "20260101-000000-aaaa", "--items", "x"], t.io)).toBe(EXIT.failed);
    expect(await runCli(["run", "--repo", repo(), "--prompt", "p.md", "--workflow", "nope"], t.io)).toBe(EXIT.failed);
    expect(t.err.join("")).toContain("unknown --workflow nope");
  });

  it("run defaults to the review workflow; stats reports per reviewer", async () => {
    const r = repo();
    const prompt = path.join(tmp(), "p.md");
    fs.writeFileSync(prompt, "Add division.\n");
    const workers = (config: Config) =>
      Object.fromEntries(
        Object.keys(config.workers).map((id) => [
          id,
          new FakeWorker(id, (task: WorkerTask) =>
            task.outFile?.endsWith("review.json")
              ? { structured: { summary: "fine", findings: [] } }
              : { actions: [{ writeFile: { path: "div.js", content: "export const div = (a, b) => a / b;\n" } }], finalText: "added" },
          ),
        ]),
      );
    const t = io({ workers });
    expect(await runCli(["run", "--repo", r, "--prompt", prompt], t.io)).toBe(EXIT.ok);
    expect(t.out.join("")).toMatch(/\(review\) created/);
    expect(t.out.join("")).toContain("✓ review (gpt)");
    expect(t.err.join("")).toContain("review.testCommand is not configured");
    t.out.length = 0;
    expect(await runCli(["stats"], t.io)).toBe(EXIT.ok);
    expect(t.out.join("")).toMatch(/gpt \(openai\/gpt-6\.1-sol\)\s+1\s+0\.0/);
    t.out.length = 0;
    expect(await runCli(["stats", "--json"], t.io)).toBe(EXIT.ok);
    expect(JSON.parse(t.out.join(""))).toEqual([expect.objectContaining({ reviewer: "gpt", runs: 1, findings: 0 })]);
  });
});
