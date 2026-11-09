<script lang="ts">
  import { getJson, postJson } from "../lib/api.js";
  import type { RepoCheck, StartInfo } from "../lib/types.js";

  type Workflow = "review" | "consensus" | "duel";
  const WORKFLOWS: { id: Workflow; text: string }[] = [
    { id: "review", text: "one model implements, the other reviews; findings confirmed by tests" },
    { id: "consensus", text: "both models design independently, critique each other, converge on a decision" },
    { id: "duel", text: "both models implement in separate worktrees; a judge compares the diffs" },
  ];

  const DRAFT_KEY = "fractory.newRun.draft";
  const loadDraft = (): { workflow?: Workflow; prompt?: string } => {
    try {
      return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as { workflow?: Workflow; prompt?: string };
    } catch {
      return {};
    }
  };
  const draft = loadDraft();

  let workflow = $state<Workflow>(draft.workflow ?? "review");
  let prompt = $state(draft.prompt ?? "");
  let repo = $state("");
  let info = $state<StartInfo | null>(null);
  let check = $state<RepoCheck | null>(null);
  let checking = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    void getJson<StartInfo>("/api/start-info")
      .then((i) => {
        info = i;
        if (repo === "") repo = i.defaultRepo ?? i.recentRepos[0] ?? "";
      })
      .catch((e: Error) => (error = e.message));
  });

  // Keep the draft per browser tab, so a reload or a misclick does not lose a long prompt.
  $effect(() => {
    const d = JSON.stringify({ workflow, prompt });
    try {
      sessionStorage.setItem(DRAFT_KEY, d);
    } catch {
      /* storage unavailable */
    }
  });

  // Live repo check, debounced; stale answers are dropped.
  let seq = 0;
  $effect(() => {
    const p = repo.trim();
    const wf = workflow;
    const mine = ++seq;
    if (p === "") {
      check = null;
      return;
    }
    checking = true;
    const t = setTimeout(() => {
      void getJson<RepoCheck>(`/api/repo-check?path=${encodeURIComponent(p)}&workflow=${wf}`)
        .then((r) => {
          if (mine === seq) check = r;
        })
        .catch((e: Error) => {
          if (mine === seq) check = { ok: false, error: e.message };
        })
        .finally(() => {
          if (mine === seq) checking = false;
        });
    }, 250);
    return () => clearTimeout(t);
  });

  const canStart = $derived(!busy && !checking && check?.ok === true && prompt.trim() !== "");

  async function start() {
    if (!canStart || !check?.root) return;
    busy = true;
    error = null;
    try {
      const r = await postJson<{ runId: string }>("/api/runs", { workflow, repo: check.root, prompt });
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* storage unavailable */
      }
      location.hash = `#/run/${r.runId}`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void start();
    }
  };
</script>

<div class="row head">
  <h2>New run</h2>
  <span class="spacer"></span>
  <a href="#/">back to runs</a>
</div>

<div class="panel form">
  <fieldset>
    <legend>Workflow</legend>
    {#each WORKFLOWS as w (w.id)}
      <label class="wf">
        <input type="radio" name="workflow" value={w.id} bind:group={workflow} />
        <b>{w.id}</b> <span class="muted">{w.text}</span>
      </label>
    {/each}
  </fieldset>

  <label class="field">
    <span>Repository</span>
    <input type="text" bind:value={repo} list="recent-repos" spellcheck="false" autocomplete="off" placeholder="absolute path of the git repository" />
    <datalist id="recent-repos">
      {#each info?.recentRepos ?? [] as r (r)}<option value={r}></option>{/each}
    </datalist>
  </label>
  {#if info && (info.defaultRepo || info.recentRepos.length)}
    <div class="row recent small">
      <span class="muted">Recent:</span>
      {#each [...new Set([info.defaultRepo, ...info.recentRepos].filter((r): r is string => !!r))].slice(0, 6) as r (r)}
        <button type="button" class="chip" class:on={check?.root === r} title={r} onclick={() => (repo = r)}>{r}</button>
      {/each}
    </div>
  {/if}
  <div class="check small" aria-live="polite">
    {#if repo.trim() === ""}
      <span class="muted">Enter the repository the run works on.</span>
    {:else if checking}
      <span class="muted">checking…</span>
    {:else if check?.ok}
      <span class="okc">✓ git repository</span>
      {#if check.root !== repo.trim()}<span class="muted"> at <code>{check.root}</code></span>{/if}
      <span class="muted"> · {check.branch ? `branch ${check.branch}` : "detached HEAD"} · HEAD {check.head?.slice(0, 8)}</span>
      {#each check.warnings ?? [] as w (w)}<div class="warnc">warning: {w}</div>{/each}
    {:else if check}
      <span class="error">✗ {check.error}</span>
    {/if}
  </div>

  <label class="field">
    <span>Prompt</span>
    <textarea bind:value={prompt} onkeydown={onKey} rows="14" placeholder="What should the models do? (Markdown)"></textarea>
  </label>

  <div class="row">
    <button class="primary" disabled={!canStart} onclick={start}>{busy ? "Starting…" : `Start ${workflow}`}</button>
    <span class="muted small">Ctrl+Enter. The daemon drives the run; closing this page does not stop it.</span>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .head { align-items: baseline; }
  .spacer { flex: 1; }
  .small { font-size: 12px; }
  .form { display: flex; flex-direction: column; gap: 12px; max-width: 980px; }
  fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
  legend, .field > span { font-weight: 600; margin-bottom: 4px; }
  .wf { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
  .field { display: flex; flex-direction: column; }
  input[type="text"], textarea {
    font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg);
  }
  input[type="text"] { font-family: ui-monospace, monospace; }
  textarea { resize: vertical; min-height: 12em; font-family: ui-monospace, monospace; font-size: 13px; }
  .recent { margin-top: -6px; }
  .chip { font-size: 12px; padding: 1px 8px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.on { border-color: var(--accent); color: var(--accent); }
  .check { margin-top: -6px; min-height: 1.4em; }
  .okc { color: var(--ok); }
  .warnc { color: var(--warn); }
</style>
