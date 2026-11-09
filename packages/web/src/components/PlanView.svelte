<script lang="ts">
  import { planSections } from "@fractory/shared/plan";
  import { getJson, getText, runFile } from "../lib/api.js";
  import type { RefContext } from "../lib/refctx.js";
  import Markdown from "./Markdown.svelte";

  let { runId, planFile, decisionJson, refs }: { runId: string; planFile: string; decisionJson: string; refs: RefContext } = $props();

  interface Decision {
    id: string;
    topic: string;
    decision: string;
    rationale: string;
    evidence: string[];
  }

  let plan = $state<string | null>(null);
  let decisions = $state<Record<string, Decision>>({});
  let error = $state<string | null>(null);
  let picked = $state<string[]>([]);

  $effect(() => {
    const id = runId;
    getText(runFile(id, planFile)).then((t) => (plan = t), (e: Error) => (error = e.message));
    getJson<{ verdict: { decisions: Decision[] } }>(runFile(id, decisionJson)).then(
      (j) => (decisions = Object.fromEntries(j.verdict.decisions.map((d) => [d.id, d]))),
      (e: Error) => (error = e.message),
    );
  });

  const sections = $derived(plan === null ? [] : planSections(plan));
</script>

{#if error}<p class="error">{error}</p>{:else if plan === null}<p class="muted">loading…</p>{/if}
{#each sections as s, i (i)}
  {#if s.ids.length}
    <div class="sec marked" class:on={picked.join() === s.ids.join()} role="button" tabindex="0" title="Show the decision behind this section"
      onclick={() => (picked = picked.join() === s.ids.join() ? [] : s.ids)}
      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") picked = picked.join() === s.ids.join() ? [] : s.ids; }}>
      <Markdown text={s.text} {refs} />
      <span class="muted small">decision {s.ids.join(", ")}</span>
    </div>
    {#if picked.join() === s.ids.join()}
      {#each s.ids as id (id)}
        <aside class="panel note">
          {#if decisions[id]}
            <b>{decisions[id].id}. {decisions[id].topic}</b>
            <p>{decisions[id].decision}</p>
            <p><i>Rationale:</i> {decisions[id].rationale}</p>
            <p class="muted small">Evidence: {decisions[id].evidence.join(", ")}</p>
          {:else}<span class="muted">decision {id} not found</span>{/if}
        </aside>
      {/each}
    {/if}
  {:else}
    <div class="sec"><Markdown text={s.text} {refs} /></div>
  {/if}
{/each}

<style>
  .small { font-size: 12px; }
  .marked { cursor: pointer; border-left: 3px solid transparent; padding-left: 8px; }
  .marked:hover, .marked.on { border-left-color: var(--accent, #58f); }
</style>
