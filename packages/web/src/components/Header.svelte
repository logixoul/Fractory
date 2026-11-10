<script lang="ts">
  import { isOnExtraUsage, isQuotaExhaustedStatus } from "@fractory/shared/events";
  import { getJson } from "../lib/api.js";
  import type { QuotaEntry, RunSummary } from "../lib/types.js";

  // Header widget: Claude quota (from rate-limit events) and token/cost totals of the other workers.
  let quota = $state<Record<string, QuotaEntry>>({});
  let runs = $state<RunSummary[]>([]);
  let error = $state<string | null>(null);

  async function load() {
    try {
      [quota, runs] = await Promise.all([getJson<Record<string, QuotaEntry>>("/api/quota"), getJson<RunSummary[]>("/api/runs")]);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  });

  // Metered workers: tokens and orchestrator-computed cost. Subscription workers (Claude Pro):
  // tokens and the vendor's API-equivalent figure, which is not what you pay.
  const totals = $derived.by(() => {
    const out: Record<string, { input: number; output: number; cost: number; unknown: boolean; subscription: boolean; extra: number; extraUnknown: boolean }> = {};
    for (const r of runs) {
      for (const [w, c] of Object.entries(r.costs ?? {})) {
        const subscription = c.billing === "subscription" || (r.workerKinds?.[w] ?? "") === "claude";
        const t = (out[w] ??= { input: 0, output: 0, cost: 0, unknown: false, subscription, extra: 0, extraUnknown: false });
        t.input += c.tokens.input + c.tokens.cacheRead + c.tokens.cacheWrite;
        t.output += c.tokens.output;
        t.cost += subscription ? c.vendorCostUsd : c.costUsd;
        t.unknown ||= !subscription && c.costUnknown;
        // A subscription worker's costUsd is what it ran on extra usage (paid at API rates).
        if (subscription) {
          t.extra += c.costUsd;
          t.extraUnknown ||= c.billing === "overage" && c.costUnknown;
        }
      }
    }
    return out;
  });

  const pct = (u: number) => `${Math.round(u * 100)}%`;
  const when = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?");
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
</script>

<header>
  <a class="brand" href="#/">fractory</a>
  <div class="widgets">
    {#each Object.entries(quota) as [worker, q] (worker)}
      <span class="w" title={`last observed ${new Date(q.observedAt).toLocaleString()}`}>
        <b>{worker}</b>
        {#if isOnExtraUsage(q.status, q.overage)}
          <span class="badge extra" title={`subscription windows ${q.status}; extra usage ${q.overage?.status}: work continues, billed at API rates`}>extra usage</span>
        {:else}
          <span
            class="badge"
            class:fail={isQuotaExhaustedStatus(q.status, q.overage)}
            title={q.overage ? `extra usage ${q.overage.status}${q.overage.disabledReason ? ` (${q.overage.disabledReason})` : ""}` : undefined}>{q.status}</span
          >
        {/if}
        {#each Object.entries(q.windows) as [name, w] (name)}
          <span class:hot={w.utilization >= 0.8}>{name.replace("_", " ")} {pct(w.utilization)} (resets {when(w.resetsAt)})</span>
        {/each}
      </span>
    {/each}
    {#each Object.entries(totals) as [worker, t] (worker)}
      {#if t.subscription}
        <span class="w" title="Subscription: not metered. The figure is the vendor's API-equivalent price, for reference only."
          ><b>{worker}</b> {k(t.input)} in / {k(t.output)} out · API-equivalent ${t.cost.toFixed(2)}{#if t.extra > 0 || t.extraUnknown}<span
            class="extra-cost"
            title="Run on extra usage: billed at API rates (orchestrator-computed from the price table; cache writes priced at the 1-hour rate, an upper bound)"
            > · extra usage ${t.extra.toFixed(2)}{t.extraUnknown ? "+?" : ""}</span
          >{/if}</span
        >
      {:else}
        <span class="w"><b>{worker}</b> {k(t.input)} in / {k(t.output)} out · ${t.cost.toFixed(3)}{t.unknown ? "+?" : ""}</span>
      {/if}
    {/each}
    {#if error}<span class="error">{error}</span>{/if}
  </div>
</header>

<style>
  header {
    display: flex; align-items: center; gap: 24px; padding: 10px 16px;
    border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 10;
  }
  .brand { font-weight: 700; font-size: 16px; text-decoration: none; color: var(--fg); }
  .widgets { display: flex; gap: 20px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
  .w { display: inline-flex; gap: 6px; align-items: center; }
  .w b { color: var(--fg); font-weight: 600; }
  .badge.extra, .extra-cost { color: var(--warn); border-color: var(--warn); }
  .hot { color: var(--warn); }
</style>
