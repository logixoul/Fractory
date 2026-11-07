import type { Price } from "../schemas/config.js";
import type { UsageTokens } from "../schemas/worker-events.js";

export interface CostResult {
  costUsd: number | null;
  warning?: string;
}

/**
 * Cost from token counts × configured price (USD per 1M tokens). Vendor-reported cost
 * fields are never used here (§8.1). Any needed price component missing → null.
 */
export function computeCost(price: Price | undefined, tokens: UsageTokens): CostResult {
  if (!price) return { costUsd: null, warning: "no price configured" };
  const parts: [number, number | undefined, string][] = [
    [tokens.input, price.input, "input"],
    [tokens.output, price.output, "output"],
    [tokens.cacheRead, price.cacheRead, "cacheRead"],
    [tokens.cacheWrite, price.cacheWrite, "cacheWrite"],
  ];
  let usd = 0;
  for (const [n, perMillion, name] of parts) {
    if (n === 0) continue;
    if (perMillion === undefined) return { costUsd: null, warning: `no ${name} price configured` };
    usd += (n * perMillion) / 1_000_000;
  }
  return { costUsd: usd };
}
