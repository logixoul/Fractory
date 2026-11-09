import * as fs from "node:fs";
import * as path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  EventTail,
  FRACTORY_VERSION,
  LockedError,
  ResumeRefusedError,
  RunNotFoundError,
  TERMINAL_STATUSES,
  approveRun,
  cleanRun,
  gcRuns,
  changedFiles,
  git,
  createRun,
  dataPaths,
  isInside,
  loadConfig,
  randomHex,
  readQuotaBook,
  storeReviewerStats,
  squashedDiff,
  worktreeBranch,
  type RunStore,
} from "@fractory/core";
import { ConflictError, type DriverPool } from "./drivers.js";
import { security, securityHeaders, type AuthCodes } from "./security.js";

export interface AppDeps {
  store: RunStore;
  pool: DriverPool;
  dataDir: string;
  configDir: string;
  token: string;
  codes: AuthCodes;
  port: () => number;
  /** Built GUI (packages/web/dist). Optional until M6. */
  webDir?: string;
  /** SSE poll interval (ms). */
  tailMs?: number;
  heartbeatMs?: number;
}

const StartBody = z
  .object({
    workflow: z.enum(["review", "consensus", "duel"]).default("review"),
    repo: z.string().min(1),
    prompt: z.string().min(1).optional(),
    promptFile: z.string().min(1).optional(),
  })
  .strict()
  .refine((b) => (b.prompt === undefined) !== (b.promptFile === undefined), "give exactly one of prompt or promptFile");
const ApproveBody = z.object({ items: z.array(z.number().int().positive()) }).strict();
const ResumeBody = z.object({ force: z.boolean().optional(), retryFailed: z.boolean().optional() }).strict();
const GcBody = z.object({ olderThanDays: z.number().min(0) }).strict();

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.use("*", securityHeaders);
  app.use("*", security({ token: d.token, codes: d.codes, port: d.port }));
  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }));

  app.onError((e, c) => {
    if (e instanceof RunNotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ConflictError || e instanceof LockedError || e instanceof ResumeRefusedError) return c.json({ error: e.message }, 409);
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  });

  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new BadRequest("body is not valid JSON");
      }
    }
    const r = schema.safeParse(raw);
    if (!r.success) throw new BadRequest(z.prettifyError(r.error));
    return r.data;
  };
  const runOf = (c: Context) => d.store.open(c.req.param("id")!);
  const view = (runId: string) => ({ ...d.store.open(runId).state(), driving: d.pool.isActive(runId), driverError: d.pool.lastError.get(runId) ?? null });

  app.get("/api/health", (c) => c.json({ ok: true, version: FRACTORY_VERSION }));

  app.get("/api/runs", (c) =>
    c.json(
      d.store.list().map((r) =>
        r.state
          ? {
              runId: r.runId,
              workflow: r.state.workflow,
              status: r.state.status,
              repo: r.state.repo,
              createdAt: r.state.createdAt,
              updatedAt: r.state.updatedAt,
              driving: d.pool.isActive(r.runId),
              costs: r.state.costs,
              workerKinds: workerKinds(r.state.config),
            }
          : { runId: r.runId, status: "unreadable", error: r.error ?? null },
      ),
    ),
  );

  app.post("/api/runs", async (c) => {
    const b = await body(c, StartBody);
    const repo = path.resolve(b.repo);
    let promptFile = b.promptFile ? path.resolve(b.promptFile) : undefined;
    if (b.prompt !== undefined) {
      const dir = path.join(d.dataDir, "prompts");
      fs.mkdirSync(dir, { recursive: true });
      promptFile = path.join(dir, `${Date.now()}-${randomHex(4)}.md`);
      fs.writeFileSync(promptFile, b.prompt);
    }
    const loaded = loadConfig({ repo, configDir: d.configDir });
    const run = await createRun(d.store, { workflow: b.workflow, repo, promptFile: promptFile!, config: loaded.config }).catch((e: Error) => {
      throw new BadRequest(e.message);
    });
    await d.pool.start(run.runId);
    return c.json({ runId: run.runId, warnings: loaded.warnings }, 202);
  });

  app.get("/api/runs/:id", (c) => c.json(view(runOf(c).runId)));

  app.get("/api/runs/:id/events", (c) => {
    const since = Number(c.req.query("since") ?? 0) || 0;
    return c.json(runOf(c).events(since));
  });

  // Live events: replay from Last-Event-ID / ?since=, then tail (reconnect-safe: ids are seqs).
  app.get("/api/runs/:id/events/stream", (c) => {
    const run = runOf(c);
    const since = Number(c.req.header("last-event-id") ?? c.req.query("since") ?? 0) || 0;
    const tail = new EventTail(run.eventsFile, since);
    return streamSSE(c, async (s) => {
      let closed = false;
      s.onAbort(() => {
        closed = true;
      });
      let lastBeat = Date.now();
      while (!closed) {
        const evs = tail.read();
        for (const e of evs) await s.writeSSE({ id: String(e.seq), event: "run_event", data: JSON.stringify(e) });
        if (evs.length === 0) {
          const st = d.store.open(run.runId).state();
          if (TERMINAL_STATUSES.has(st.status) && st.lastSeq <= tail.lastSeq && !d.pool.isActive(run.runId)) {
            await s.writeSSE({ event: "end", data: JSON.stringify({ status: st.status }) });
            return;
          }
          if (Date.now() - lastBeat > (d.heartbeatMs ?? 15_000)) {
            await s.writeSSE({ event: "ping", data: "" });
            lastBeat = Date.now();
          }
          await s.sleep(d.tailMs ?? 250);
        }
      }
    });
  });

  // Text files of a run (proposals, critiques, decision.md, report.md, inputs). Always served as
  // text/plain: model output is never rendered by the browser as HTML from this origin.
  app.get("/api/runs/:id/file", (c) => {
    const run = runOf(c);
    const rel = c.req.query("path");
    if (!rel) throw new BadRequest("missing ?path=");
    const root = fs.realpathSync.native(run.dir);
    const abs = path.resolve(root, rel);
    let real: string;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      return c.json({ error: "no such file" }, 404);
    }
    if (!isInside(real, root) || !fs.statSync(real).isFile()) return c.json({ error: "path outside the run" }, 403);
    if (fs.statSync(real).size > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    return c.body(fs.readFileSync(real), 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  // Squashed diff of a duel branch against the base (Monaco compare view).
  app.get("/api/runs/:id/diff/:label", async (c) => {
    const st = runOf(c).state();
    const label = c.req.param("label");
    const setup = st.steps.setup?.result as { base?: string; branches?: Record<string, string> } | undefined;
    if (!setup?.base || !setup.branches?.[label]) return c.json({ error: "no branch for this label" }, 404);
    const diff = await squashedDiff(st.repo, setup.base, worktreeBranch(st.runId, label));
    return c.body(diff, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  // Changed files of a duel branch, and file contents at a revision ("base" or a label), for Monaco.
  app.get("/api/runs/:id/changes/:label", async (c) => {
    const st = runOf(c).state();
    const setup = duelSetup(st);
    const label = c.req.param("label");
    if (!setup?.branches[label]) return c.json({ error: "no branch for this label" }, 404);
    return c.json(await changedFiles(st.repo, setup.base, worktreeBranch(st.runId, label)));
  });

  // A file at a commit of this run: "base", a duel contestant label (its branch), or a commit
  // sha recorded in the run (checkpoints, step heads). Never an arbitrary ref of the repo.
  app.get("/api/runs/:id/blob", async (c) => {
    const st = runOf(c).state();
    const rev = c.req.query("rev") ?? "";
    const file = c.req.query("path") ?? "";
    const base = setupBase(st);
    if (!base) return c.json({ error: "the run has no base commit yet" }, 404);
    const branches = duelSetup(st)?.branches ?? {};
    const commit =
      rev === "base" ? base : branches[rev] ? worktreeBranch(st.runId, rev) : /^[0-9a-f]{40}$/.test(rev) && recordedCommits(st).has(rev) ? rev : undefined;
    if (!commit) return c.json({ error: "rev must be 'base', a contestant label, or a commit recorded in this run" }, 400);
    // Repo-relative paths only (the file is read from a commit, never from disk).
    if (file === "" || file.startsWith("/") || file.startsWith("-") || file.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(file)) {
      return c.json({ error: "invalid path" }, 400);
    }
    const r = await git(["show", `${commit}:${file.replace(/\\/g, "/")}`], { cwd: st.repo, allowFail: true });
    if (r.code !== 0) return c.body("", 200, { "Content-Type": "text/plain; charset=utf-8", "X-Fractory-Missing": "1" });
    if (r.stdout.length > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);
    return c.body(new Uint8Array(r.stdout), 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  app.post("/api/runs/:id/approve", async (c) => {
    const b = await body(c, ApproveBody);
    const approved = approveRun(runOf(c), b.items);
    return c.json({ approved });
  });

  app.post("/api/runs/:id/resume", async (c) => {
    const b = await body(c, ResumeBody);
    const run = runOf(c);
    await d.pool.start(run.runId, { force: b.force ?? false, retryFailed: b.retryFailed ?? false });
    return c.json({ runId: run.runId, driving: true }, 202);
  });

  app.post("/api/runs/:id/cancel", (c) => c.json({ result: d.pool.cancel(runOf(c).runId) }));

  // fractory clean / gc: remove worktree directories through the guard; branches are kept.
  app.post("/api/runs/:id/clean", async (c) => {
    const run = runOf(c);
    if (d.pool.isActive(run.runId)) throw new ConflictError(`run ${run.runId} is being driven`);
    return c.json({ removed: await cleanRun(run, d.dataDir) });
  });

  app.post("/api/gc", async (c) => {
    const b = await body(c, GcBody);
    const all = await gcRuns(d.store, { dataDir: d.dataDir, olderThanDays: b.olderThanDays });
    return c.json({ cleaned: all.filter((r) => !d.pool.isActive(r.runId)) });
  });

  app.get("/api/quota", (c) => c.json(readQuotaBook(dataPaths(d.dataDir).quotaFile)));

  // fractory stats: per-reviewer statistics over completed review runs.
  app.get("/api/stats", (c) => c.json(storeReviewerStats(d.store)));

  // GUI (SPA): static files from webDir, index.html fallback for client-side routes.
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    if (!d.webDir || !fs.existsSync(path.join(d.webDir, "index.html"))) {
      return c.html("<!doctype html><title>fractory</title><p>fractory daemon is running. The GUI is not built yet (<code>npm run build</code>).</p>");
    }
    const root = fs.realpathSync.native(d.webDir);
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
    let file = path.resolve(root, rel);
    if (!isInside(file, root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, "index.html");
    return c.body(fs.readFileSync(file), 200, { "Content-Type": contentType(file) });
  });

  return app;
}

class BadRequest extends Error {}

type StepsLike = { steps: Record<string, { status: string; checkpoint?: string; result?: unknown }> };

function setupBase(st: StepsLike): string | undefined {
  const r = st.steps.setup?.status === "completed" ? (st.steps.setup.result as { base?: unknown }) : undefined;
  return typeof r?.base === "string" ? r.base : undefined;
}

/** Commit shas recorded in the run: base, checkpoints, and every step result's head/sha/heads. */
export function recordedCommits(st: StepsLike): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && /^[0-9a-f]{40}$/.test(v)) out.add(v);
  };
  for (const s of Object.values(st.steps)) {
    add(s.checkpoint);
    const r = s.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") continue;
    add(r.base);
    add(r.head);
    add(r.sha);
    if (r.heads && typeof r.heads === "object") for (const h of Object.values(r.heads as Record<string, unknown>)) add(h);
  }
  return out;
}

function duelSetup(st: { workflow: string; steps: Record<string, { status: string; result?: unknown }> }) {
  const r = st.steps.setup?.status === "completed" ? (st.steps.setup.result as { base?: string; branches?: Record<string, string> }) : undefined;
  return r?.base && r.branches ? { base: r.base, branches: r.branches } : undefined;
}

function workerKinds(config: unknown): Record<string, string> {
  const w = (config as { workers?: Record<string, { kind?: string }> } | undefined)?.workers ?? {};
  return Object.fromEntries(Object.entries(w).map(([id, v]) => [id, v.kind ?? "unknown"]));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
