<script lang="ts">
  import { getJson } from "../lib/api.js";
  import type { RunState } from "../lib/types.js";
  import DiffView from "./DiffView.svelte";
  import Markdown from "./Markdown.svelte";

  let { state: st }: { state: RunState } = $props();

  const labels = $derived(Object.keys(st.labels).sort());
  const who = (l: string) => `${st.labels[l]} (${l})`;
  const fileOf = (stepId: string) => {
    const s = st.steps[stepId];
    return s?.status === "completed" ? (s.result as { file?: string; noChanges?: boolean } | undefined) : undefined;
  };

  // consensus documents: proposals, critiques, revision rounds
  const docs = $derived.by(() => {
    const out: { key: string; title: string }[] = [];
    if (labels.some((l) => fileOf(`propose.${l}`))) out.push({ key: "propose", title: "Proposals" });
    if (labels.some((l) => fileOf(`critique.${l}`))) out.push({ key: "critique", title: "Critiques" });
    for (let n = 1; labels.some((l) => st.steps[`revise.r${n}.${l}`]); n++) out.push({ key: `revise.r${n}`, title: `Revision ${n}` });
    return out;
  });
  let doc = $state("propose");

  // duel: changed files and diff mode
  type Mode = "AvsB" | "baseA" | "baseB";
  let mode = $state<Mode>("AvsB");
  let files = $state<string[]>([]);
  let selected = $state<string | null>(null);
  let filesError = $state<string | null>(null);
  const setupDone = $derived(st.steps.setup?.status === "completed");

  $effect(() => {
    if (st.workflow !== "duel" || !setupDone) return;
    void st.lastSeq; // refetch as the branches evolve
    Promise.all(labels.map((l) => getJson<string[]>(`/api/runs/${st.runId}/changes/${l}`)))
      .then((lists) => {
        files = [...new Set(lists.flat())].sort();
        if (selected === null || !files.includes(selected)) selected = files[0] ?? null;
        filesError = null;
      })
      .catch((e: Error) => (filesError = e.message));
  });

  const sides = $derived.by((): [string, string] => {
    const [a, b] = labels as [string, string];
    return mode === "AvsB" ? [a, b] : mode === "baseA" ? ["base", a] : ["base", b];
  });
</script>

{#if st.workflow === "duel"}
  {#if !setupDone}
    <p class="muted">The worktrees are not set up yet.</p>
  {:else}
    <div class="row bar">
      <label><input type="radio" bind:group={mode} value="AvsB" /> {who(labels[0]!)} vs {who(labels[1]!)}</label>
      <label><input type="radio" bind:group={mode} value="baseA" /> base vs {who(labels[0]!)}</label>
      <label><input type="radio" bind:group={mode} value="baseB" /> base vs {who(labels[1]!)}</label>
    </div>
    {#if filesError}<p class="error">{filesError}</p>{/if}
    <div class="duel">
      <ul class="files panel">
        {#each files as f (f)}
          <li><button class:sel={f === selected} onclick={() => (selected = f)}>{f}</button></li>
        {:else}
          <li class="muted">no changes yet</li>
        {/each}
      </ul>
      <div>
        {#if selected}
          <div class="row muted small"><span>left: {sides[0] === "base" ? "base" : who(sides[0])}</span><span>→ right: {who(sides[1])}</span></div>
          <DiffView runId={st.runId} file={selected} left={sides[0]} right={sides[1]} version={st.lastSeq} />
        {/if}
      </div>
    </div>
  {/if}
{:else if docs.length === 0}
  <p class="muted">No proposals yet.</p>
{:else}
  <div class="row bar">
    {#each docs as d (d.key)}
      <button class:primary={doc === d.key} onclick={() => (doc = d.key)}>{d.title}</button>
    {/each}
  </div>
  <div class="grid2">
    {#each labels as l (l)}
      {@const r = fileOf(`${doc}.${l}`)}
      <section class="panel">
        <h3>{who(l)}{#if r?.noChanges}<span class="badge"> no changes</span>{/if}</h3>
        {#if r?.file}
          {#key r.file}<Markdown runId={st.runId} file={r.file} root={st.repo} />{/key}
        {:else}
          <p class="muted">not available yet</p>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .bar { margin: 8px 0 12px; }
  .duel { display: grid; grid-template-columns: 260px 1fr; gap: 12px; }
  .files { list-style: none; margin: 0; padding: 6px; max-height: 75vh; overflow: auto; }
  .files button { width: 100%; text-align: left; border: none; background: none; padding: 4px 6px; font-family: ui-monospace, monospace; font-size: 12px; }
  .files button.sel { background: var(--accent); color: white; }
  h3 { margin: 0 0 8px; font-size: 15px; }
  .small { font-size: 12px; margin-bottom: 4px; }
</style>
