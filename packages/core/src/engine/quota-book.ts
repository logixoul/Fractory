import * as fs from "node:fs";
import * as path from "node:path";
import { readJsonIfExists, writeFileAtomicSync } from "../util/fsx.js";

export interface QuotaBookEntry {
  status: string;
  resetsAt?: number;
  windows: Record<string, { utilization: number; resetsAt?: number }>;
  observedAt: number;
}

export type QuotaBook = Record<string, QuotaBookEntry>;

/** Last-known quota per worker, persisted across runs for the pre-flight check (§8.11). */
export function readQuotaBook(file: string): QuotaBook {
  try {
    return readJsonIfExists<QuotaBook>(file) ?? {};
  } catch {
    return {};
  }
}

export function updateQuotaBook(file: string, workerId: string, entry: QuotaBookEntry): void {
  const book = readQuotaBook(file);
  book[workerId] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, JSON.stringify(book, null, 2) + "\n");
}

export interface QuotaWarning {
  window: string;
  utilization: number;
  resetsAt?: number;
}

/** Windows at or above `threshold` whose reset time has not passed (unknown reset counts). */
export function windowsOverThreshold(
  windows: QuotaBookEntry["windows"],
  threshold: number,
  now: number,
): QuotaWarning[] {
  const out: QuotaWarning[] = [];
  for (const [window, w] of Object.entries(windows)) {
    if (w.utilization < threshold) continue;
    if (w.resetsAt !== undefined && w.resetsAt <= now) continue;
    out.push({ window, utilization: w.utilization, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) });
  }
  return out;
}
