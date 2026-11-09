// Retry hints in a worker's final error text (only ever applied to an error result, never to
// model output). Pi's own retries see the HTTP headers; the orchestrator only sees the message.

/** A provider rate limit: HTTP 429 / "rate limit" / "too many requests". */
export const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;

/** Longest server-requested delay the step retry honors; anything longer is capped to this. */
export const MAX_HONORED_RETRY_AFTER_MS = 15 * 60_000;

function unitMs(unit: string | undefined): number {
  const u = (unit || "s").toLowerCase();
  if (u === "ms") return 1;
  if (u.startsWith("m")) return 60_000; // m, min, minute(s)
  return 1000; // s, sec, second(s)
}

const PATTERNS: RegExp[] = [
  // Pi provider level, when the requested delay exceeded its cap: "Server requested 120s retry delay (max: 60s)".
  /server requested (\d+(?:\.\d+)?)\s*(ms|s)\b retry delay/i,
  // "retry-after-ms: 1500", "Retry-After: 30", "retry_after=30", "retry after 30 seconds"
  /retry[-_ ]after[-_ ]ms["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)()/i,
  /retry[-_ ]after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)?\b/i,
  // "try again in 20s", "retry in 2 minutes", "please retry in 1.5 seconds"
  /(?:try again|retry) in (\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i,
];

/** The server-requested delay in ms, if the message carries one (capped at MAX_HONORED_RETRY_AFTER_MS). */
export function retryAfterMsFromText(message: string): number | undefined {
  for (const [i, re] of PATTERNS.entries()) {
    const m = re.exec(message);
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    // retry-after-ms carries milliseconds; a bare Retry-After value is seconds (RFC 9110).
    const ms = value * (i === 1 ? 1 : unitMs(m[2]));
    return Math.min(Math.round(ms), MAX_HONORED_RETRY_AFTER_MS);
  }
  return undefined;
}
