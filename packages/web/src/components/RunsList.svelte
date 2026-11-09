<script lang="ts">
  import { getJson, postJson } from "../lib/api.js";
  import type { RunSummary } from "../lib/types.js";

  let runs = $state<RunSummary[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      runs = await getJson<RunSummary[]>("/api/runs");
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");

  let gcDays = $state(14);
  let gcBusy = $state(false);
  let gcMessage = $state<string | null>(null);
  async function gc() {
    gcBusy = true;
    try {
      const r = await postJson<{ cleaned: { runId: string; removed: string[] }[] }>("/api/gc", { olderThanDays: Number(gcDays) });
      gcMessage = r.cleaned.length ? `removed the worktrees of ${r.cleaned.length} run(s); branches kept` : "nothing to clean";
      await load();
    } catch (e) {
      gcMessage = (e as Error).message;
    } finally {
      gcBusy = false;
    }
  }
</script>

<div class="row head">
  <h2>Runs</h2>
  <span class="spacer"></span>
  <label class="muted small">Remove worktrees of finished runs older than <input type="number" min="0" bind:value={gcDays} /> days</label>
  <button disabled={gcBusy} onclick={gc}>Clean up</button>
  {#if gcMessage}<span class="muted small">{gcMessage}</span>{/if}
</div>
{#if error}<p class="error">{error}</p>{/if}
{#if runs === null}
  <p class="muted">loading…</p>
{:else if runs.length === 0}
  <p class="muted">No runs yet. Start one from the CLI: <code>fractory consensus --repo &lt;path&gt; --prompt &lt;file&gt;</code></p>
{:else}
  <div class="panel">
    <table>
      <thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Repo</th><th>Created</th><th>Updated</th></tr></thead>
      <tbody>
        {#each runs as r (r.runId)}
          <tr>
            <td><a href={`#/run/${r.runId}`}><code>{r.runId}</code></a></td>
            <td>{r.workflow ?? "?"}</td>
            <td><span class={`badge ${r.status}`}>{r.status}</span>{#if r.driving}<span class="muted"> · driving</span>{/if}</td>
            <td class="repo" title={r.repo}>{r.repo}</td>
            <td>{fmt(r.createdAt)}</td>
            <td>{fmt(r.updatedAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .head { align-items: baseline; }
  .spacer { flex: 1; }
  .small { font-size: 12px; }
  input[type="number"] { width: 4em; font: inherit; }
  .repo { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
