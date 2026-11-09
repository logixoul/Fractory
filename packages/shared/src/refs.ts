// path:line references in model prose (spec: consensus exit check, GUI links). Node-free.
// Accepted forms: `src/a.ts:42`, `src/a.ts:42-50`, `src\a.ts:42`, absolute paths
// (`C:\…\repo\src\a.ts:42`, `/home/…/a.ts:42`) and markdown `src/a.ts#L42`.

const SEG = String.raw`[\w@+\-.]+`;
const SEP = String.raw`[\\/]`;
export const REF_RE = new RegExp(
  String.raw`((?:[A-Za-z]:${SEP}|${SEP})?(?:${SEG}${SEP})*${SEG})(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)`,
  "g",
);

export interface FoundRef {
  /** As written, e.g. "src/a.ts:42-50". */
  raw: string;
  /** The path part as written. */
  path: string;
  line: number;
  endLine?: number;
  /** Position in the text. */
  index: number;
  length: number;
}

const HAS_SEP = /[\\/]/;
const HAS_EXT = /\.\w+$/;
const URL_BEFORE = /[a-z][\w+.-]*:\/?$/i;

/** All refs in a text, in order. Skips URLs, times (12:30) and tokens that do not look like files. */
export function findRefs(text: string): FoundRef[] {
  const out: FoundRef[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const p = m[1]!;
    // Must look like a file: has a separator or an extension; not a number or a sentence end.
    if (!HAS_SEP.test(p) && !HAS_EXT.test(p)) continue;
    if (/^\d+$/.test(p) || p.endsWith(".")) continue;
    // Part of a URL (scheme://host/...): the match starts right after "scheme:/".
    if (URL_BEFORE.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
    const end = m[3] ?? m[5];
    out.push({
      raw: m[0],
      path: p,
      line: Number(m[2] ?? m[4]),
      ...(end !== undefined ? { endLine: Number(end) } : {}),
      index: m.index,
      length: m[0].length,
    });
  }
  return out;
}

/**
 * A duel judge's evidence ref, resolved by the orchestrator against the code the judge saw:
 * side A's head, side B's head, or the base commit. Links, the file view and "Open in VS
 * Code" use each ref's own side and commit.
 */
export interface ResolvedRef {
  /** As written, e.g. "math.js:3-5". */
  raw: string;
  /** Repo-relative posix path. */
  path: string;
  line: number;
  endLine?: number;
  side: "A" | "B" | "base";
  /** Contestant label of the side (absent for base). */
  label?: string;
  /** Commit the ref resolved against. */
  sha: string;
  /** It also resolved somewhere else; the choice followed the preference order. */
  ambiguous: boolean;
  /**
   * Why this side: "declared" = the judge's `side` field, checked against where it resolves.
   * The rest are for runs judged before the verdict had a `side` per evidence entry: named in the
   * evidence text or the item text, the item's better side, the only match, or base.
   */
  chosenBy: "declared" | "evidence" | "item" | "better" | "only" | "base";
  /** All places it resolved. */
  resolvedIn: ("A" | "B" | "base")[];
}

const SIDE_PATTERNS = [
  /^\s*([AB])\s*[:\-–]/g, // "B: math.js:3"
  /\b(?:[Ss]ide|[Ii]mplementation|[Vv]ersion|[Bb]ranch)\s+([AB])\b/g, // "side B" (capital letter only)
  /\b([AB])['’]s\b/g, // "B's"
  /[([]([AB])[)\]]/g, // "(B)" / "[B]"
  /\b(?:in|from|of)\s+([AB])\b(?![\w'’])/g, // "in B"
];

/** The single side (A or B) a text attributes something to, or undefined if none or both. */
export function sideMentioned(text: string): "A" | "B" | undefined {
  const found = new Set<string>();
  for (const re of SIDE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.add(m[1]!.toUpperCase());
  }
  if (found.size !== 1) return undefined;
  return [...found][0] as "A" | "B";
}

/** In-app link for a resolved ref: `#ref/<label|base>/<sha>/<line>-<end>/<path>`. */
export function refHref(r: Pick<ResolvedRef, "label" | "sha" | "line" | "endLine" | "path">): string {
  return `#ref/${r.label ?? "base"}/${r.sha}/${r.line}-${r.endLine ?? r.line}/${r.path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * A duel item's evidence as markdown (report.md and the GUI): each resolved ref links to its own
 * side and commit and says where it points; evidence that resolved nowhere stays plain text.
 */
export function evidenceMarkdown(evidence: readonly string[], refs: readonly ResolvedRef[], labels: Record<string, string>): string {
  const parts = refs.map((r) => {
    const where = r.side === "base" ? "base" : `${r.side}, ${labels[r.label!] ?? r.label}`;
    return `[${r.raw}](${refHref(r)}) (${where} @ ${r.sha.slice(0, 7)}${r.ambiguous ? ", ambiguous" : ""})`;
  });
  const unresolved = evidence.filter((e) => !refs.some((r) => e.includes(r.raw)));
  return [...parts, ...unresolved.map((e) => `\`${e}\` (unresolved)`)].join(", ");
}

export interface RefLink {
  /** Contestant label, or undefined for base. */
  label?: string;
  sha: string;
  line: number;
  endLine?: number;
  path: string;
}

export function parseRefHref(href: string): RefLink | undefined {
  const m = /^#ref\/([^/]+)\/([0-9a-f]{7,64})\/(\d+)-(\d+)\/(.+)$/.exec(href);
  if (!m) return undefined;
  const line = Number(m[3]);
  const end = Number(m[4]);
  return {
    ...(m[1] !== "base" ? { label: m[1]! } : {}),
    sha: m[2]!,
    line,
    ...(end !== line ? { endLine: end } : {}),
    path: m[5]!.split("/").map(decodeURIComponent).join("/"),
  };
}
