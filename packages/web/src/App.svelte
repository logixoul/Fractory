<script lang="ts">
  import FileView from "./components/FileView.svelte";
  import Header from "./components/Header.svelte";
  import NewRun from "./components/NewRun.svelte";
  import RunsList from "./components/RunsList.svelte";
  import RunView from "./components/RunView.svelte";

  type Route = { name: "runs" } | { name: "new" } | { name: "run"; runId: string; tab: "live" | "compare" | "verdict" };

  function parse(hash: string): Route {
    const m = /^#\/run\/([0-9]{8}-[0-9]{6}-[0-9a-f]{4})(?:\/(live|compare|verdict))?$/.exec(hash);
    if (m) return { name: "run", runId: m[1]!, tab: (m[2] as "live" | "compare" | "verdict" | undefined) ?? "live" };
    if (hash === "#/new") return { name: "new" };
    return { name: "runs" };
  }

  let route = $state<Route>(parse(location.hash));
  $effect(() => {
    const on = () => (route = parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  });
</script>

<Header />
<main>
  {#if route.name === "runs"}
    <RunsList />
  {:else if route.name === "new"}
    <NewRun />
  {:else}
    {#key route.runId}
      <RunView runId={route.runId} tab={route.tab} />
    {/key}
  {/if}
</main>
<FileView />
