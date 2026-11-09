<script lang="ts">
  import { postJson } from "../lib/api.js";
  import type { RunState } from "../lib/types.js";
  import { evidenceMarkdown, type RefLink, type ResolvedRef } from "@fractory/shared/refs";
  import { refContext } from "../lib/refctx.js";
  import Markdown from "./Markdown.svelte";

  /** Review workflow: findings, test confirmation, responses, rebuttals, and the apply/dismiss gate. */
  let { state: st, onAct, onRefresh, busy }: { state: RunState; onAct: (path: string, body?: unknown) => Promise<void>; onRefresh: () => Promise<void>; busy: boolean } = $props();

  interface Finding {
    id: string;
    severity: string;
    title: string;
    explanation: string;
    refs: string[];
    resolvedRefs: ResolvedRef[];
    confidence: number;
    testFile?: { path: string; content: string };
  }
  interface TestRun { status: string; reason: string }
  interface Answer { id: string; action: string; reasoning: string; refs: string[]; resolvedRefs: ResolvedRef[] }
  interface Rebuttal { id: string; verdict: string; reasoning: string; refs: string[]; resolvedRefs: ResolvedRef[]; auto?: string; evidenceInvalid?: boolean }
  interface Item { id: string; severity: string; title: string; test: string; implementer: string; reviewer: string; refs: string[]; resolvedRefs: ResolvedRef[] }

  const done = <T,>(id: string): T | undefined => (st.steps[id]?.status === "completed" ? (st.steps[id]!.result as T) : undefined);
  const review = $derived(done<{ summary: string; head: string; findings: Finding[]; dropped: Finding[] }>("review"));
  const confirm = $derived(done<{ results: Record<string, TestRun> }>("confirm"));
  const rounds = $derived.by(() => {
    const out: { n: number; responses: Answer[]; retest?: Record<string, TestRun>; rebuttals: Rebuttal[] }[] = [];
    for (let n = 1; done(`respond.${n}`); n++) {
      out.push({
        n,
        responses: done<{ responses: Answer[] }>(`respond.${n}`)!.responses,
        ...(done(`retest.${n}`) ? { retest: done<{ results: Record<string, TestRun> }>(`retest.${n}`)!.results } : {}),
        rebuttals: done<{ rebuttals: Rebuttal[] }>(`rebuttal.${n}`)?.rebuttals ?? [],
      });
    }
    return out;
  });
  const items = $derived(st.approval?.stepId === "approve" ? (st.approval.items as Item[]) : []);
  const pending = $derived(st.status === "awaiting_approval" && st.approval?.approvedItemIds === null);
  const approved = $derived(st.approval?.approvedItemIds ?? null);
  const result = $derived((st.result ?? {}) as { reportMd?: string });

  const who = (label: string) => `${st.labels[label] ?? label} (${label})`;
  const toLink = (link: RefLink) => refContext(st, { ...(link.label ? { label: link.label } : {}), rev: link.sha, revTitle: link.label ? `${who(link.label)} head` : "base commit" });
  const refsMd = (refs: string[], resolved: ResolvedRef[]) => evidenceMarkdown(refs, resolved ?? [], st.labels);
  const implLabel = $derived(done<{ implementerLabel?: string }>("setup")?.implementerLabel);
  // Prose refs point into the implementer's head as the reviewer saw it.
  const headCtx = $derived(
    review && implLabel ? refContext(st, { label: implLabel, rev: review.head, revTitle: `${who(implLabel)} head at review` }) : refContext(st),
  );

  let picked = $state<Record<number, boolean>>({});
  const chosen = $derived(items.map((_, i) => i + 1).filter((n) => picked[n]));
  let error = $state<string | null>(null);

  async function decide(andResume: boolean) {
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

{#if !review}
  <p class="muted">The reviewer has not reported yet.</p>
{:else}
  {#if items.length > 0}
    <section class="panel">
      <h3>Disagreements</h3>
      <p class="muted small">The reviewer maintains these findings; the implementer did not resolve them. Tick the ones to apply; the rest are dismissed.</p>
      <table>
        <thead><tr><th>Apply</th><th>#</th><th>Finding</th><th>Test</th><th>Implementer</th><th>Reviewer</th><th>Refs</th></tr></thead>
        <tbody>
          {#each items as it, i (it.id)}
            <tr class:on={approved?.includes(i + 1)}>
              <td>
                {#if pending}
                  <input type="checkbox" bind:checked={picked[i + 1]} aria-label={`apply finding ${it.id}`} />
                {:else if approved !== null}{approved.includes(i + 1) ? "apply" : "dismiss"}{/if}
              </td>
              <td>{i + 1}</td>
              <td><b>{it.id}</b> <span class={`sev ${it.severity}`}>{it.severity}</span> {it.title}</td>
              <td>{it.test}</td>
              <td>{it.implementer}</td>
              <td>{it.reviewer}</td>
              <td><Markdown text={refsMd(it.refs, it.resolvedRefs)} refs={headCtx} onRefLink={toLink} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if pending}
        <div class="row actions">
          <button class="primary" disabled={busy} onclick={() => decide(true)}>Apply {chosen.length}, dismiss {items.length - chosen.length}, and resume</button>
          <button disabled={busy} onclick={() => decide(false)}>Decide only</button>
          {#if error}<span class="error">{error}</span>{/if}
        </div>
      {:else if approved !== null && st.status === "awaiting_approval"}
        <div class="row actions"><span>Decided.</span><button class="primary" disabled={busy} onclick={() => onAct("resume")}>Resume</button></div>
      {/if}
    </section>
  {/if}

  <section class="panel">
    <h3>Review</h3>
    <p>{review.summary}</p>
    {#if review.findings.length === 0}<p class="muted">No findings.</p>{/if}
    {#each review.findings as f (f.id)}
      {@const test = confirm?.results[f.id]}
      <article class="finding">
        <h4><b>{f.id}</b> <span class={`sev ${f.severity}`}>{f.severity}</span> {f.title} <span class="muted small">confidence {f.confidence}</span></h4>
        <Markdown text={f.explanation} refs={headCtx} />
        <div class="small"><Markdown text={`Refs: ${refsMd(f.refs, f.resolvedRefs)}`} refs={headCtx} onRefLink={toLink} /></div>
        {#if f.testFile}
          <details class="small">
            <summary>test <code>{f.testFile.path}</code>: <b class={`test ${test?.status ?? ""}`}>{test?.status ?? "pending"}</b> {test?.reason ?? ""}</summary>
            <pre>{f.testFile.content}</pre>
          </details>
        {/if}
        {#each rounds as r (r.n)}
          {@const a = r.responses.find((x) => x.id === f.id)}
          {@const b = r.rebuttals.find((x) => x.id === f.id)}
          {#if a}
            <div class="round small">
              <div>Round {r.n} · implementer <b>{a.action}</b>: {a.reasoning}</div>
              {#if r.retest?.[f.id]}<div>test after the changes: <b class={`test ${r.retest[f.id]!.status}`}>{r.retest[f.id]!.status}</b></div>{/if}
              {#if b}<div>reviewer <b>{b.verdict}</b>{b.auto ? " (automatic)" : ""}: {b.reasoning}{b.evidenceInvalid ? " (its evidence did not resolve)" : ""}</div>{/if}
            </div>
          {/if}
        {/each}
      </article>
    {/each}
    {#if review.dropped.length}
      <p class="muted small">Dropped (no reference resolved): {review.dropped.map((f) => `${f.id} ${f.title}`).join("; ")}</p>
    {/if}
  </section>

  {#if result.reportMd}
    <section class="panel report"><Markdown runId={st.runId} file={result.reportMd} refs={headCtx} onRefLink={toLink} /></section>
  {/if}
{/if}

<style>
  h3 { margin: 0 0 8px; }
  h4 { margin: 0 0 4px; font-size: 14px; }
  .small { font-size: 12px; }
  .finding { border-top: 1px solid var(--border, #8884); padding: 8px 0; }
  .round { margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--border, #8884); }
  .sev { font-size: 11px; padding: 0 4px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 15%, transparent); }
  .sev.bug { background: color-mix(in srgb, var(--err, #c33) 20%, transparent); }
  .test.confirmed { color: var(--err, #c33); }
  .test.refuted { color: var(--ok, #393); }
  tr.on { background: color-mix(in srgb, var(--ok) 10%, transparent); }
  td :global(.md p) { margin: 0; }
  pre { max-height: 300px; overflow: auto; }
  .actions { margin-top: 12px; }
  .report { margin-top: 12px; }
</style>
