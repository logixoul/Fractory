import type { RefHit } from "./refs.js";
import { vscodeTarget, type RefContext, type ViewRequest } from "./refctx.js";

export type { RefContext, ViewRequest } from "./refctx.js";

/** The in-app file viewer (one at a time, opened from any rendered document). */
class Viewer {
  current = $state<ViewRequest | null>(null);

  open(ctx: RefContext, hit: RefHit): void {
    if (!hit.path) return;
    this.current = { ...hit, path: hit.path, ctx, vscode: vscodeTarget(ctx, hit.path, hit.line) };
  }

  close(): void {
    this.current = null;
  }
}

export const viewer = new Viewer();
