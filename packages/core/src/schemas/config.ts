import { z } from "zod";

const MIN = 60_000;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const Thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const ClaudeWorkerConfig = z.object({
  kind: z.literal("claude"),
  command: z.string().min(1).default("claude"),
  model: z.string().min(1).default("opus"),
  effort: Effort.default("medium"),
});

export const PiWorkerConfig = z.object({
  kind: z.literal("pi"),
  command: z.string().min(1).default("pi"),
  provider: z.string().min(1).default("baseten"),
  model: z.string().min(1),
  thinking: Thinking.default("medium"),
  /** Env vars passed through to Pi despite secret-looking names (Pi gets no other secrets). */
  passEnv: z.array(z.string().min(1)).default(["BASETEN_API_KEY"]),
});

/** Scripted worker for tests (see workers/fake.ts). */
export const FakeWorkerConfig = z.object({
  kind: z.literal("fake"),
  script: z.string().optional(),
});

export const WorkerConfig = z.discriminatedUnion("kind", [ClaudeWorkerConfig, PiWorkerConfig, FakeWorkerConfig]);
export type WorkerConfig = z.infer<typeof WorkerConfig>;

/** USD per 1M tokens. A missing component makes cost unknown (never guessed). */
export const Price = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  source: z.string().optional(),
  checkedAt: z.string().optional(),
});
export type Price = z.infer<typeof Price>;

/** argv[0] is the executable; later elements may be empty strings (e.g. `--flag ""`). */
const Argv = z.tuple([z.string().min(1)], z.string());
const Env = z.record(z.string(), z.string());

export const SetupCommand = z.object({
  argv: Argv,
  timeoutMs: z.number().int().positive().default(15 * MIN),
  env: Env.optional(),
});

export const CheckCommand = z.object({
  name: z.string().min(1),
  argv: Argv,
  timeoutMs: z.number().int().positive().default(10 * MIN),
  env: Env.optional(),
  /** Globs (relative to the worktree) copied into steps/<id>/artifacts/ before the post-check reset. */
  artifacts: z.array(z.string()).default([]),
});

/** Unambiguous self-reference patterns (§8.16). Bare "Pi"/"Together" are deliberately absent. */
export const DEFAULT_ANONYMIZE_PATTERNS = [
  "\\bClaude\\b",
  "\\bAnthropic\\b",
  "\\bDeepSeek\\b",
  "\\bOpus\\b",
  "\\bpi-coding-agent\\b",
];

export const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".venv", "dist", "build", "target", ".next", ".turbo"];

export const Config = z
  .object({
    /** dotenv file whose values are passed to workers that need them (and always redacted). */
    envFile: z.string().optional(),
    workers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, "worker ids: lowercase, digits, dashes"), WorkerConfig),
    roles: z.object({
      contestants: z.tuple([z.string(), z.string()]),
      judge: z.string(),
    }),
    prices: z.record(z.string(), Price).default({}),
    quota: z
      .object({
        warnUtilization: z.number().min(0).max(1).default(0.8),
        abortUtilization: z.number().min(0).max(1).optional(),
      })
      .prefault({}),
    snapshot: z
      .object({
        maxIgnoredFileBytes: z.number().int().nonnegative().default(1024 * 1024),
        excludeDirs: z.array(z.string()).default(DEFAULT_EXCLUDE_DIRS),
      })
      .prefault({}),
    setup: z.array(SetupCommand).default([]),
    preserveOnClean: z.array(z.string()).default([]),
    checks: z.array(CheckCommand).default([]),
    consensus: z
      .object({
        maxRounds: z.number().int().min(0).max(10).default(1),
        minRefs: z.number().int().min(0).default(3),
      })
      .prefault({}),
    duel: z
      .object({
        maxFixIterations: z.number().int().min(0).max(10).default(2),
        /** Contestant whose session applies the approved items (spec: Opus). Default: the first contestant. */
        applyWorker: z.string().optional(),
      })
      .prefault({}),
    timeouts: z
      .object({
        workerMs: z.number().int().positive().default(30 * MIN),
        judgeMs: z.number().int().positive().default(20 * MIN),
      })
      .prefault({}),
    contextFiles: z.array(z.string()).default(["AGENTS.md", "CLAUDE.md"]),
    judge: z
      .object({
        /** Judge a second time with A/B swapped; keep only what both passes agree on. */
        swapOrderPass: z.boolean().default(true),
      })
      .prefault({}),
    retry: z
      .object({
        /** Automatic retries of a step after a transient error (5xx, network, provider 429 for Pi). */
        transientMaxRetries: z.number().int().min(0).max(5).default(2),
        /** Backoff before retry n (the last value repeats). */
        backoffMs: z.array(z.number().int().nonnegative()).min(1).default([5_000, 30_000]),
        /**
         * Backoff for a provider rate limit (429) that Pi's own retries did not absorb. A
         * Retry-After in the error text takes precedence over both lists.
         */
        rateLimitBackoffMs: z.array(z.number().int().nonnegative()).min(1).default([60_000, 120_000]),
      })
      .prefault({}),
    anonymize: z
      .object({
        patterns: z.array(z.string()).default(DEFAULT_ANONYMIZE_PATTERNS),
        replacement: z.string().default("[agent]"),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    const ids = new Set(Object.keys(c.workers));
    c.roles.contestants.forEach((id, i) => {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["roles", "contestants", i], message: `unknown worker '${id}'` });
    });
    if (c.roles.contestants[0] === c.roles.contestants[1]) {
      ctx.addIssue({ code: "custom", path: ["roles", "contestants"], message: "contestants must be two different workers" });
    }
    if (c.duel.applyWorker !== undefined && !c.roles.contestants.includes(c.duel.applyWorker)) {
      ctx.addIssue({ code: "custom", path: ["duel", "applyWorker"], message: `must be one of the contestants (${c.roles.contestants.join(", ")})` });
    }
    if (!ids.has(c.roles.judge)) ctx.addIssue({ code: "custom", path: ["roles", "judge"], message: `unknown worker '${c.roles.judge}'` });
    c.anonymize.patterns.forEach((p, i) => {
      try {
        new RegExp(p, "gi");
      } catch (e) {
        ctx.addIssue({ code: "custom", path: ["anonymize", "patterns", i], message: `invalid regex: ${(e as Error).message}` });
      }
    });
  });

export type Config = z.infer<typeof Config>;
export type ConfigInput = z.input<typeof Config>;

/** Baseten Model APIs prices, from `GET https://inference.baseten.co/v1/models` (its `pricing` field). */
const BASETEN_PRICES = "https://inference.baseten.co/v1/models (pricing field) ; https://www.baseten.co/pricing";

/** Built-in defaults; global and per-repo config files are deep-merged on top. */
export const DEFAULT_CONFIG_INPUT = {
  workers: {
    opus: { kind: "claude", model: "opus", effort: "medium" },
    // Baseten's "Fast" variant: same weights, dedicated capacity for higher throughput, 2× price.
    deepseek: { kind: "pi", provider: "baseten", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast", thinking: "medium" },
    // Judge from a third model family (not a contestant), to avoid self-preference; Flash for cost.
    // "high", explicitly: GLM-5.3 Flash on Baseten has low/high/max only (Pi would map medium to high).
    glm: { kind: "pi", provider: "baseten", model: "zai-org/GLM-5.3-Flash", thinking: "high" },
  },
  roles: { contestants: ["opus", "deepseek"], judge: "glm" },
  prices: {
    "baseten/deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast": { input: 0.6, output: 2.4, cacheRead: 0.014, source: BASETEN_PRICES, checkedAt: "2026-11-09" },
    "baseten/zai-org/GLM-5.3-Flash": { input: 0.15, output: 0.5, cacheRead: 0.03, source: BASETEN_PRICES, checkedAt: "2026-11-09" },
  },
} satisfies ConfigInput;

/**
 * Reasoning levels Pi can really send for a provider/model, with what it sends instead of an
 * unsupported one. From Pi's model catalog (thinkingLevelMap; Pi 1.5.0, checked 2026-11-09) and,
 * for Together, the M0 spike. Unlisted models are not checked; the effective level is still
 * logged per step and a mismatch is a run warning.
 */
export const PI_THINKING_LEVELS: readonly { provider: string; model: RegExp; levels: readonly string[]; otherwise: string }[] = [
  { provider: "together", model: /DeepSeek-V4(\.1)?-Flash/i, levels: ["off", "high"], otherwise: "high" },
  { provider: "baseten", model: /^zai-org\/GLM-5\.3-Flash$/i, levels: ["low", "high", "max"], otherwise: "the next supported level (medium → high)" },
  { provider: "baseten", model: /^deepseek-ai\/DeepSeek-V4\.1-Flash/i, levels: ["off", "low", "medium", "high", "max"], otherwise: "the next supported level" },
];

/** Non-fatal advice about a valid config. */
export function configWarnings(c: Config): string[] {
  const out: string[] = [];
  if (c.roles.contestants.includes(c.roles.judge)) {
    out.push(`roles.judge '${c.roles.judge}' is also a contestant; its judgments may favour its own work`);
  }
  for (const [id, w] of Object.entries(c.workers)) {
    const known = w.kind === "pi" ? PI_THINKING_LEVELS.find((k) => k.provider === w.provider && k.model.test(w.model)) : undefined;
    if (w.kind === "pi" && known && !known.levels.includes(w.thinking)) {
      out.push(`workers.${id}.thinking='${w.thinking}' is not supported by ${w.model} on ${w.provider} (${known.levels.join("/")}); Pi uses ${known.otherwise} instead`);
    }
    if (w.kind === "pi" && !c.prices[`${w.provider}/${w.model}`]) {
      out.push(`workers.${id}: no price for '${w.provider}/${w.model}'; its cost will be reported as unknown`);
    }
  }
  return out;
}
