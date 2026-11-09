<script lang="ts">
  import { getText } from "../lib/api.js";
  import { languageFor, loadMonaco } from "../lib/monaco.js";

  /** Monaco side-by-side diff of one file between two revisions ("base" or a contestant label). */
  let { runId, file, left, right, version }: { runId: string; file: string; left: string; right: string; version: string | number } = $props();

  let host: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let editor: { setModel(m: unknown): void; saveViewState(): unknown; restoreViewState(s: unknown): void; dispose(): void } | null = null;
  let models: { dispose(): void }[] = [];
  /** What is shown now: a refetch with identical content leaves Monaco untouched. */
  let shown: { key: string; a: string; b: string } | null = null;

  const blob = (rev: string) => getText(`/api/runs/${encodeURIComponent(runId)}/blob?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(file)}`);

  $effect(() => {
    void version;
    const target = host;
    if (!target) return;
    let cancelled = false;
    (async () => {
      try {
        const [monaco, a, b] = await Promise.all([loadMonaco(), blob(left), blob(right)]);
        if (cancelled) return;
        editor ??= monaco.editor.createDiffEditor(target, {
          readOnly: true,
          automaticLayout: true,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
          theme: matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
        });
        const key = `${file}\0${left}\0${right}`;
        const ta = a.replace(/\r\n/g, "\n");
        const tb = b.replace(/\r\n/g, "\n");
        if (shown && shown.key === key && shown.a === ta && shown.b === tb) return;
        // Same file and sides with new content: keep the scroll position and cursor.
        const view = shown?.key === key ? editor.saveViewState() : null;
        const lang = languageFor(file);
        const original = monaco.editor.createModel(ta, lang);
        const modified = monaco.editor.createModel(tb, lang);
        editor.setModel({ original, modified });
        if (view) editor.restoreViewState(view);
        shown = { key, a: ta, b: tb };
        for (const m of models) m.dispose();
        models = [original, modified];
        error = null;
      } catch (e) {
        error = (e as Error).message;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => () => {
    editor?.dispose();
    for (const m of models) m.dispose();
  });
</script>

{#if error}<p class="error">{error}</p>{/if}
<div class="diff" bind:this={host}></div>

<style>
  .diff { height: 72vh; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
</style>
