import { z } from "zod";

const MIN = 60_000;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const Thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const ClaudeWorkerConfig = z.object({
  kind: z.literal("claude"),
  command: z.string().min(1).default("claude"),
  model: z.string().min(1).default("opus"),
  effort: Effort.default("high"),
});

export const PiWorkerConfig = z.object({
  kind: z.literal("pi"),
  command: z.string().min(1).default("pi"),
  provider: z.string().min(1).default("together"),
  model: z.string().min(1),
  thinking: Thinking.default("high"),
  /** Env vars passed through to Pi despite secret-looking names (Pi gets no other secrets). */
  passEnv: z.array(z.string().min(1)).default(["TOGETHER_API_KEY"]),
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
        swapOrderPass: z.boolean().default(false),
      })
      .prefault({}),
    retry: z
      .object({
        /** Automatic retries of a step after a transient error (5xx, network, Together 429). */
        transientMaxRetries: z.number().int().min(0).max(5).default(2),
        /** Backoff before retry n (the last value repeats). */
        backoffMs: z.array(z.number().int().nonnegative()).min(1).default([5_000, 30_000]),
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

const TOGETHER_DS_FLASH_PRICE = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.006,
  source: "https://www.together.ai/pricing ; https://www.together.ai/models/deepseek-v4-1-flash",
  checkedAt: "2026-11-07",
};

/** Built-in defaults; global and per-repo config files are deep-merged on top. */
export const DEFAULT_CONFIG_INPUT = {
  workers: {
    opus: { kind: "claude", model: "opus", effort: "high" },
    deepseek: { kind: "pi", provider: "together", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", thinking: "high" },
    // Judge from a third model family (not a contestant), to avoid self-preference.
    glm: { kind: "pi", provider: "together", model: "zai-org/GLM-5.3", thinking: "high" },
  },
  roles: { contestants: ["opus", "deepseek"], judge: "glm" },
  prices: {
    "together/deepseek-ai/DeepSeek-V4.1-Flash-1017": TOGETHER_DS_FLASH_PRICE,
    "together/deepseek-ai/DeepSeek-V4.1-Flash": TOGETHER_DS_FLASH_PRICE,
    "together/zai-org/GLM-5.3": {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      source: "https://www.together.ai/pricing ; https://www.together.ai/models/glm-5-3",
      checkedAt: "2026-11-09",
    },
  },
} satisfies ConfigInput;

/** Non-fatal advice about a valid config. */
export function configWarnings(c: Config): string[] {
  const out: string[] = [];
  if (c.roles.contestants.includes(c.roles.judge)) {
    out.push(`roles.judge '${c.roles.judge}' is also a contestant; its judgments may favour its own work`);
  }
  for (const [id, w] of Object.entries(c.workers)) {
    if (w.kind === "pi" && /DeepSeek-V4(\.1)?-Flash/i.test(w.model) && w.thinking !== "off" && w.thinking !== "high") {
      out.push(`workers.${id}.thinking='${w.thinking}' is clamped to 'high' by Pi for ${w.model}; use 'off' or 'high'`);
    }
    if (w.kind === "pi" && !c.prices[`${w.provider}/${w.model}`]) {
      out.push(`workers.${id}: no price for '${w.provider}/${w.model}'; its cost will be reported as unknown`);
    }
  }
  return out;
}
