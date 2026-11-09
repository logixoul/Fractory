import type { RunEvent, RunState, WorkerEvent } from "./types.js";

/** Normalized events grouped into one pane per worker (live run view). Pure; unit-tested. */
export type PaneItem =
  | { kind: "start"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; isError?: boolean; blocked?: string }
  | { kind: "error"; text: string }
  | { kind: "info"; text: string };

export interface StepBlock {
  stepId: string;
  attempt: number;
  status: "running" | "completed" | "failed" | "abandoned";
  detail?: string;
  items: PaneItem[];
}

export interface Pane {
  key: string;
  title: string;
  steps: StepBlock[];
}

const ORCH = "orchestrator";
const JUDGE = "judge";

/** Which pane a step belongs to: judge, a contestant (by worker or label), or the orchestrator. */
export function paneKey(stepId: string, workerId: string | undefined, label: string | undefined, labels: Record<string, string>): string {
  if (stepId === "judge") return JUDGE;
  if (workerId && Object.values(labels).includes(workerId)) return workerId;
  if (label && labels[label]) return labels[label]!;
  return ORCH;
}

export function buildPanes(events: readonly RunEvent[], labels: Record<string, string>): Pane[] {
  const panes = new Map<string, Pane>();
  const blocks = new Map<string, StepBlock>(); // `${stepId}#${attempt}`
  const toolIndex = new Map<string, Extract<PaneItem, { kind: "tool" }>>();
  const ensure = (key: string) => {
    let p = panes.get(key);
    if (!p) {
      p = { key, title: key === ORCH ? "orchestrator" : key === JUDGE ? "judge" : key, steps: [] };
      panes.set(key, p);
    }
    return p;
  };
  for (const contestant of Object.values(labels).sort()) ensure(contestant);

  for (const e of events) {
    const ev = e as RunEvent & { stepId?: string; attempt?: number };
    if (ev.type === "step_started") {
      const s = e as Extract<RunEvent, { type: "step_started" }> & { workerId?: string; label?: string };
      const b: StepBlock = { stepId: s.stepId, attempt: s.attempt, status: "running", items: [] };
      blocks.set(`${s.stepId}#${s.attempt}`, b);
      ensure(paneKey(s.stepId, s.workerId, s.label, labels)).steps.push(b);
      continue;
    }
    if (!ev.stepId || ev.attempt === undefined) continue;
    const b = blocks.get(`${ev.stepId}#${ev.attempt}`);
    if (!b) continue;
    switch (ev.type) {
      case "step_completed":
        b.status = "completed";
        b.detail = `${((e as { durationMs: number }).durationMs / 1000).toFixed(1)}s`;
        break;
      case "step_failed":
        b.status = "failed";
        b.detail = `${(e as { kind: string }).kind}: ${(e as { reason: string }).reason}`;
        break;
      case "step_abandoned":
        b.status = "abandoned";
        break;
      case "step_retrying":
        b.items.push({ kind: "error", text: `transient failure, retrying in ${((e as { delayMs: number }).delayMs / 1000).toFixed(0)}s: ${(e as { reason: string }).reason}` });
        break;
      case "checkpoint_created":
        b.items.push({ kind: "info", text: `checkpoint ${(e as { sha: string }).sha.slice(0, 10)}` });
        break;
      case "worker_event":
        addWorkerEvent(b, (e as { event: WorkerEvent }).event, toolIndex);
        break;
    }
  }
  return [...panes.values()].filter((p) => p.steps.length > 0 || Object.values(labels).includes(p.key));
}

function addWorkerEvent(b: StepBlock, w: WorkerEvent, tools: Map<string, Extract<PaneItem, { kind: "tool" }>>): void {
  const last = b.items.at(-1);
  switch (w.type) {
    case "start":
      b.items.push({
        kind: "start",
        text: [w.requestedModel, w.resolvedModel && w.resolvedModel !== w.requestedModel ? `→ ${w.resolvedModel}` : "", w.requestedReasoning ? `(reasoning ${w.requestedReasoning})` : ""]
          .filter(Boolean)
          .join(" "),
      });
      break;
    case "text":
    case "thinking":
      if (last && last.kind === w.type) last.text += w.text;
      else b.items.push({ kind: w.type, text: w.text });
      break;
    case "tool_call": {
      const item = { kind: "tool" as const, id: w.id, name: w.name, input: w.input };
      tools.set(`${b.stepId}#${b.attempt}#${w.id}`, item);
      b.items.push(item);
      break;
    }
    case "tool_result": {
      const t = tools.get(`${b.stepId}#${b.attempt}#${w.id}`);
      if (t) {
        t.output = w.output;
        t.isError = w.isError;
      } else b.items.push({ kind: "tool", id: w.id, name: "?", input: null, output: w.output, isError: w.isError });
      break;
    }
    case "tool_blocked": {
      const t = tools.get(`${b.stepId}#${b.attempt}#${w.id}`);
      if (t) t.blocked = w.reason;
      else b.items.push({ kind: "tool", id: w.id, name: w.name, input: null, blocked: w.reason });
      break;
    }
    case "error":
      b.items.push({ kind: "error", text: `${w.kind}: ${w.message}` });
      break;
    case "done":
      if (w.resolvedModels.length) b.items.push({ kind: "info", text: `done · ${w.resolvedModels.join(", ")}${w.effectiveReasoning ? ` · reasoning ${w.effectiveReasoning}` : ""}` });
      break;
    default:
      break;
  }
}

export const PHASES: Record<string, string[]> = {
  consensus: ["setup", "propose", "critique", "revise", "judge"],
  duel: ["setup", "implement", "check/fix", "judge", "approve", "apply", "recheck", "report"],
};

const phaseOf = (stepId: string) => {
  const head = stepId.split(".")[0]!;
  if (head === "check" || head === "fix" || head === "outcome") return "check/fix";
  if (head === "refix") return "recheck";
  return head;
};

export type PhaseStatus = "pending" | "active" | "done" | "failed";

/** Phase indicator: derived from step states and run status only. */
export function phaseStatuses(st: Pick<RunState, "workflow" | "steps" | "status" | "approval">): { phase: string; status: PhaseStatus }[] {
  const phases = PHASES[st.workflow] ?? [];
  const byPhase = new Map<string, string[]>();
  for (const s of Object.values(st.steps)) {
    const p = phaseOf(s.id);
    byPhase.set(p, [...(byPhase.get(p) ?? []), s.status]);
  }
  return phases.map((phase) => {
    const statuses = byPhase.get(phase) ?? [];
    if (phase === "approve" && st.status === "awaiting_approval") return { phase, status: "active" };
    if (statuses.includes("running")) return { phase, status: "active" };
    if (statuses.includes("failed") && !statuses.includes("completed")) return { phase, status: "failed" };
    if (statuses.length > 0 && statuses.every((s) => s === "completed")) return { phase, status: "done" };
    if (statuses.length > 0) return { phase, status: "active" };
    return { phase, status: "pending" };
  });
}
