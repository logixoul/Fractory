// path:line refs in rendered text → in-app file view at the commit the ref was made against.
// The extractor is shared with core (@fractory/shared/refs); this module only maps paths and
// builds the links.
import { findRefs } from "@fractory/shared/refs";

export interface RefHit {
  /** Repo-relative posix path, or null if it points outside the known roots. */
  path: string | null;
  /** As written. */
  written: string;
  line: number;
  endLine?: number;
  raw: string;
}

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");
const fwd = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Repo-relative form of a written path; absolute paths must lie under one of `roots`. */
export function toRepoRelative(written: string, roots: readonly string[]): string | null {
  const p = fwd(written);
  if (!isAbsolute(written)) {
    const parts = p.replace(/^\.\//, "").split("/");
    return parts.includes("..") ? null : parts.join("/");
  }
  for (const r of [...roots].map(fwd).sort((a, b) => b.length - a.length)) {
    // Windows/macOS paths: compare case-insensitively (the daemon validates the final path anyway).
    if (p.toLowerCase().startsWith(r.toLowerCase() + "/")) return p.slice(r.length + 1);
  }
  return null;
}

/** vscode://file/<abs>:<line>, from a root directory and a repo-relative path. */
export function vscodeHref(root: string, rel: string, line: number): string {
  const abs = `${fwd(root)}/${rel}`;
  return `vscode://file/${encodeURI(abs.startsWith("/") ? abs.slice(1) : abs)}:${line}`;
}

/** Wraps refs in text nodes under `el` (including inside <code>) with in-app links. */
export function linkifyRefs(el: HTMLElement, roots: readonly string[], onOpen: (hit: RefHit) => void): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement?.closest("a, button") ?? null) === null) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const text = node.data;
    const refs = findRefs(text);
    if (refs.length === 0) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const r of refs) {
      frag.append(text.slice(at, r.index));
      const hit: RefHit = { path: toRepoRelative(r.path, roots), written: r.path, line: r.line, raw: r.raw, ...(r.endLine !== undefined ? { endLine: r.endLine } : {}) };
      const a = document.createElement("a");
      a.href = "#";
      a.className = hit.path ? "ref" : "ref unresolved";
      a.title = hit.path ? `view ${hit.path}:${hit.line}` : "path outside the repository";
      a.textContent = r.raw;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (hit.path) onOpen(hit);
      });
      frag.append(a);
      at = r.index + r.length;
    }
    frag.append(text.slice(at));
    node.replaceWith(frag);
  }
}
