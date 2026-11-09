import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";
import { deepMerge, parseConfig } from "../src/config/load.js";
import { DEFAULT_CONFIG_INPUT, type Config } from "../src/schemas/config.js";
import type { RunState } from "../src/state/reducer.js";
import type { RunHandle, RunStore } from "../src/store/run-store.js";
import type { WorkStep, WorkflowDef } from "../src/engine/types.js";
import { newLabels } from "../src/util/random.js";

const dirs: string[] = [];

export function tmpDir(prefix = "fractory-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export function testConfig(overrides: unknown = {}): Config {
  // The swapped-order judge pass (default on) has its own tests; fake judges elsewhere answer one pass.
  return parseConfig(deepMerge(deepMerge(DEFAULT_CONFIG_INPUT, { judge: { swapOrderPass: false } }), overrides)).config;
}

export function newTestRun(store: RunStore): RunHandle {
  return store.create({
    workflow: "test",
    repo: "/repo",
    promptFile: "prompt.md",
    promptSha256: "0".repeat(64),
    labels: newLabels(["opus", "deepseek"]),
    roles: { contestants: ["opus", "deepseek"], judge: "deepseek" },
    seed: 42,
    config: {},
    fractoryVersion: "test",
  });
}

export function labelOf(state: RunState, workerId: string): string {
  const e = Object.entries(state.labels).find(([, w]) => w === workerId);
  if (!e) throw new Error(`no label for ${workerId}`);
  return e[0];
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type R = { text: string; sessionId: string };

/** parallel propose (both contestants) → approval gate → apply (resume opus session) → done */
export function demoWorkflow(): WorkflowDef {
  const propose = (label: string, workerId: string): WorkStep => ({
    id: `propose.${label}`,
    workerId,
    label,
    async run(ctx) {
      const d = await ctx.runWorker(workerId, { prompt: `propose (${workerId})`, cwd: ctx.stepDir, mode: "read-only" });
      return { text: d.finalText, sessionId: d.sessionId } satisfies R;
    },
    exitCheck: (_ctx, r) => ((r as R).text.length > 0 ? { ok: true } : { ok: false, reason: "empty proposal" }),
  });
  return {
    name: "demo",
    next(st) {
      const labels = Object.entries(st.labels);
      const proposals = labels.map(([l, w]) => propose(l, w));
      if (proposals.some((p) => st.steps[p.id]?.status !== "completed")) return { kind: "stage", steps: proposals };
      if (st.steps.approve?.status !== "completed") {
        return {
          kind: "stage",
          steps: [
            {
              kind: "approval_gate",
              id: "approve",
              items: (s) => labels.map(([l]) => ({ label: l, text: (s.steps[`propose.${l}`]!.result as R).text })),
            },
          ],
        };
      }
      if (st.steps.apply?.status !== "completed") {
        const opusLabel = labelOf(st, "opus");
        const session = (st.steps[`propose.${opusLabel}`]!.result as R).sessionId;
        const approved = (st.steps.approve!.result as { approvedItemIds: number[] }).approvedItemIds;
        return {
          kind: "stage",
          steps: [
            {
              id: "apply",
              workerId: "opus",
              async run(ctx) {
                const d = await ctx.runWorker("opus", {
                  prompt: `apply ${JSON.stringify(approved)}`,
                  cwd: ctx.stepDir,
                  mode: "edit",
                  sessionId: session,
                });
                return { text: d.finalText, sessionId: d.sessionId } satisfies R;
              },
            },
          ],
        };
      }
      return { kind: "done", result: { applied: (st.steps.apply!.result as R).text } };
    },
  };
}
