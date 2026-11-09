<script lang="ts">
  import { languageFor, loadMonaco } from "../lib/monaco.js";
  import { viewer } from "../lib/viewer.svelte.js";

  /** In-app, read-only view of a file at the commit a ref was made against (via the blob endpoint). */
  const req = $derived(viewer.current);
  let host: HTMLDivElement | undefined = $state();
  let error = $state<string | null>(null);
  let missing = $state(false);

  $effect(() => {
    const r = req;
    const el = host;
    if (!r || !el) return;
    let disposed = false;
    let dispose = () => {};
    error = null;
    missing = false;
    (async () => {
      try {
        const url = `/api/runs/${encodeURIComponent(r.ctx.runId)}/blob?rev=${encodeURIComponent(r.ctx.rev)}&path=${encodeURIComponent(r.path)}`;
        const [monaco, res] = await Promise.all([loadMonaco(), fetch(url, { credentials: "same-origin" })]);
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status}`);
        const text = (await res.text()).replace(/\r\n/g, "\n");
        if (disposed) return;
        missing = res.headers.get("x-fractory-missing") === "1";
        const editor = monaco.editor.create(el, {
          value: text,
          language: languageFor(r.path),
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          theme: matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
        });
        const lines = editor.getModel()?.getLineCount() ?? 1;
        const start = Math.min(Math.max(1, r.line), lines);
        const end = Math.min(Math.max(start, r.endLine ?? r.line), lines);
        const deco = editor.createDecorationsCollection([
          { range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: "ref-line", linesDecorationsClassName: "ref-gutter" } },
        ]);
        editor.revealLinesInCenter(start, end);
        dispose = () => {
          deco.clear();
          editor.getModel()?.dispose();
          editor.dispose();
        };
      } catch (e) {
        error = (e as Error).message;
      }
    })();
    return () => {
      disposed = true;
      dispose();
    };
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") viewer.close();
  };
</script>

<svelte:window onkeydown={onKey} />

{#if req}
  <div class="backdrop" role="presentation" onclick={() => viewer.close()}></div>
  <div class="dialog panel" role="dialog" aria-modal="true" aria-label={`${req.path}:${req.line}`}>
    <div class="row head">
      <code class="title">{req.path}:{req.line}{req.endLine ? `-${req.endLine}` : ""}</code>
      <span class="muted small">at {req.ctx.revTitle}{req.ctx.rev !== "base" ? ` (${req.ctx.rev.slice(0, 10)})` : ""}</span>
      <span class="spacer"></span>
      <a class="vscode" href={req.vscode.href} title={req.vscode.note ?? req.vscode.label}>{req.vscode.label}</a>
      <button onclick={() => viewer.close()} aria-label="close">✕</button>
    </div>
    {#if req.vscode.note}<p class="muted small note">{req.vscode.note}</p>{/if}
    {#if error}<p class="error">{error}</p>{/if}
    {#if missing}<p class="error">This file does not exist at {req.ctx.revTitle}.</p>{/if}
    <div class="code" bind:this={host}></div>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 50; }
  .dialog {
    position: fixed; inset: 5vh 6vw; z-index: 51; display: flex; flex-direction: column; gap: 6px;
  }
  .head { align-items: center; }
  .title { font-size: 14px; }
  .spacer { flex: 1; }
  .small { font-size: 12px; }
  .note { margin: 0; }
  .vscode { font-size: 12.5px; }
  .code { flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
</style>
