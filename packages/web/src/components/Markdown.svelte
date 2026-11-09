<script lang="ts">
  import { getText, runFile } from "../lib/api.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import { linkifyRefs } from "../lib/refs.js";

  /** Renders a run file (or given text) as sanitized markdown with clickable path:line refs. */
  let { runId, file, text, root }: { runId?: string; file?: string; text?: string; root: string } = $props();

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
    if (el) linkifyRefs(el, root);
  });
</script>

{#if error}<p class="error">{error}</p>{:else if source === null}<p class="muted">loading…</p>{/if}
<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by DOMPurify in renderMarkdown -->
<div class="md" bind:this={el}>{@html html}</div>
