import { z } from "zod";

const MIN = 60_000;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const Thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Model family (vendor lineage), e.g. "anthropic", "openai", "deepseek". The review workflow
 * requires implementer and reviewer from different families. Inferred when omitted (familyOf).
 */
const Family = z.string().regex(/^[a-z][a-z0-9-]*$/, "family: lowercase, digits, dashes").optional();

export const ClaudeWorkerConfig = z.object({
  kind: z.literal("claude"),
  family: Family,
  command: z.string().min(1).default("claude"),
  model: z.string().min(1).default("opus"),
  effort: Effort.default("medium"),
});

export const PiWorkerConfig = z.object({
  kind: z.literal("pi"),
  family: Family,
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
  family: Family,
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

/** Placeholder in review.testCommand.argv, replaced by the test file's repo-relative path. */
export const TEST_FILE_PLACEHOLDER = "{testFile}";

export const TestCommand = z.object({
  /** e.g. ["npx", "vitest", "run", "{testFile}"]. Without a placeholder the path is appended. */
  argv: Argv,
  timeoutMs: z.number().int().positive().default(10 * MIN),
  env: Env.optional(),
  /** Exit codes that mean "the test ran and failed" (confirmed). Any other non-zero result is `error`. */
  failExitCodes: z.array(z.number().int()).min(1).default([1]),
  /**
   * The command's output must mention the test file's name, else the result is `error` (the
   * runner probably did not run it: a wrong pattern, a collection or import error, ...).
   */
  requireFileInOutput: z.boolean().default(true),
});
export type TestCommand = z.infer<typeof TestCommand>;

export const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".venv", "dist", "build", "target", ".next", ".turbo"];

export const Config = z
  .object({
    /** dotenv file whose values are passed to workers that need them (and always redacted). */
    envFile: z.string().optional(),
    workers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, "worker ids: lowercase, digits, dashes"), WorkerConfig),
    roles: z.object({
      contestants: z.tuple([z.string(), z.string()]),
      judge: z.string(),
      /** review workflow: writes the code. */
      implementer: z.string().default("opus"),
      /** review workflow: reviews it; must be from a different model family than the implementer. */
      reviewer: z.string().default("gpt"),
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
    review: z
      .object({
        /** Rebuttal rounds (respond → rebuttal) before the remaining disagreements go to the user. */
        maxRounds: z.number().int().min(1).max(5).default(1),
        maxFixIterations: z.number().int().min(0).max(10).default(2),
        /** Runs one reviewer-written test file (confirmation). Unset: every test is recorded as `error`. */
        testCommand: TestCommand.optional(),
        /** Upper bound on findings per review (schema-enforced; more → repair turn). */
        maxFindings: z.number().int().min(1).max(100).default(30),
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
    for (const role of ["implementer", "reviewer"] as const) {
      if (!ids.has(c.roles[role])) ctx.addIssue({ code: "custom", path: ["roles", role], message: `unknown worker '${c.roles[role]}'` });
    }
    if (ids.has(c.roles.implementer) && ids.has(c.roles.reviewer)) {
      const fi = familyOf(c.roles.implementer, c.workers[c.roles.implementer]!);
      const fr = familyOf(c.roles.reviewer, c.workers[c.roles.reviewer]!);
      for (const [role, f] of [["implementer", fi], ["reviewer", fr]] as const) {
        if (f === undefined) {
          ctx.addIssue({ code: "custom", path: ["roles", role], message: `cannot infer the model family of worker '${c.roles[role]}'; set workers.${c.roles[role]}.family` });
        }
      }
      if (fi !== undefined && fi === fr) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", "reviewer"],
          message: `reviewer '${c.roles.reviewer}' must be from a different model family than implementer '${c.roles.implementer}' (both ${fi})`,
        });
      }
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

/** Pi providers that serve only their own vendor's models. */
const FIRST_PARTY_PROVIDERS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  google: "google",
  deepseek: "deepseek",
  xai: "xai",
  mistral: "mistral",
  zai: "zhipu",
  moonshotai: "moonshot",
  minimax: "minimax",
};

/** Model-id patterns for multi-vendor providers (Baseten, Together, OpenRouter, ...). First match wins. */
const MODEL_FAMILIES: readonly [RegExp, string][] = [
  [/claude|anthropic/i, "anthropic"],
  [/\bgpt-|openai|(^|\/)o\d/i, "openai"],
  [/deepseek/i, "deepseek"],
  [/glm|zai-org|zhipu/i, "zhipu"],
  [/qwen/i, "alibaba"],
  [/kimi|moonshot/i, "moonshot"],
  [/gemini|gemma/i, "google"],
  [/grok/i, "xai"],
  [/llama|meta-/i, "meta"],
  [/mistral|mixtral|codestral|devstral/i, "mistral"],
  [/minimax/i, "minimax"],
];

/**
 * A worker's model family: the explicit `family`, else inferred (Claude → anthropic; Pi from a
 * first-party provider or the model id; a fake worker is its own family). Undefined if unknown.
 */
export function familyOf(id: string, w: WorkerConfig): string | undefined {
  if (w.family) return w.family;
  if (w.kind === "claude") return "anthropic";
  if (w.kind === "fake") return `fake-${id}`;
  return FIRST_PARTY_PROVIDERS[w.provider] ?? MODEL_FAMILIES.find(([re]) => re.test(w.model))?.[1];
}
export type ConfigInput = z.input<typeof Config>;

/** Baseten Model APIs prices, from `GET https://inference.baseten.co/v1/models` (its `pricing` field). */
const BASETEN_PRICES = "https://inference.baseten.co/v1/models (pricing field) ; https://www.baseten.co/pricing";
/** Not checked on openai.com: Pi 1.5.0's catalog and third-party trackers agree (docs/interfaces.md §2a). */
const OPENAI_PRICES =
  "Pi 1.5.0 catalog (pi-ai providers/data/openai.json); pricepertoken.com, getdeploying.com. Unverified: developers.openai.com/api/docs/pricing";

/** Built-in defaults; global and per-repo config files are deep-merged on top. */
export const DEFAULT_CONFIG_INPUT = {
  workers: {
    opus: { kind: "claude", model: "opus", effort: "medium" },
    // Baseten's "Fast" variant: same weights, dedicated capacity for higher throughput, 2× price.
    deepseek: { kind: "pi", provider: "baseten", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast", thinking: "medium" },
    // Judge from a third model family (not a contestant), to avoid self-preference; Flash for cost.
    // "high", explicitly: GLM-5.3 Flash on Baseten has low/high/max only (Pi would map medium to high).
    glm: { kind: "pi", provider: "baseten", model: "zai-org/GLM-5.3-Flash", thinking: "high" },
    // Review workflow reviewer, a different family than the implementer (opus): OpenAI API via Pi.
    gpt: { kind: "pi", provider: "openai", model: "gpt-6.1-sol", thinking: "medium", passEnv: ["OPENAI_API_KEY"] },
  },
  roles: { contestants: ["opus", "deepseek"], judge: "glm", implementer: "opus", reviewer: "gpt" },
  prices: {
    "baseten/deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast": { input: 0.6, output: 2.4, cacheRead: 0.014, source: BASETEN_PRICES, checkedAt: "2026-11-09" },
    "baseten/zai-org/GLM-5.3-Flash": { input: 0.15, output: 0.5, cacheRead: 0.03, source: BASETEN_PRICES, checkedAt: "2026-11-09" },
    // Prompts up to 272k tokens (the model's context window in Pi's catalog). No cacheWrite: OpenAI caching is automatic.
    "openai/gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, source: OPENAI_PRICES, checkedAt: "2026-11-09" },
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
  { provider: "openai", model: /^gpt-6\.1-(sol|terra)$/i, levels: ["low", "medium", "high", "xhigh", "max"], otherwise: "no reasoning setting (off/minimal are unmapped)" },
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
