import { getJson } from "./api.js";
import type { RunEvent, RunState } from "./types.js";

/**
 * Live view of one run. Everything comes from the daemon: the event log is replayed from the
 * start over SSE (EventSource reconnects with Last-Event-ID by itself), and the derived state
 * is refetched after events. A page refresh therefore loses nothing.
 */
export class LiveRun {
  state = $state<RunState | null>(null);
  events = $state<RunEvent[]>([]);
  connected = $state(false);
  error = $state<string | null>(null);
  #es: EventSource | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastSeq = 0;

  constructor(readonly runId: string) {}

  start(): void {
    void this.refresh();
    this.#open();
  }

  /** After a command (resume, …) the run streams again: reopen if the stream had ended. */
  reconnect(): void {
    if (this.#es && this.#es.readyState !== EventSource.CLOSED) return;
    this.#open();
  }

  #open(): void {
    this.#es?.close();
    const es = new EventSource(`/api/runs/${encodeURIComponent(this.runId)}/events/stream?since=${this.#lastSeq}`);
    this.#es = es;
    es.onopen = () => (this.connected = true);
    es.onerror = () => (this.connected = false);
    es.addEventListener("run_event", (m) => {
      const ev = JSON.parse((m as MessageEvent<string>).data) as RunEvent;
      if (ev.seq <= this.#lastSeq) return; // overlap after a reconnect
      this.#lastSeq = ev.seq;
      this.events.push(ev);
      this.#scheduleRefresh();
    });
    es.addEventListener("end", () => {
      es.close();
      this.connected = false;
      void this.refresh();
    });
  }

  #scheduleRefresh(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh();
    }, 300);
  }

  async refresh(): Promise<void> {
    try {
      this.state = await getJson<RunState>(`/api/runs/${encodeURIComponent(this.runId)}`);
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  stop(): void {
    this.#es?.close();
    if (this.#timer) clearTimeout(this.#timer);
  }
}
