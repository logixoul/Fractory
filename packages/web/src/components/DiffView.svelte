<script lang="ts">
  import { getText } from "../lib/api.js";
  import { languageFor, loadMonaco } from "../lib/monaco.js";

  /** Monaco side-by-side diff of one file between two revisions ("base" or a contestant label). */
  let { runId, file, left, right, version }: { runId: string; file: string; left: string; right: string; version: number } = $props();

  let host: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let editor: { setModel(m: unknown): void; dispose(): void } | null = null;
  let models: { dispose(): void }[] = [];

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
        const lang = languageFor(file);
        const original = monaco.editor.createModel(a.replace(/\r\n/g, "\n"), lang);
        const modified = monaco.editor.createModel(b.replace(/\r\n/g, "\n"), lang);
        editor.setModel({ original, modified });
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
