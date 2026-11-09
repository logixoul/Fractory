import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorker, fakeQuotaExhausted, type Config, type WorkerTask } from "@fractory/core";
import { startDaemon, type Daemon } from "../src/server.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fractory-daemon-")));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function repo(): string {
  const r = tmp();
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: r });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(r, "fractory.config.json"), JSON.stringify({ workers: { opus: { kind: "fake" }, deepseek: { kind: "fake" } }, judge: { swapOrderPass: false } }));
  return r;
}

type Behaviour = { quota?: boolean; slow?: boolean };
function fakeWorkers(b: Behaviour = {}) {
  return (config: Config) =>
    Object.fromEntries(
      Object.keys(config.workers).map((id) => [
        id,
        new FakeWorker(id, (t: WorkerTask) => {
          const out = t.outFile ?? "";
          if (out.endsWith("decision.json"))
            return { structured: { summary: "s", decisions: [{ topic: "t", decision: "d", rationale: "r", basedOn: "A", evidence: ["math.js:1"] }], unresolved: [] } };
          if (out.endsWith("verdict.json"))
            return { structured: { summary: "s", items: [{ aspect: "a", betterSide: "B", evidence: [{ ref: "math.js:1", side: "B" }], recommendation: "r", risk: "" }] } };
          if (out.endsWith("revise.json")) return { structured: { noChanges: true, proposal: "", changeSummary: "" } };
          if (b.quota && id === "opus") return { actions: fakeQuotaExhausted(Date.now() + 3600_000) };
          if (/independently implementing|approved these items/.test(t.prompt))
            return { actions: [{ writeFile: { path: "math.js", content: `export const div = (a, b) => a / b; // ${id}\n` } }], finalText: "done" };
          return { actions: b.slow ? [{ delayMs: 300 }] : [], finalText: "plan math.js:1 math.js:2 math.js:3" };
        }),
      ]),
    );
}

async function daemon(b: Behaviour = {}, o: { defaultRepo?: string } = {}): Promise<Daemon & { data: string }> {
  const data = tmp();
  const d = await startDaemon({ dataDir: data, configDir: tmp(), workers: fakeWorkers(b), tailMs: 20, heartbeatMs: 50, ...o });
  cleanups.push(() => d.close());
  return { ...d, data };
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function req(d: Daemon, method: string, p: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port: d.port, method, path: p, headers: { host: `127.0.0.1:${d.port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      },
    );
    r.on("error", reject);
    if (body !== undefined) {
      r.setHeader("content-type", "application/json");
      r.end(typeof body === "string" ? body : JSON.stringify(body));
    } else r.end();
  });
}

const auth = (d: Daemon) => ({ authorization: `Bearer ${d.token}` });

/** Logs in like the browser: the single-use GUI link → session cookie. */
async function loginCookie(d: Daemon): Promise<string> {
  const link = new URL(d.newGuiUrl());
  const r = await req(d, "GET", link.pathname + link.search);
  expect(r.status).toBe(303);
  return String(r.headers["set-cookie"]).split(";")[0]!;
}
const api = async (d: Daemon, method: string, p: string, body?: unknown) => {
  const r = await req(d, method, p, auth(d), body);
  const isJson = String(r.headers["content-type"] ?? "").startsWith("application/json");
  return { ...r, json: isJson && r.body ? JSON.parse(r.body) : undefined };
};

/** Reads an SSE stream until `end` (or maxEvents), returning the run_event ids. */
function sse(d: Daemon, p: string, headers: Record<string, string> = {}, maxEvents = Infinity): Promise<{ ids: number[]; types: string[]; status: number }> {
  return new Promise((resolve, reject) => {
    const ids: number[] = [];
    const types: string[] = [];
    const r = http.request({ host: "127.0.0.1", port: d.port, path: p, headers: { host: `127.0.0.1:${d.port}`, ...auth(d), ...headers } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const field = (k: string) => frame.split("\n").find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
          const ev = field("event");
          if (ev === "run_event") {
            ids.push(Number(field("id")));
            types.push(JSON.parse(field("data")!).type);
            if (ids.length >= maxEvents) {
              r.destroy();
              resolve({ ids, types, status: res.statusCode! });
            }
          }
          if (ev === "end") {
            r.destroy();
            resolve({ ids, types, status: res.statusCode! });
          }
        }
      });
      res.on("end", () => resolve({ ids, types, status: res.statusCode! }));
    });
    r.on("error", (e) => (ids.length ? resolve({ ids, types, status: 200 }) : reject(e)));
    r.end();
  });
}

async function startRun(d: Daemon, workflow: "consensus" | "duel", r = repo()) {
  const res = await api(d, "POST", "/api/runs", { workflow, repo: r, prompt: "Add division." });
  expect(res.status).toBe(202);
  return res.json.runId as string;
}

async function waitStatus(d: Daemon, runId: string, statuses: string[]): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const s = (await api(d, "GET", `/api/runs/${runId}`)).json;
    if (statuses.includes(s.status) && !s.driving) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached ${statuses.join("/")}`);
}

describe("daemon security", () => {
  it("binds to 127.0.0.1 only; the GUI link carries a single-use code, never the token", async () => {
    const d = await daemon();
    expect(d.url).toBe(`http://127.0.0.1:${d.port}`);
    expect(d.guiUrl).toMatch(new RegExp(`^${d.url}/auth\\?code=[\\w-]{32,}$`));
    expect(d.guiUrl).not.toContain(d.token);
    expect(d.newGuiUrl()).not.toBe(d.guiUrl);
    expect(d.token.length).toBeGreaterThanOrEqual(43);
  });

  it("requires the token: none/wrong/?token= → 401; bearer → 200; a login code works once → cookie", async () => {
    const d = await daemon();
    expect((await req(d, "GET", "/api/health")).status).toBe(401);
    expect((await req(d, "GET", "/api/health", { authorization: "Bearer nope" })).status).toBe(401);
    // the token is never accepted from a URL
    expect((await req(d, "GET", `/api/health?token=${d.token}`)).status).toBe(401);
    expect((await req(d, "GET", "/api/health", auth(d))).status).toBe(200);
    const link = new URL(d.guiUrl);
    const login = await req(d, "GET", link.pathname + link.search);
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("/");
    const cookie = String(login.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect((await req(d, "GET", "/api/health", { cookie: cookie.split(";")[0]! })).status).toBe(200);
    // single use
    const again = await req(d, "GET", link.pathname + link.search);
    expect(again.status).toBe(401);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect((await req(d, "GET", "/auth?code=bogus")).status).toBe(401);
  });

  it("login codes expire after 60 s", async () => {
    let now = 1_000_000;
    const d = await startDaemon({ dataDir: tmp(), configDir: tmp(), workers: fakeWorkers(), now: () => now });
    cleanups.push(() => d.close());
    const link = new URL(d.newGuiUrl());
    now += 61_000;
    expect((await req(d, "GET", link.pathname + link.search)).status).toBe(401);
    const fresh = new URL(d.newGuiUrl());
    now += 59_000;
    expect((await req(d, "GET", fresh.pathname + fresh.search)).status).toBe(303);
  });

  it("rejects foreign Host headers (DNS rebinding) even with a valid token", async () => {
    const d = await daemon();
    for (const host of [`evil.example:${d.port}`, `127.0.0.1:${d.port + 1}`, "127.0.0.1", `0.0.0.0:${d.port}`]) {
      expect((await req(d, "GET", "/api/health", { ...auth(d), host })).status).toBe(403);
    }
    expect((await req(d, "GET", "/api/health", { ...auth(d), host: `localhost:${d.port}` })).status).toBe(200);
  });

  it("rejects foreign Origins and cross-site fetches (CSRF); cookie-only writes need our Origin", async () => {
    const d = await daemon();
    expect((await req(d, "GET", "/api/health", { ...auth(d), origin: "http://evil.example" })).status).toBe(403);
    expect((await req(d, "GET", "/api/health", { ...auth(d), origin: `http://127.0.0.1:${d.port + 1}` })).status).toBe(403);
    expect((await req(d, "GET", "/api/health", { ...auth(d), origin: d.url })).status).toBe(200);
    expect((await req(d, "GET", "/api/health", { ...auth(d), "sec-fetch-site": "cross-site" })).status).toBe(403);
    const cookie = await loginCookie(d);
    expect((await req(d, "POST", "/api/runs/20260101-000000-aaaa/cancel", { cookie })).status).toBe(403);
    expect((await req(d, "POST", "/api/runs/20260101-000000-aaaa/cancel", { cookie, origin: d.url })).status).toBe(404);
  });

  it("never sends CORS headers and refuses preflights", async () => {
    const d = await daemon();
    const pre = await req(d, "OPTIONS", "/api/runs", { ...auth(d), origin: d.url, "access-control-request-method": "POST" });
    expect(pre.status).toBe(405);
    for (const r of [pre, await req(d, "GET", "/api/health", { ...auth(d), origin: d.url }), await req(d, "GET", "/api/health")]) {
      expect(Object.keys(r.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
    }
  });

  it("validates bodies and confines file reads to the run directory", async () => {
    const d = await daemon();
    expect((await api(d, "POST", "/api/runs", { workflow: "consensus" })).status).toBe(400);
    expect((await api(d, "POST", "/api/runs", "{not json")).status).toBe(400);
    expect((await api(d, "POST", "/api/runs", { workflow: "x", repo: "r", prompt: "p" })).status).toBe(400);
    const runId = await startRun(d, "consensus");
    await waitStatus(d, runId, ["completed"]);
    for (const p of ["../../../../etc/passwd", "..", path.join(d.data, "quota.json"), "events.jsonl/../../x"]) {
      expect([403, 404]).toContain((await api(d, "GET", `/api/runs/${runId}/file?path=${encodeURIComponent(p)}`)).status);
    }
    const dec = await api(d, "GET", `/api/runs/${runId}/file?path=${encodeURIComponent("steps/judge/out/decision.md")}`);
    expect(dec.status).toBe(200);
    expect(dec.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // consensus refs: files at the base commit (no branches in consensus)
    const blob = await api(d, "GET", `/api/runs/${runId}/blob?rev=base&path=math.js`);
    expect(blob.status).toBe(200);
    expect(blob.body).toContain("export const add");
    const gone = await api(d, "GET", `/api/runs/${runId}/blob?rev=base&path=nope.js`);
    expect(gone.headers["x-fractory-missing"]).toBe("1");
  });
});

describe("daemon GUI serving", () => {
  it("serves the built SPA with CSP, assets via the cookie, and an index fallback confined to webDir", async () => {
    const web = tmp();
    fs.mkdirSync(path.join(web, "assets"));
    fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>fractory</title>");
    fs.writeFileSync(path.join(web, "assets", "app.js"), "console.log(1)");
    const d = await startDaemon({ dataDir: tmp(), configDir: tmp(), workers: fakeWorkers(), webDir: web });
    cleanups.push(() => d.close());
    const cookie = await loginCookie(d);
    const page = await req(d, "GET", "/", { cookie });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("worker-src 'self';");
    const js = await req(d, "GET", "/assets/app.js", { cookie });
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.body).toBe("console.log(1)");
    expect((await req(d, "GET", "/assets/app.js")).status).toBe(401);
    expect((await req(d, "GET", "/run/20260101-000000-aaaa", { cookie })).body).toContain("<title>fractory");
    expect((await req(d, "GET", "/..%2f..%2fpackage.json", { cookie })).body).toContain("<title>fractory");
  });
});

describe("daemon API", () => {
  it("starts a consensus run; SSE replays from 0, then reconnect resumes after Last-Event-ID", async () => {
    const d = await daemon({ slow: true });
    const runId = await startRun(d, "consensus");
    const first = await sse(d, `/api/runs/${runId}/events/stream`, {}, 5);
    expect(first.ids).toEqual([1, 2, 3, 4, 5]);
    expect(first.types[0]).toBe("run_created");
    const rest = await sse(d, `/api/runs/${runId}/events/stream`, { "last-event-id": "5" });
    expect(rest.ids[0]).toBe(6);
    expect(rest.ids).toEqual(rest.ids.map((_, i) => 6 + i));
    expect(rest.types).toContain("run_completed");
    const replay = await sse(d, `/api/runs/${runId}/events/stream?since=0`);
    expect(replay.ids.length).toBe(rest.ids.at(-1));
    const list = await api(d, "GET", "/api/runs");
    expect(list.json[0]).toMatchObject({ runId, workflow: "consensus", status: "completed" });
  });

  it("duel: approval via API, resume, diff endpoint; double-drive → 409", async () => {
    const d = await daemon();
    const runId = await startRun(d, "duel");
    const st = await waitStatus(d, runId, ["awaiting_approval"]);
    expect((st.approval as { items: unknown[] }).items).toHaveLength(1);
    expect((await api(d, "POST", `/api/runs/${runId}/resume`, {})).status).toBe(409); // not approved yet
    expect((await api(d, "POST", `/api/runs/${runId}/approve`, { items: [1] })).json).toEqual({ approved: [1] });
    expect((await api(d, "POST", `/api/runs/${runId}/resume`, {})).status).toBe(202);
    const done = await waitStatus(d, runId, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    const labels = Object.keys(done.labels as object);
    const diff = await api(d, "GET", `/api/runs/${runId}/diff/${labels[0]}`);
    expect(diff.status).toBe(200);
    expect(diff.body).toContain("diff --git a/math.js b/math.js");
    expect((await api(d, "GET", `/api/runs/${runId}/changes/${labels[0]}`)).json).toEqual(["math.js"]);
    expect((await api(d, "GET", `/api/runs/${runId}/blob?rev=base&path=math.js`)).body).toContain("export const add");
    expect((await api(d, "GET", `/api/runs/${runId}/blob?rev=${labels[0]}&path=math.js`)).body).toContain("div");
    for (const bad of ["rev=base&path=../x", "rev=main&path=math.js", "rev=base&path=C:/x", "rev=base&path=--output=x"]) {
      expect((await api(d, "GET", `/api/runs/${runId}/blob?${bad}`)).status).toBe(400);
    }
    // refs open files at the commit they were made against: recorded commits only
    const heads = (done.steps as Record<string, { result: { heads: Record<string, string> } }>).judge!.result.heads;
    const atJudging = await api(d, "GET", `/api/runs/${runId}/blob?rev=${heads[labels[0]!]}&path=math.js`);
    expect(atJudging.status).toBe(200);
    expect(atJudging.body).toContain("div");
    expect((await api(d, "GET", `/api/runs/${runId}/blob?rev=${"0".repeat(40)}&path=math.js`)).status).toBe(400);
    expect((await api(d, "GET", `/api/runs/${runId}/blob?rev=HEAD~1&path=math.js`)).status).toBe(400);
    // clean (guarded worktree removal, branches kept) and gc
    const cleaned = await api(d, "POST", `/api/runs/${runId}/clean`);
    expect(cleaned.status).toBe(200);
    expect(cleaned.json.removed).toHaveLength(3);
    expect((await api(d, "GET", `/api/runs/${runId}`)).json.cleaned.paths).toHaveLength(3);
    expect((await api(d, "POST", "/api/gc", { olderThanDays: 0 })).json).toEqual({ cleaned: [] });
    expect((await api(d, "POST", "/api/gc", { olderThanDays: -1 })).status).toBe(400);
  });

  it("quota pause: early resume is refused (409) unless forced; cancel works", async () => {
    const d = await daemon({ quota: true });
    const runId = await startRun(d, "consensus");
    await waitStatus(d, runId, ["paused_quota"]);
    const early = await api(d, "POST", `/api/runs/${runId}/resume`, {});
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/resets at/);
    expect((await api(d, "POST", `/api/runs/${runId}/cancel`)).json).toEqual({ result: "cancelled" });
    expect((await waitStatus(d, runId, ["cancelled"])).status).toBe("cancelled");
    expect((await api(d, "GET", "/api/quota")).status).toBe(200);
  });
});

describe("daemon new-run form", () => {
  it("start-info: the serve repo, then earlier runs' repos newest first, deduplicated", async () => {
    const home = repo();
    const d = await daemon({}, { defaultRepo: home });
    expect((await api(d, "GET", "/api/start-info")).json).toEqual({ defaultRepo: home, recentRepos: [] });
    const r1 = repo();
    const r2 = repo();
    await waitStatus(d, await startRun(d, "consensus", r1), ["completed"]);
    await waitStatus(d, await startRun(d, "consensus", r2), ["completed"]);
    await waitStatus(d, await startRun(d, "consensus", r1), ["completed"]);
    expect((await api(d, "GET", "/api/start-info")).json).toEqual({ defaultRepo: home, recentRepos: [r1, r2] });
    const bare = await daemon();
    expect((await api(bare, "GET", "/api/start-info")).json.defaultRepo).toBeNull();
  });

  it("repo-check: absolute paths only; reports root, branch, dirty state and start warnings", async () => {
    const d = await daemon();
    const r = repo();
    expect((await api(d, "GET", "/api/repo-check?path=relative/dir")).json).toEqual({ ok: false, error: "enter an absolute path" });
    expect((await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(path.join(r, "nope"))}`)).json).toMatchObject({ ok: false, error: "no such directory" });
    const plain = tmp();
    expect((await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(plain)}`)).json).toMatchObject({ ok: false, error: expect.stringMatching(/not inside a git repository/) });
    expect((await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(r)}&workflow=bogus`)).status).toBe(400);

    // a subdirectory resolves to the top level; review without testCommand warns, consensus does not
    fs.mkdirSync(path.join(r, "sub"));
    const review = (await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(path.join(r, "sub"))}&workflow=review`)).json;
    expect(review).toMatchObject({ ok: true, root: r, branch: "main", head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(review.dirty).toBe(1); // the untracked fractory.config.json
    expect(review.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/testCommand/), expect.stringMatching(/1 uncommitted change/)]));
    const consensus = (await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(r)}&workflow=consensus`)).json;
    expect(consensus.warnings.some((w: string) => /testCommand/.test(w))).toBe(false);

    const empty = tmp();
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
    expect((await api(d, "GET", `/api/repo-check?path=${encodeURIComponent(empty)}`)).json).toMatchObject({ ok: false, error: "the repository has no commits yet", head: null });
  });

  it("POST /api/runs returns the same start warnings as the CLI", async () => {
    const d = await daemon();
    const res = await api(d, "POST", "/api/runs", { workflow: "review", repo: repo(), prompt: "Add division." });
    expect(res.status).toBe(202);
    expect(res.json.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/testCommand is not configured/)]));
    await waitStatus(d, res.json.runId, ["completed", "failed", "needs_attention", "awaiting_approval"]);
  });
});
