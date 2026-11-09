import type { ListedRun, RunEvent, RunState } from "@fractory/core";

const time = (iso: string) => iso.slice(11, 19);
const who = (st: RunState, stepId: string) => {
  const s = st.steps[stepId];
  return s?.workerId ? ` (${s.workerId})` : "";
};

/** One progress line per interesting event; null for the rest (streamed text stays in the log). */
export function formatEvent(e: RunEvent, st: RunState): string | null {
  const t = `[${time(e.ts)}]`;
  switch (e.type) {
    case "step_started":
      return `${t} ▶ ${e.stepId}${e.workerId ? ` (${e.workerId})` : ""}${e.attempt > 1 ? ` attempt ${e.attempt}` : ""}`;
    case "step_completed":
      return `${t} ✓ ${e.stepId}${who(st, e.stepId)} ${(e.durationMs / 1000).toFixed(1)}s`;
    case "step_failed":
      return `${t} ✗ ${e.stepId}${who(st, e.stepId)} ${e.kind}: ${firstLine(e.reason)}`;
    case "step_abandoned":
      return `${t} ↺ ${e.stepId} was interrupted; it will rerun`;
    case "worker_event": {
      const ev = e.event;
      if (ev.type === "start") return `${t}   ${e.stepId}: ${ev.requestedModel ?? "?"}${ev.resolvedModel ? ` → ${ev.resolvedModel}` : ""}${ev.requestedReasoning ? ` (reasoning ${ev.requestedReasoning})` : ""}`;
      if (ev.type === "tool_blocked") return `${t}   ${e.stepId}: blocked ${ev.name}: ${firstLine(ev.reason)}`;
      if (ev.type === "error") return `${t}   ${e.stepId}: ${ev.kind} error: ${firstLine(ev.message)}`;
      if (ev.type === "provider_retry") {
        if (ev.phase === "scheduled") {
          const wait = ev.delayMs !== undefined ? ` in ${(ev.delayMs / 1000).toFixed(1)}s` : "";
          return `${t}   ${e.stepId}: ↻ provider retry ${ev.attempt}${ev.maxAttempts ? `/${ev.maxAttempts}` : ""}${wait}${ev.message ? `: ${firstLine(ev.message)}` : ""}`;
        }
        return `${t}   ${e.stepId}: ${ev.success ? `provider retry ${ev.attempt} succeeded` : `provider retries gave up after ${ev.attempt}${ev.message ? `: ${firstLine(ev.message)}` : ""}`}`;
      }
      return null;
    }
    case "step_retrying":
      return `${t} ↻ ${e.stepId}: transient failure, retrying the step in ${(e.delayMs / 1000).toFixed(0)}s: ${firstLine(e.reason)}`;
    case "quota_warning":
      return `${t} ⚠ quota: ${e.workerId} ${e.window} at ${Math.round(e.utilization * 100)}% (${e.source})`;
    case "checkpoint_created":
      return `${t}   checkpoint ${e.stepId}: ${e.sha.slice(0, 10)}`;
    default:
      return null;
  }
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 200 ? `${l.slice(0, 200)}…` : l;
}

export function formatRunList(list: ListedRun[]): string {
  if (list.length === 0) return "no runs\n";
  const rows = list.map((r) =>
    r.state
      ? [r.runId, r.state.workflow, r.state.status, r.state.updatedAt.slice(0, 19).replace("T", " "), r.state.repo]
      : [r.runId, "?", r.error ?? "unreadable", "", ""],
  );
  return table([["RUN", "WORKFLOW", "STATUS", "UPDATED (UTC)", "REPO"], ...rows]);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")).join("\n") + "\n";
}

export function formatShow(st: RunState): string {
  const out: string[] = [
    `run       ${st.runId}`,
    `workflow  ${st.workflow}`,
    `status    ${st.status}`,
    `repo      ${st.repo}`,
    `created   ${st.createdAt}`,
    `updated   ${st.updatedAt}`,
    `labels    ${Object.entries(st.labels)
      .map(([l, w]) => `${l}=${w}`)
      .join(", ")}`,
    "",
    "steps:",
  ];
  const rows = [["STEP", "STATUS", "TRY", "WORKER", "MODELS", "TOOLS", "BLOCKED"]];
  for (const id of st.stepOrder) {
    const s = st.steps[id]!;
    rows.push([id, s.status, String(s.attempt), s.workerId ?? "", s.resolvedModels.join(","), String(s.toolCalls), String(s.toolBlocked)]);
  }
  out.push(table(rows).trimEnd(), "", "usage:");
  for (const [w, c] of Object.entries(st.costs)) {
    const tokens = `in ${c.tokens.input}, out ${c.tokens.output}, cache r/w ${c.tokens.cacheRead}/${c.tokens.cacheWrite}`;
    if (c.billing === "subscription") {
      out.push(`  ${w}: ${tokens}; subscription (not metered); API-equivalent $${c.vendorCostUsd.toFixed(4)}`);
      continue;
    }
    const cost = c.costUnknown ? `$${c.costUsd.toFixed(4)} + unknown` : `$${c.costUsd.toFixed(4)}`;
    out.push(`  ${w}: ${tokens}; cost ${cost}; vendor-reported $${c.vendorCostUsd.toFixed(4)} (informational)`);
  }
  for (const w of st.warnings ?? []) out.push(`warning: ${w.message}`);
  {
  }
  if (st.pause) out.push("", `paused (quota): ${st.pause.workerId}${st.pause.resetsAt ? ` until ${new Date(st.pause.resetsAt).toISOString()}` : ""}`);
  if (st.attention) {
    out.push("", `needs attention (main repo changed during ${st.attention.stepId}):`);
    for (const c of st.attention.changes) out.push(`  ${c.path}: ${c.before ?? "(absent)"} → ${c.after ?? "(absent)"}`);
  }
  if (st.approval) {
    out.push("", `approval (${st.approval.stepId}): ${st.approval.approvedItemIds === null ? "pending" : `approved [${st.approval.approvedItemIds.join(", ")}]`}`);
    st.approval.items.forEach((it, i) => out.push(formatItem(it, i + 1)));
  }
  if (st.failure) out.push("", `failure (${st.failure.kind}) at ${st.failure.stepId ?? "?"}: ${st.failure.reason}`);
  if (st.result !== undefined) out.push("", `result: ${JSON.stringify(st.result, null, 2)}`);
  return out.join("\n") + "\n";
}

/** A judge item for the approval prompt (duel items have aspect/betterSide/recommendation). */
export function formatItem(it: unknown, n: number): string {
  const o = it as { aspect?: string; betterSide?: string; betterWorker?: string; recommendation?: string; risk?: string; evidence?: string[] };
  if (typeof o?.aspect !== "string") return `  ${n}. ${JSON.stringify(it)}`;
  return [
    `  ${n}. ${o.aspect}: better ${o.betterSide} (${o.betterWorker})`,
    `     → ${o.recommendation}`,
    ...(o.risk ? [`     risk: ${o.risk}`] : []),
    ...(o.evidence?.length ? [`     evidence: ${o.evidence.join(", ")}`] : []),
  ].join("\n");
}
