<script lang="ts">
  import { tick } from "svelte";
  import { getText, runFile } from "../lib/api.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import { linkifyRefs } from "../lib/refs.js";
  import { viewer, type RefContext } from "../lib/viewer.svelte.js";

  /**
   * Renders a run file (or given text) as sanitized markdown. path:line refs open the in-app
   * file view at `refs.rev` (the commit the text was written against).
   */
  let { runId, file, text, refs }: { runId?: string; file?: string; text?: string; refs: RefContext } = $props();

  let source = $state<string | null>(null);
  let error = $state<string | null>(null);
  let el: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (text !== undefined) {
      source = text;
      return;
    }
    if (!runId || !file) return;
    source = null;
    getText(runFile(runId, file))
      .then((t) => (source = t))
      .catch((e: Error) => (error = e.message));
  });

  const html = $derived(source === null ? "" : renderMarkdown(source));
  $effect(() => {
    void html;
    const ctx = refs;
    const target = el;
    // Wait until the {@html} block has written the new markup, then link the refs in it.
    void tick().then(() => {
      if (target) linkifyRefs(target, ctx.roots, (hit) => viewer.open(ctx, hit));
    });
  });
</script>

{#if error}<p class="error">{error}</p>{:else if source === null}<p class="muted">loading…</p>{/if}
<!-- sanitized by DOMPurify in renderMarkdown -->
<div class="md" bind:this={el}>{@html html}</div>
