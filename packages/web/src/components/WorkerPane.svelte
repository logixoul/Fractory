<script lang="ts">
  import { formatTiming } from "@fractory/shared/timing";
  import type { Pane, StepBlock } from "../lib/panes.js";

  let { pane }: { pane: Pane } = $props();

  const short = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s && s.length > 140 ? `${s.slice(0, 140)}…` : (s ?? "");
  };
</script>

{#snippet body(step: StepBlock)}
  {#if step.detail && !(step.status === "completed" && step.timing)}<div class="muted detail" title={step.detail}>{step.detail}</div>{/if}
  {#if step.timing}
    {@const t = step.timing}
    <div
      class="timing muted"
      title={`wall ${t.wallMs} ms = worker ${t.workerMs} ms (tools ${t.toolMs} ms + generation ${t.generationMs} ms) + orchestrator ${t.orchestratorMs} ms. Generation includes model latency between turns. Input ${t.inputTokens} tokens.${t.reasoningTokens === null ? " Reasoning tokens: not reported separately by this worker." : ""}${t.invocations.length > 1 ? `\n${t.invocations.map((v, i) => `invocation ${i + 1}: ${v.wallMs} ms, ${v.toolCalls} tool calls in ${v.toolRounds} rounds, ${v.outputTokens} out`).join("\n")}` : ""}`}
    >
      {formatTiming(t)}{step.status === "running" ? " (so far)" : ""}
    </div>
  {/if}
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
{/snippet}

<section class="panel pane">
  <h3>{pane.title}</h3>
  {#if pane.steps.length === 0}<p class="muted">waiting…</p>{/if}
  {#each pane.steps as step (`${step.stepId}#${step.attempt}`)}
    {#if step.superseded}
      <!-- An earlier attempt replaced by a retry: collapsed so the live attempt is what's in view. -->
      <details class="step superseded">
        <summary class="head">
          <code>{step.stepId}</code>
          <span class="muted">attempt {step.attempt} (superseded)</span>
          <span class={`badge ${step.status}`}>{step.status}</span>
        </summary>
        {@render body(step)}
      </details>
    {:else}
      <div class="step">
        <div class="head">
          <code>{step.stepId}</code>
          {#if step.attempt > 1}<span class="muted">attempt {step.attempt}</span>{/if}
          <span class={`badge ${step.status}`}>{step.status}</span>
        </div>
        {@render body(step)}
      </div>
    {/if}
  {/each}
</section>

<style>
  .pane { max-height: 75vh; overflow: auto; }
  h3 { margin: 0 0 8px; font-size: 15px; position: sticky; top: -12px; background: var(--panel); padding: 4px 0; }
  .step { border-top: 1px solid var(--border); padding: 8px 0; }
  .head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; margin-bottom: 2px; }
  .superseded > summary { cursor: pointer; opacity: 0.75; }
  .timing { font-size: 12px; margin: 2px 0 4px; font-variant-numeric: tabular-nums; }
  .text { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
  .thinking { color: var(--muted); }
  .tool { margin: 4px 0; font-size: 12.5px; }
  .tool summary { cursor: pointer; }
  .tool.blocked summary code { color: var(--bad); }
  .small { font-size: 12px; }
  .retry { color: var(--warn); margin: 2px 0; }
</style>
