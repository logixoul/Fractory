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
