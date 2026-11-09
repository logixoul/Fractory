import * as path from "node:path";
import { Command, CommanderError } from "commander";
import {
  FRACTORY_VERSION,
  LockedError,
  Redactor,
  ResumeRefusedError,
  RunNotFoundError,
  RunStore,
  approveRun,
  cancelRun,
  createRun,
  createWorkers,
  defaultConfigDir,
  defaultDataDir,
  driveRun,
  loadConfig,
  runConfig,
  type Config,
  type RunEvent,
  type RunHandle,
  type RunState,
  type Worker,
} from "@fractory/core";
import { formatEvent, formatItem, formatRunList, formatShow } from "./format.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  /** Test hook: build workers for a run (default: real Claude/Pi adapters). */
  workers?: (config: Config, ctx: { dataDir: string; repo: string; redactor: Redactor }) => Record<string, Worker>;
  /** External cancellation (the bin wires SIGINT/SIGTERM to this). */
  signal?: AbortSignal;
  /** Progress poll interval (ms). */
  pollMs?: number;
}

/** Exit codes: 0 completed/ok, 1 error/failed/cancelled, 2 paused (quota, approval, attention). */
export const EXIT = { ok: 0, failed: 1, paused: 2, usage: 64 } as const;

const exitFor = (st: RunState): number =>
  st.status === "completed" ? EXIT.ok : st.status === "failed" || st.status === "cancelled" ? EXIT.failed : EXIT.paused;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let code: number = EXIT.ok;
  const program = new Command()
    .name("fractory")
    .description("Local multi-model orchestrator: consensus design and implementation duels.")
    .version(FRACTORY_VERSION)
    .option("--data-dir <dir>", "data directory (runs, worktrees); default: OS data dir or FRACTORY_DATA_DIR")
    .option("--config-dir <dir>", "directory of the global fractory.config.json; default: OS config dir or FRACTORY_CONFIG_DIR")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });

  const ctx = () => {
    const g = program.opts<{ dataDir?: string; configDir?: string }>();
    const dataDir = g.dataDir ? path.resolve(g.dataDir) : defaultDataDir(io.env);
    const configDir = g.configDir ? path.resolve(g.configDir) : defaultConfigDir(io.env);
    const redactor = Redactor.fromEnv(io.env);
    return { dataDir, configDir, redactor, store: new RunStore(dataDir, redactor) };
  };

  const buildWorkers = (config: Config, c: ReturnType<typeof ctx>, repo: string) =>
    io.workers
      ? io.workers(config, { dataDir: c.dataDir, repo, redactor: c.redactor })
      : createWorkers(config, { dataDir: c.dataDir, redactor: c.redactor, baseDir: repo, env: io.env });

  /** Drives a run in this process, printing its events as they are appended. */
  const driveAndReport = async (run: RunHandle, c: ReturnType<typeof ctx>, force: boolean): Promise<number> => {
    const st0 = run.state();
    const workers = buildWorkers(runConfig(st0), c, st0.repo);
    let since = run.state().lastSeq;
    const flush = () => {
      for (const e of run.events(since)) {
        since = e.seq;
        const line = formatEvent(e as RunEvent, run.state());
        if (line) io.out(line + "\n");
      }
    };
    const timer = setInterval(flush, io.pollMs ?? 300);
    try {
      const st = await driveRun(run, { dataDir: c.dataDir, workers, force, ...(io.signal ? { signal: io.signal } : {}) });
      flush();
      io.out(nextHint(st));
      return exitFor(st);
    } finally {
      clearInterval(timer);
    }
  };

  const startCmd = (workflow: "consensus" | "duel", description: string) =>
    program
      .command(workflow)
      .description(description)
      .requiredOption("--repo <path>", "target git repository")
      .requiredOption("--prompt <file>", "prompt file (markdown)")
      .action(async (o: { repo: string; prompt: string }) => {
        const c = ctx();
        const repo = path.resolve(o.repo);
        const loaded = loadConfig({ repo, configDir: c.configDir });
        for (const w of loaded.warnings) io.err(`warning: ${w}\n`);
        const run = await createRun(c.store, { workflow, repo, promptFile: path.resolve(o.prompt), config: loaded.config });
        io.out(`run ${run.runId} (${workflow}) created; config from: ${loaded.sources.join(", ") || "built-in defaults"}\n`);
        code = await driveAndReport(run, c, false);
      });

  startCmd("consensus", "proposals → cross-critique → revisions → anonymized judge (read-only)");
  startCmd("duel", "two independent implementations → checks → judge → approval → apply (never merges or pushes)");

  program
    .command("runs")
    .description("list runs, newest first")
    .option("--json", "machine-readable output")
    .action((o: { json?: boolean }) => {
      const list = ctx().store.list();
      io.out(o.json ? JSON.stringify(list.map((r) => ({ runId: r.runId, ...summary(r.state) })), null, 2) + "\n" : formatRunList(list));
    });

  program
    .command("show <runId>")
    .description("show a run's state (steps, costs, pause/approval/attention, results)")
    .option("--json", "print state.json")
    .option("--events", "print the full event log")
    .action((runId: string, o: { json?: boolean; events?: boolean }) => {
      const run = ctx().store.open(runId);
      if (o.events) for (const e of run.events()) io.out(JSON.stringify(e) + "\n");
      else io.out(o.json ? JSON.stringify(run.state(), null, 2) + "\n" : formatShow(run.state()));
    });

  program
    .command("approve <runId>")
    .description("approve judge items (1-based) of a run awaiting approval; then `fractory resume`")
    .requiredOption("--items <list>", "comma-separated item numbers, e.g. 1,3 (empty string = none)")
    .action((runId: string, o: { items: string }) => {
      const ids = o.items.trim() === "" ? [] : o.items.split(",").map((s) => Number(s.trim()));
      if (ids.some((n) => !Number.isInteger(n))) throw new UserError(`--items must be integers: ${o.items}`);
      const approved = approveRun(ctx().store.open(runId), ids);
      io.out(`approved items [${approved.join(", ")}]; continue with: fractory resume ${runId}\n`);
    });

  program
    .command("resume <runId>")
    .description("continue a paused or interrupted run (quota, approval, needs_attention, crash)")
    .option("--force", "resume a quota pause before the known reset time")
    .action(async (runId: string, o: { force?: boolean }) => {
      const c = ctx();
      code = await driveAndReport(c.store.open(runId), c, o.force ?? false);
    });

  program
    .command("cancel <runId>")
    .description("cancel a run (a running driver stops and kills its workers)")
    .action((runId: string) => {
      const r = cancelRun(ctx().store.open(runId));
      io.out(
        r === "cancelled" ? `run ${runId} cancelled\n` : r === "requested" ? `cancel requested; the running driver of ${runId} will stop\n` : `run ${runId} already finished\n`,
      );
    });

  program
    .command("serve")
    .description("start the local daemon and open the GUI (M5)")
    .action(() => {
      throw new UserError("the daemon and GUI arrive in milestones M5/M6");
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (e instanceof UserError || e instanceof RunNotFoundError || e instanceof ResumeRefusedError || e instanceof LockedError) {
      io.err(`error: ${e.message}\n`);
      return EXIT.failed;
    }
    io.err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return EXIT.failed;
  }
}

class UserError extends Error {}

function summary(st: RunState | undefined) {
  if (!st) return { status: "unreadable" };
  return { workflow: st.workflow, status: st.status, repo: st.repo, createdAt: st.createdAt, updatedAt: st.updatedAt };
}

function nextHint(st: RunState): string {
  switch (st.status) {
    case "completed":
      return `\nrun ${st.runId} completed${resultLine(st)}\n`;
    case "paused_quota":
      return `\nrun ${st.runId} paused: quota exhausted for ${st.pause?.workerId}${st.pause?.resetsAt ? `, resets at ${new Date(st.pause.resetsAt).toLocaleString()}` : ""}. Resume with: fractory resume ${st.runId}\n`;
    case "awaiting_approval":
      return `\nrun ${st.runId} awaits approval of these items:\n${(st.approval?.items ?? []).map((it, i) => formatItem(it, i + 1)).join("\n")}\n\nApprove a subset: fractory approve ${st.runId} --items 1,3   (then: fractory resume ${st.runId})\n`;
    case "needs_attention":
      return `\nrun ${st.runId} needs attention: the main repository changed during a step (${st.attention?.changes.map((c) => c.path).join(", ")}).\nContinue: fractory resume ${st.runId}   Abort: fractory cancel ${st.runId}\n`;
    case "failed":
      return `\nrun ${st.runId} failed (${st.failure?.kind}) at ${st.failure?.stepId ?? "?"}: ${st.failure?.reason}\n`;
    default:
      return `\nrun ${st.runId}: ${st.status}\n`;
  }
}

function resultLine(st: RunState): string {
  const r = st.result as { decisionMd?: string; reportMd?: string; branches?: Record<string, string> } | undefined;
  const lines: string[] = [];
  if (r?.decisionMd) lines.push(`decision: ${r.decisionMd}`);
  if (r?.reportMd) lines.push(`report: ${r.reportMd}`);
  if (r?.branches) lines.push(`branches (not merged or pushed): ${Object.values(r.branches).join(", ")}`);
  return lines.map((l) => `\n${l}`).join("");
}
