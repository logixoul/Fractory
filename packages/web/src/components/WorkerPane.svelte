<script lang="ts">
  import type { Pane } from "../lib/panes.js";

  let { pane }: { pane: Pane } = $props();

  const short = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s && s.length > 140 ? `${s.slice(0, 140)}…` : (s ?? "");
  };
</script>

<section class="panel pane">
  <h3>{pane.title}</h3>
  {#if pane.steps.length === 0}<p class="muted">waiting…</p>{/if}
  {#each pane.steps as step (`${step.stepId}#${step.attempt}`)}
    <div class="step">
      <div class="head">
        <code>{step.stepId}</code>
        {#if step.attempt > 1}<span class="muted">attempt {step.attempt}</span>{/if}
        <span class={`badge ${step.status}`}>{step.status}</span>
        {#if step.detail}<span class="muted detail" title={step.detail}>{step.detail}</span>{/if}
      </div>
      {#each step.items as it, i (i)}
        {#if it.kind === "text"}
          <div class="text">{it.text}</div>
        {:else if it.kind === "thinking"}
          <details class="thinking"><summary>thinking ({it.text.length} chars)</summary><div class="text">{it.text}</div></details>
        {:else if it.kind === "tool"}
          <details class="tool" class:blocked={!!it.blocked} class:err={it.isError}>
            <summary>
              <code>{it.name}</code> <span class="muted">{short(it.input)}</span>
              {#if it.blocked}<span class="badge fail">blocked</span>{:else if it.isError}<span class="badge fail">error</span>{/if}
            </summary>
            {#if it.blocked}<pre>{it.blocked}</pre>{/if}
            <pre>{JSON.stringify(it.input, null, 2)}</pre>
            {#if it.output !== undefined}<pre>{it.output}</pre>{/if}
          </details>
        {:else if it.kind === "error"}
          <div class="error">{it.text}</div>
        {:else if it.kind === "retry"}
          <div class="retry small">↻ {it.text}</div>
        {:else}
          <div class="muted small">{it.text}</div>
        {/if}
      {/each}
    </div>
  {/each}
</section>

<style>
  .pane { max-height: 75vh; overflow: auto; }
  h3 { margin: 0 0 8px; font-size: 15px; position: sticky; top: -12px; background: var(--panel); padding: 4px 0; }
  .step { border-top: 1px solid var(--border); padding: 8px 0; }
  .head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; font-size: 12px; }
  .text { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
  .thinking { color: var(--muted); }
  .tool { margin: 4px 0; font-size: 12.5px; }
  .tool summary { cursor: pointer; }
  .tool.blocked summary code { color: var(--bad); }
  .small { font-size: 12px; }
  .retry { color: var(--warn); margin: 2px 0; }
</style>
