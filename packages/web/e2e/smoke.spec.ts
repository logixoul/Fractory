// GUI smoke test: runs list → open run → compare view renders the Monaco diff → approve one
// item → state updates. The daemon runs in this process with fake workers (no model is called).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = (p: string) => pathToFileURL(path.join(root, p)).href;

interface Daemon {
  url: string;
  token: string;
  newGuiUrl(): string;
  close(): Promise<void>;
}

let daemon: Daemon;
let runId: string;
let scratch: string;

test.beforeAll(async () => {
  const core = await import(dist("packages/core/dist/index.js"));
  const { startDaemon } = await import(dist("packages/daemon/dist/index.js"));
  scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fractory-e2e-")));
  const repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false", ...a], { cwd: repo });
  fs.writeFileSync(path.join(repo, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(repo, "fractory.config.json"), JSON.stringify({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" }, glm: { kind: "fake" } } }));
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const verdict = {
    summary: "Both add div; one guards against division by zero.",
    items: [
      // cites the better side (math.js:3) and the losing side's own copy of side.js
      { aspect: "zero guard", betterSide: "A", evidence: ["math.js:3", "B: side.js:1"], recommendation: "guard b === 0", risk: "low" },
      { aspect: "naming", betterSide: "B", evidence: ["math.js:1"], recommendation: "keep names", risk: "" },
    ],
  };
  const workers = (config: { workers: Record<string, unknown> }) =>
    Object.fromEntries(
      Object.keys(config.workers).map((id) => [
        id,
        new core.FakeWorker(id, (t: { outFile?: string; prompt: string }) =>
          t.outFile?.endsWith("verdict.json")
            ? { structured: verdict }
            : {
                actions: [
                  { writeFile: { path: "side.js", content: `// side file by ${id}\n` } },
                  {
                    writeFile: {
                      path: "math.js",
                      content: `export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const div = (a, b) => ${id === "opus" && !/approved these items/.test(t.prompt) ? "a / b" : "(b === 0 ? NaN : a / b)"};\n`,
                    },
                  },
                ],
                finalText: "done",
              },
        ),
      ]),
    );
  daemon = await startDaemon({ dataDir: path.join(scratch, "data"), configDir: path.join(scratch, "cfg"), workers, webDir: path.join(root, "packages/web/dist") });
  const api = (p: string, init: RequestInit = {}) =>
    fetch(`${daemon.url}${p}`, { ...init, headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  runId = ((await (await api("/api/runs", { method: "POST", body: JSON.stringify({ workflow: "duel", repo, prompt: "Add div." }) })).json()) as { runId: string }).runId;
  for (let i = 0; i < 600; i++) {
    const st = (await (await api(`/api/runs/${runId}`)).json()) as { status: string; driving: boolean };
    if (st.status === "awaiting_approval" && !st.driving) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the fake duel never reached the approval gate");
});

test.afterAll(async () => {
  await daemon?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test("runs list → run → Monaco diff → approve one item → state updates", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));

  // single-use login link → cookie → redirect to the runs list; the code does not stay in the URL
  await page.goto(daemon.newGuiUrl());
  await expect(page).toHaveURL(`${daemon.url}/`);
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

  // runs list → open the run
  await page.getByRole("link", { name: runId }).click();
  await expect(page).toHaveURL(new RegExp(`#/run/${runId}$`));
  await expect(page.locator("h2 .badge")).toHaveText("awaiting_approval");

  // compare view: Monaco side-by-side diff with insertions
  await page.getByRole("link", { name: "Compare" }).click();
  await expect(page.locator(".files button", { hasText: "math.js" })).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.locator(".monaco-diff-editor .line-insert, .monaco-diff-editor .char-insert").first()).toBeAttached();

  // verdict: approve item 1 and resume; the state updates live to completed
  await page.getByRole("link", { name: /Verdict/ }).click();

  // a path:line ref opens the in-app read-only view at the commit it refers to, line highlighted
  await page.locator("a.ref", { hasText: "math.js:3" }).first().click();
  const dialog = page.getByRole("dialog", { name: "math.js:3" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/head at judging/)).toBeVisible();
  await expect(dialog.locator(".monaco-editor .ref-line")).toBeAttached();
  await expect(dialog.locator(".monaco-editor")).toContainText("export const div");
  await expect(dialog.getByRole("link", { name: /^Open in VS Code: .* worktree$/ })).toHaveAttribute("href", /^vscode:\/\/file\/.+math\.js:3$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // a ref into the losing side (item 1 is better on A, cites B's side.js) shows B's own file
  const sidesText = await page.getByText(/A = \w+, B = \w+\./).textContent();
  const [, aWorker, bWorker] = /A = (\w+), B = (\w+)\./.exec(sidesText ?? "")!;
  await page.locator("a.ref", { hasText: "side.js:1" }).first().click();
  const losing = page.getByRole("dialog", { name: "side.js:1" });
  await expect(losing).toBeVisible();
  await expect(losing.locator(".monaco-editor")).toContainText(`side file by ${bWorker}`);
  await expect(losing.locator(".monaco-editor")).not.toContainText(`side file by ${aWorker}`);
  await expect(losing.getByText(new RegExp(`${bWorker} \\(\\w+\\) head at judging`))).toBeVisible();
  await expect(losing.getByRole("link", { name: new RegExp(`^Open in VS Code: ${bWorker} \\(\\w+\\) worktree$`) })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("checkbox", { name: "approve item 1" }).check();
  await page.getByRole("button", { name: "Approve 1 item(s) and resume" }).click();
  await expect(page.locator("h2 .badge")).toHaveText("completed", { timeout: 60_000 });
  await expect(page.locator("tr.on")).toHaveCount(1);
  await expect(page.getByText("Duel report")).toBeVisible();

  expect(problems).toEqual([]);
});
