<script lang="ts">
  import { postJson } from "../lib/api.js";
  import { LiveRun } from "../lib/live.svelte.js";
  import { buildPanes, phaseStatuses } from "../lib/panes.js";
  import Compare from "./Compare.svelte";
  import Verdict from "./Verdict.svelte";
  import WorkerPane from "./WorkerPane.svelte";

  let { runId, tab }: { runId: string; tab: "live" | "compare" | "verdict" } = $props();

  // RunView is re-created per run ({#key runId} in App), so the initial runId is the right one.
  // svelte-ignore state_referenced_locally
  const live = new LiveRun(runId);
  $effect(() => {
    live.start();
    return () => live.stop();
  });

  const st = $derived(live.state);
  const panes = $derived(st ? buildPanes(live.events, st.labels) : []);
  const phases = $derived(st ? phaseStatuses(st) : []);
  const terminal = $derived(st ? ["completed", "failed", "cancelled"].includes(st.status) : true);
  const outcome = $derived(st?.result as { forfeited?: string[]; winner?: { label: string; workerId: string; branch: string } } | undefined);
  const canResume =$derived(!!st && !st.driving && ["paused_quota", "needs_attention", "running"].includes(st.status));

  let busy = $state(false);
  let actionError = $state<string | null>(null);

  async function act(path: string, body: unknown = {}) {
    busy = true;
    actionError = null;
    try {
      await postJson(`/api/runs/${encodeURIComponent(runId)}/${path}`, body);
      live.reconnect();
      await live.refresh();
    } catch (e) {
      actionError = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

{#if !st}
  <p class="muted">{live.error ?? "loading…"}</p>
{:else}
  <div class="top">
    <div>
      <h2>
        <code>{st.runId}</code>
        <span class="muted">{st.workflow}</span>
        <span class={`badge ${st.status}`}>{st.status}</span>
        {#if st.driving}<span class="muted small">driving</span>{/if}
        <span class="dot" class:on={live.connected} title={live.connected ? "live" : "not streaming"}></span>
      </h2>
      <div class="muted small">{st.repo}</div>
    </div>
    <nav class="row">
      <a class:sel={tab === "live"} href={`#/run/${runId}/live`}>Live</a>
      <a class:sel={tab === "compare"} href={`#/run/${runId}/compare`}>Compare</a>
      <a class:sel={tab === "verdict"} href={`#/run/${runId}/verdict`}>Verdict{st.status === "awaiting_approval" ? " ●" : ""}</a>
    </nav>
  </div>

  <ol class="phases">
    {#each phases as p (p.phase)}
      <li class={p.status}>{p.phase}</li>
    {/each}
  </ol>

  <div class="row controls">
    {#if canResume}
      <button class="primary" disabled={busy} onclick={() => act("resume")}>{st.status === "needs_attention" ? "Continue" : "Resume"}</button>
    {/if}
    {#if st.status === "paused_quota" && !st.driving}
      <button disabled={busy} onclick={() => act("resume", { force: true })}>Resume now (force)</button>
    {/if}
    {#if !terminal}
      <button class="danger" disabled={busy} onclick={() => act("cancel")}>{st.status === "needs_attention" ? "Abort" : "Cancel"}</button>
    {/if}
    {#if st.status === "failed" && st.failure?.stepId && !st.driving}
      <button class="primary" disabled={busy} onclick={() => act("resume", { retryFailed: true })}>Retry failed step</button>
    {/if}
    {#if terminal && !st.cleaned && !st.driving}
      <button disabled={busy} onclick={() => act("clean")} title="Removes the worktree directories; branches are kept">Remove worktrees</button>
    {/if}
    {#if st.cleaned}<span class="muted small">worktrees removed {new Date(st.cleaned.at).toLocaleString()} (branches kept)</span>{/if}
    {#if actionError}<span class="error">{actionError}</span>{/if}
  </div>

  {#if st.status === "paused_quota" && st.pause}
    <div class="panel note">Quota exhausted for <b>{st.pause.workerId}</b>{st.pause.resetsAt ? `; resets ${new Date(st.pause.resetsAt).toLocaleString()}` : ""}. Nothing retries automatically.</div>
  {/if}
  {#if st.status === "needs_attention" && st.attention}
    <div class="panel note">
      Your repository changed while <code>{st.attention.stepId}</code> ran (you may be editing it). The step's result stands.
      Continue or abort:
      <ul>{#each st.attention.changes as c (c.path)}<li><code>{c.path}</code> <span class="muted">{c.before ?? "(absent)"} → {c.after ?? "(absent)"}</span></li>{/each}</ul>
    </div>
  {/if}
  {#if st.failure}
    <div class="panel note error">Failed at <code>{st.failure.stepId ?? "?"}</code> ({st.failure.kind}): <pre>{st.failure.reason}</pre></div>
  {/if}
  {#if st.driverError}<div class="panel note error">Driver error: {st.driverError}</div>{/if}
  {#each st.warnings ?? [] as w, i (i)}
    <div class="panel note warn">⚠ {w.message}{#if w.stepId} <span class="muted">({w.stepId})</span>{/if}</div>
  {/each}
  {#if outcome?.winner}
    <div class="panel note">
      {outcome.forfeited?.map((l) => st.labels[l]).join(", ")} forfeited (no changes). Result: <code>{outcome.winner.branch}</code> ({outcome.winner.workerId}).
    </div>
  {/if}

  {#if tab === "live"}
    <div class="panes" style={`grid-template-columns: repeat(${Math.max(1, panes.length)}, minmax(320px, 1fr))`}>
      {#each panes as pane (pane.key)}
        <WorkerPane {pane} />
      {/each}
    </div>
  {:else if tab === "compare"}
    <Compare state={st} />
  {:else}
    <Verdict state={st} onAct={act} onRefresh={() => live.refresh()} {busy} />
  {/if}
{/if}

<style>
  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  h2 { margin: 0 0 4px; display: flex; gap: 10px; align-items: center; font-size: 18px; }
  .small { font-size: 12px; }
  nav a { padding: 4px 10px; border-radius: 6px; text-decoration: none; }
  nav a.sel { background: var(--accent); color: white; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); display: inline-block; }
  .dot.on { background: var(--ok); }
  .phases { display: flex; list-style: none; padding: 0; margin: 14px 0; gap: 4px; flex-wrap: wrap; }
  .phases li { padding: 4px 12px; border-radius: 14px; border: 1px solid var(--border); color: var(--muted); font-size: 12.5px; }
  .phases li.done { border-color: var(--ok); color: var(--ok); }
  .phases li.active { border-color: var(--accent); color: white; background: var(--accent); }
  .phases li.failed { border-color: var(--bad); color: var(--bad); }
  .controls { margin-bottom: 10px; }
  .note { margin: 8px 0; }
  .warn { border-color: var(--warn); }
  .panes { display: grid; gap: 12px; align-items: start; overflow-x: auto; }
</style>
