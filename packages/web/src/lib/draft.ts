// The new-run form's draft, kept per browser tab in sessionStorage. A run page can seed it
// ("New run from this prompt") so a failed run's prompt is one click from a fresh start.

export type Workflow = "review" | "consensus" | "duel";
export type Draft = { workflow?: Workflow; prompt?: string; repo?: string };

const DRAFT_KEY = "fractory.newRun.draft";

export function loadDraft(): Draft {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Draft;
  } catch {
    return {};
  }
}

export function saveDraft(d: Draft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable */
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
}
