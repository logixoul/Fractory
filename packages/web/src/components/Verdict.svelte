<script lang="ts">
  import { postJson } from "../lib/api.js";
  import type { RunState } from "../lib/types.js";
  import { refContext } from "../lib/refctx.js";
  import Markdown from "./Markdown.svelte";

  let { state: st, onAct, onRefresh, busy }: { state: RunState; onAct: (path: string, body?: unknown) => Promise<void>; onRefresh: () => Promise<void>; busy: boolean } = $props();

  interface Item {
    aspect: string;
    betterSide: string;
    betterWorker: string;
    betterLabel: string;
    evidence: string[];
    recommendation: string;
    risk: string;
  }

  const judge = $derived(st.steps.judge?.status === "completed" ? (st.steps.judge.result as Record<string, unknown>) : undefined);
  const items = $derived(st.workflow === "duel" ? ((judge?.items as Item[] | undefined) ?? []) : []);
  const pending = $derived(st.status === "awaiting_approval" && st.approval?.approvedItemIds === null);
  const approved = $derived(st.approval?.approvedItemIds ?? null);
  const result = $derived((st.result ?? {}) as { decisionMd?: string; reportMd?: string });

  // A duel item's evidence refers to the better side's code as the judge saw it (its head then).
  const itemRefs = (it: Item) => {
    const heads = (judge?.heads as Record<string, string> | undefined) ?? {};
    const rev = heads[it.betterLabel];
    return refContext(st, rev ? { label: it.betterLabel, rev, revTitle: `${it.betterWorker} (${it.betterLabel}) head at judging` } : { label: it.betterLabel });
  };

  let picked = $state<Record<number, boolean>>({});
  const chosen = $derived(items.map((_, i) => i + 1).filter((n) => picked[n]));
  let error = $state<string | null>(null);

  async function approve(andResume: boolean) {
    error = null;
    try {
      await postJson(`/api/runs/${encodeURIComponent(st.runId)}/approve`, { items: chosen });
      if (andResume) await onAct("resume");
      else await onRefresh();
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

{#if st.workflow === "consensus"}
  {#if result.decisionMd}
    <section class="panel"><Markdown runId={st.runId} file={result.decisionMd} refs={refContext(st)} /></section>
  {:else}
    <p class="muted">The judge has not decided yet.</p>
  {/if}
{:else if !judge}
  <p class="muted">The judge has not produced items yet.</p>
{:else}
  <section class="panel">
    <h3>Judge</h3>
    <p>{judge.summary}</p>
    {#if judge.noRobustPreferences}
      <p class="panel note">No robust preferences: with A and B swapped, the judge agreed with none of its first-pass items. There is nothing to approve; resuming finishes the run.</p>
    {/if}
    <p class="muted small">A = {(judge.sides as Record<string, { workerId: string }>).A?.workerId}, B = {(judge.sides as Record<string, { workerId: string }>).B?.workerId}. The judge saw only A/B.</p>
    <table>
      <thead><tr><th></th><th>#</th><th>Aspect</th><th>Better</th><th>Recommendation</th><th>Risk</th><th>Evidence</th></tr></thead>
      <tbody>
        {#each items as it, i (i)}
          <tr class:on={approved?.includes(i + 1)}>
            <td>
              {#if pending}
                <input type="checkbox" bind:checked={picked[i + 1]} aria-label={`approve item ${i + 1}`} />
              {:else if approved?.includes(i + 1)}✓{/if}
            </td>
            <td>{i + 1}</td>
            <td>{it.aspect}</td>
            <td><b>{it.betterSide}</b> <span class="muted">({it.betterWorker})</span></td>
            <td><Markdown text={it.recommendation} refs={itemRefs(it)} /></td>
            <td>{it.risk}</td>
            <td><Markdown text={it.evidence.map((e) => `\`${e}\``).join(", ")} refs={itemRefs(it)} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if pending}
      <div class="row actions">
        <button class="primary" disabled={busy} onclick={() => approve(true)}>Approve {chosen.length} item(s) and resume</button>
        <button disabled={busy} onclick={() => approve(false)}>Approve only</button>
        {#if chosen.length === 0}<span class="muted small">Approving none skips the apply step.</span>{/if}
        {#if error}<span class="error">{error}</span>{/if}
      </div>
    {:else if approved !== null && st.status === "awaiting_approval"}
      <div class="row actions"><span>Approved [{approved.join(", ")}].</span><button class="primary" disabled={busy} onclick={() => onAct("resume")}>Resume</button></div>
    {/if}
  </section>
  {#if result.reportMd}
    <section class="panel report"><Markdown runId={st.runId} file={result.reportMd} refs={refContext(st)} /></section>
  {/if}
{/if}

<style>
  h3 { margin: 0 0 8px; }
  .small { font-size: 12px; }
  tr.on { background: color-mix(in srgb, var(--ok) 10%, transparent); }
  td :global(.md p) { margin: 0; }
  .actions { margin-top: 12px; }
  .report { margin-top: 12px; }
</style>
