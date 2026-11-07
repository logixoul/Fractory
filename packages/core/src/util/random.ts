import { randomBytes, randomInt } from "node:crypto";

/** Deterministic PRNG (mulberry32). Used wherever a recorded seed must reproduce a choice. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle driven by a seed; same seed → same order. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function randomSeed(): number {
  return randomInt(0, 2 ** 31 - 1);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Time-sortable, filesystem-safe run id: YYYYMMDD-HHMMSS-xxxx (UTC). */
export function newRunId(now: Date = new Date()): string {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${d}-${t}-${randomHex(2)}`;
}

export const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/**
 * Assigns each worker a random 4-hex label, unique within the run (§8.16).
 * Returns label → workerId. Labels never encode the worker identity.
 */
export function newLabels(workerIds: readonly string[], hex: () => string = () => randomHex(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of workerIds) {
    let label = hex();
    for (let i = 0; label in out; i++) {
      if (i > 100) throw new Error("could not allocate a unique label");
      label = hex();
    }
    out[label] = id;
  }
  return out;
}
