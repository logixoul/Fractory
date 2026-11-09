/** Decision markers in a consensus plan: `<!-- d:<id> -->` (invisible in rendered markdown). */
const MARKER = /<!--\s*d:([A-Za-z0-9_.-]+)\s*-->/g;

/** Marker ids in document order (with repeats). Markers inside fenced code blocks are ignored. */
export function planMarkerIds(md: string): string[] {
  return planSections(md).flatMap((s) => s.ids);
}

export interface PlanSection {
  /** Heading line included; empty for text before the first heading. */
  text: string;
  /** Decision ids marked in this section, de-duplicated. */
  ids: string[];
}

/** Splits a plan at markdown headings (outside fenced code) and collects each section's markers. */
export function planSections(md: string): PlanSection[] {
  const sections: { lines: string[] }[] = [{ lines: [] }];
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) fence = fence === null ? f[1]![0]! : fence === f[1]![0] ? null : fence;
    else if (fence === null && /^#{1,6}\s/.test(line)) sections.push({ lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  return sections
    .map((s) => s.lines.join("\n"))
    .filter((text) => text.trim() !== "")
    .map((text) => {
      const ids: string[] = [];
      let fenced: string | null = null;
      for (const line of text.split("\n")) {
        const f = /^\s*(```+|~~~+)/.exec(line);
        if (f) fenced = fenced === null ? f[1]![0]! : fenced === f[1]![0] ? null : fenced;
        else if (fenced === null) for (const m of line.matchAll(MARKER)) if (!ids.includes(m[1]!)) ids.push(m[1]!);
      }
      return { text, ids };
    });
}
