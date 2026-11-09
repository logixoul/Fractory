// path:line references in rendered text → vscode://file/... links (spec: compare view).
// Same accepted forms as core's text/refs.ts (duplicated: the GUI cannot import Node code).

const SEG = String.raw`[\w@+\-.]+`;
export const REF_RE = new RegExp(String.raw`((?:[A-Za-z]:[\\/]|[\\/])?(?:${SEG}[\\/])*${SEG})(?::(\d+)(?:[-–]\d+)?|#L(\d+)(?:-L?\d+)?)`, "g");

export interface FoundRef {
  index: number;
  length: number;
  path: string;
  line: number;
}

export function findRefs(text: string): FoundRef[] {
  const out: FoundRef[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const p = m[1]!;
    if (!/[\\/]/.test(p) && !/\.\w+$/.test(p)) continue;
    if (/^\d+$/.test(p) || p.endsWith(".")) continue;
    if (/[a-z][\w+.-]*:\/?$/i.test(text.slice(Math.max(0, m.index - 16), m.index))) continue; // URL
    out.push({ index: m.index, length: m[0].length, path: p, line: Number(m[2] ?? m[3]) });
  }
  return out;
}

const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\");

/** vscode://file/<abs>:<line>; relative paths are resolved against `root` (the user's repo). */
export function vscodeHref(root: string, p: string, line: number): string {
  const abs = isAbsolute(p) ? p : `${root.replace(/[\\/]+$/, "")}/${p.replace(/^\.?[\\/]/, "")}`;
  const fwd = abs.replace(/\\/g, "/");
  return `vscode://file/${encodeURI(fwd.startsWith("/") ? fwd.slice(1) : fwd)}:${line}`;
}

/** Wraps refs in text nodes under `el` (including inside <code>) with vscode links. */
export function linkifyRefs(el: HTMLElement, root: string): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement?.closest("a") ?? null) === null) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const text = node.data;
    const refs = findRefs(text);
    if (refs.length === 0) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const r of refs) {
      frag.append(text.slice(at, r.index));
      const a = document.createElement("a");
      a.href = vscodeHref(root, r.path, r.line);
      a.className = "ref";
      a.title = "open in VS Code";
      a.textContent = text.slice(r.index, r.index + r.length);
      frag.append(a);
      at = r.index + r.length;
    }
    frag.append(text.slice(at));
    node.replaceWith(frag);
  }
}
