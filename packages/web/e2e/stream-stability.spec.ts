// While a worker streams (e.g. judge reasoning), the Compare view must stay put: no refetch or
// re-render of the documents or diffs, no jump back to the top. Fake workers only (no model calls).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = (p: string) => pathToFileURL(path.join(root, p)).href;

interface Daemon {
  url: string;
  token: string;
  newGuiUrl(): string;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
test.afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const MATH = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n";
const long = (who: string) => Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the plan by ${who}: change math.js:1, math.js:2 and math.js:3 carefully.`).join("\n\n");
// The judge streams reasoning for ~20 s before answering.
const streaming = Array.from({ length: 400 }, (_, i) => [{ emit: { type: "thinking", text: `reasoning chunk ${i} ` } }, { delayMs: 50 }]).flat();

/** Starts a daemon with fake workers and a run of `workflow`; resolves once its judge is streaming. */
async function runUntilJudging(workflow: "consensus" | "duel"): Promise<{ daemon: Daemon; runId: string }> {
  const core = await import(dist("packages/core/dist/index.js"));
  const { startDaemon } = await import(dist("packages/daemon/dist/index.js"));
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fractory-e2e-stream-")));
  cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo });
  fs.writeFileSync(path.join(repo, "math.js"), MATH);
  fs.writeFileSync(path.join(repo, "fractory.config.json"), JSON.stringify({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } }, judge: { swapOrderPass: false } }));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const decision = { summary: "s", decisions: [{ topic: "t", decision: "d", rationale: "r", basedOn: "both", evidence: ["math.js:1"] }], unresolved: [] };
  const verdict = { summary: "s", items: [{ aspect: "a", betterSide: "A", evidence: [{ ref: "math.js:1", side: "A" }], recommendation: "r", risk: "" }] };
  const workers = (config: { workers: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.keys(config.workers).map((id) => [
        id,
        new core.FakeWorker(id, (t: { outFile?: string }) => {
          const out = t.outFile ?? "";
          if (out.endsWith("decision.json")) return { actions: streaming, structured: decision };
          if (out.endsWith("verdict.json")) return { actions: streaming, structured: verdict };
          if (out.endsWith("revise.json")) return { structured: { noChanges: true, proposal: "", changeSummary: "" } };
          if (workflow === "duel") {
            const body = Array.from({ length: 200 }, (_, i) => `export const f${i} = () => ${i}; // ${id}`).join("\n");
            return { actions: [{ writeFile: { path: "math.js", content: `${MATH}${body}\n` } }], finalText: "done" };
          }
          return { finalText: long(id) };
        }),
      ]),
    );
  const daemon: Daemon = await startDaemon({ dataDir: path.join(scratch, "data"), configDir: path.join(scratch, "cfg"), workers, webDir: path.join(root, "packages/web/dist") });
  cleanups.push(() => daemon.close());
  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${daemon.url}${p}`, { ...init, headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const runId = ((await (await api("/api/runs", { method: "POST", body: JSON.stringify({ workflow, repo, prompt: "Plan div." }) })).json()) as { runId: string }).runId;
  let last: { status: string; failure?: unknown; steps: Record<string, { status: string }> } | undefined;
  for (let i = 0; i < 600; i++) {
    last = (await (await api(`/api/runs/${runId}`)).json()) as typeof last;
    if (last!.steps.judge?.status === "running") return { daemon, runId };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the fake ${workflow} never reached the judge step: ${JSON.stringify({ status: last?.status, failure: last?.failure })}`);
}

/** Watches `ms` of streaming: content requests made, "loading…" placeholders shown, final scroll. */
async function observe(page: Page, ms: number) {
  const requests: string[] = [];
  const onReq = (r: { url(): string }) => {
    if (/\/api\/runs\/[^/]+\/(file|blob|changes|diff)/.test(r.url())) requests.push(new URL(r.url()).pathname);
  };
  page.on("request", onReq);
  await page.evaluate(() => {
    const w = window as unknown as { __loading: number };
    w.__loading = 0;
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.textContent?.includes("loading…")) w.__loading++;
    }).observe(document.querySelector("main")!, { childList: true, subtree: true });
  });
  await page.waitForTimeout(ms);
  page.off("request", onReq);
  const r = await page.evaluate(() => ({ y: window.scrollY, loading: (window as unknown as { __loading: number }).__loading }));
  return { ...r, requests };
}

test("consensus Compare stays put while the judge streams", async ({ page }) => {
  const { daemon, runId } = await runUntilJudging("consensus");
  await page.goto(daemon.newGuiUrl());
  await page.goto(`${daemon.url}/#/run/${runId}/compare`);
  await expect(page.getByText("Paragraph 120 of the plan").first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 2000));
  expect(await observe(page, 3000)).toEqual({ y: 2000, loading: 0, requests: [] });
});

test("duel Compare diff stays put while the judge streams", async ({ page }) => {
  const { daemon, runId } = await runUntilJudging("duel");
  await page.goto(daemon.newGuiUrl());
  await page.goto(`${daemon.url}/#/run/${runId}/compare`);
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.locator(".monaco-diff-editor .line-insert, .monaco-diff-editor .char-insert").first()).toBeAttached();
  expect(await observe(page, 3000)).toEqual({ y: 0, loading: 0, requests: [] });
});
