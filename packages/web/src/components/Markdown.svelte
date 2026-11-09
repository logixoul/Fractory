<script lang="ts">
  import { parseRefHref, type RefLink } from "@fractory/shared/refs";
  import { tick } from "svelte";
  import { getText, runFile } from "../lib/api.js";
  import { renderMarkdown } from "../lib/markdown.js";
  import type { RefContext } from "../lib/refctx.js";
  import { linkifyRefs, type RefHit } from "../lib/refs.js";
  import { viewer } from "../lib/viewer.svelte.js";

  /**
   * Renders a run file (or given text) as sanitized markdown with in-app ref links.
   *  - Resolved-ref links (`#ref/<side>/<sha>/…`, written by the orchestrator) open the file view
   *    at their own side and commit (`onRefLink`).
   *  - Other path:line refs open at `resolveHit(hit)` if given, else at `refs.rev`.
   */
  let {
    runId,
    file,
    text,
    refs,
    onRefLink,
    resolveHit,
  }: {
    runId?: string;
    file?: string;
    text?: string;
    refs: RefContext;
    onRefLink?: (link: RefLink) => RefContext;
    resolveHit?: (hit: RefHit) => RefContext | undefined;
  } = $props();

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
    const forLink = onRefLink;
    const forHit = resolveHit;
    const target = el;
    // Wait until the {@html} block has written the new markup, then wire the refs in it.
    void tick().then(() => {
      if (!target) return;
      for (const a of target.querySelectorAll<HTMLAnchorElement>('a[href^="#ref/"]')) {
        const link = parseRefHref(a.getAttribute("href") ?? "");
        if (!link) continue;
        a.classList.add("ref");
        a.removeAttribute("target");
        a.onclick = (ev) => {
          ev.preventDefault();
          const c = forLink ? forLink(link) : { ...ctx, rev: link.sha };
          viewer.open(c, { path: link.path, written: link.path, line: link.line, raw: a.textContent ?? link.path, ...(link.endLine ? { endLine: link.endLine } : {}) });
        };
      }
      linkifyRefs(target, ctx.roots, (hit) => viewer.open(forHit?.(hit) ?? ctx, hit));
    });
  });
</script>

{#if error}<p class="error">{error}</p>{:else if source === null}<p class="muted">loading…</p>{/if}
<!-- sanitized by DOMPurify in renderMarkdown -->
<div class="md" bind:this={el}>{@html html}</div>
