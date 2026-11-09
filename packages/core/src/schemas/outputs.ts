import { z } from "zod";

/** Structured result of a consensus revision step (spec: "structured flag, schema-validated"). */
export const ReviseResult = z
  .object({
    noChanges: z.boolean().describe("true if you keep your proposal exactly as it is"),
    proposal: z.string().describe("the complete revised proposal in markdown; empty when noChanges is true"),
    changeSummary: z.string().describe("one short paragraph: what changed and why, or why nothing changed"),
  })
  .strict();
export type ReviseResult = z.infer<typeof ReviseResult>;

const Side = z.enum(["A", "B"]);

/** Judge output for consensus (anonymized sides A/B). */
export const ConsensusVerdict = z
  .object({
    summary: z.string().min(1).describe("2-5 sentences: the overall recommended plan"),
    decisions: z
      .array(
        z
          .object({
            topic: z.string().min(1),
            decision: z.string().min(1),
            rationale: z.string().min(1),
            basedOn: z.enum(["A", "B", "both", "neither"]),
            evidence: z.array(z.string()).min(1).describe("repo-relative path:line references supporting the decision"),
          })
          .strict(),
      )
      .min(1),
    unresolved: z
      .array(
        z
          .object({
            topic: z.string().min(1),
            positionA: z.string(),
            positionB: z.string(),
            whyUnresolved: z.string().min(1),
          })
          .strict(),
      )
      .describe("explicit list of disagreements the evidence does not settle; may be empty"),
  })
  .strict();
export type ConsensusVerdict = z.infer<typeof ConsensusVerdict>;

/**
 * One duel evidence entry: a ref and the version it points into. The orchestrator checks that
 * the ref really resolves in the declared side (mismatch → one repair turn).
 */
export const DuelEvidence = z
  .object({
    ref: z.string().min(1).describe("one repo-relative path:line or path:start-end reference"),
    side: z.enum(["A", "B", "base"]).describe("the version the ref points into: A's implementation, B's implementation, or the base commit"),
  })
  .strict();
export type DuelEvidence = z.infer<typeof DuelEvidence>;

/** Judge output for the duel (M4). */
export const DuelVerdict = z
  .object({
    summary: z.string().min(1),
    items: z
      .array(
        z
          .object({
            aspect: z.string().min(1),
            betterSide: Side,
            evidence: z.array(DuelEvidence).min(1),
            recommendation: z.string().min(1),
            risk: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type DuelVerdict = z.infer<typeof DuelVerdict>;

/** JSON Schema for a zod schema (for Claude --json-schema and Pi prompt text). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * judge.swapOrderPass: second judging pass with A and B swapped. The judge re-rates the points
 * of the first pass (by index); only points whose side maps to the same contestant are kept.
 */
export const SwapCheck = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            side: z.enum(["A", "B", "both", "neither"]),
          })
          .strict(),
      )
      .describe("one entry per numbered point"),
  })
  .strict();
export type SwapCheck = z.infer<typeof SwapCheck>;

/**
 * Consensus swap pass: the judge, with A and B swapped, says per first-pass decision whether it
 * would also adopt it, and which side it is based on. Adoption decides survival; a differing
 * attribution only marks the decision `attributionUnstable` (the duel keeps attribution checks).
 */
export const ConsensusSwapCheck = z
  .object({
    verdicts: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            adopt: z.boolean().describe("true if you would make this decision part of the recommended plan yourself"),
            side: z.enum(["A", "B", "both", "neither"]).describe("which proposal the decision is based on"),
          })
          .strict(),
      )
      .describe("one entry per numbered decision"),
  })
  .strict();
export type ConsensusSwapCheck = z.infer<typeof ConsensusSwapCheck>;

// ---- review workflow -------------------------------------------------------------------

export const Severity = z.enum(["bug", "risk", "design", "nit"]);
export type Severity = z.infer<typeof Severity>;

/** Why a test-file path is unusable, or undefined. Repo-relative, inside the worktree, not in .git. */
export function testPathProblem(p: string): string | undefined {
  const s = p.replace(/\\/g, "/");
  if (s.trim() === "" || s !== s.trim()) return "empty or padded with whitespace";
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.startsWith("~")) return "must be repo-relative";
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "")) return "must not contain '..' or empty segments";
  if (parts[0]!.toLowerCase() === ".git") return "must not be inside .git";
  if (s.startsWith("-")) return "must not start with '-'";
  return undefined;
}

const ReviewFindingBase = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "id: 1-32 letters, digits, '_' or '-'").describe("short unique id, e.g. F1"),
    severity: Severity.describe("bug: wrong behaviour; risk: may break under some condition; design: structure/maintainability; nit: minor"),
    title: z.string().min(1).describe("one line"),
    explanation: z.string().min(1).describe("what is wrong, why, and what to do instead"),
    refs: z.array(z.string().min(1)).min(1).describe("repo-relative path:line or path:start-end references into the code under review"),
    confidence: z.number().min(0).max(1).describe("0-1: how sure you are this is a real problem"),
    testFile: z
      .object({
        path: z.string().min(1).describe("repo-relative path of a NEW test file"),
        content: z.string().min(1).describe("complete file content"),
      })
      .strict()
      .optional()
      .describe("optional: a test that FAILS on the current code because of this finding and passes once it is fixed"),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingBase>;

/** Reviewer output. Ids unique; test paths safe (checked here, so a violation gets the repair turn). */
export function reviewOutputSchema(maxFindings: number) {
  return z
    .object({
      summary: z.string().describe("2-4 sentences: overall assessment of the change"),
      findings: z.array(ReviewFindingBase).max(maxFindings).describe("may be empty if you find no problems"),
    })
    .strict()
    .superRefine((v, ctx) => {
      const seen = new Set<string>();
      const paths = new Set<string>();
      v.findings.forEach((f, i) => {
        if (seen.has(f.id)) ctx.addIssue({ code: "custom", path: ["findings", i, "id"], message: `duplicate finding id '${f.id}'` });
        seen.add(f.id);
        if (f.testFile) {
          const why = testPathProblem(f.testFile.path);
          if (why) ctx.addIssue({ code: "custom", path: ["findings", i, "testFile", "path"], message: `test path ${why}` });
          const key = f.testFile.path.replace(/\\/g, "/").toLowerCase();
          if (paths.has(key)) ctx.addIssue({ code: "custom", path: ["findings", i, "testFile", "path"], message: "each finding needs its own test file path" });
          paths.add(key);
        }
      });
    });
}
export type ReviewOutput = z.infer<ReturnType<typeof reviewOutputSchema>>;

/** Every listed id exactly once (the respond and rebuttal outputs). */
function eachIdOnce(ids: readonly string[], key: string) {
  return (v: Record<string, { id: string }[]>, ctx: z.RefinementCtx) => {
    const got = v[key]!.map((r) => r.id);
    const dup = got.filter((id, i) => got.indexOf(id) !== i);
    const missing = ids.filter((id) => !got.includes(id));
    if (dup.length) ctx.addIssue({ code: "custom", path: [key], message: `duplicate ids: ${[...new Set(dup)].join(", ")}` });
    if (missing.length) ctx.addIssue({ code: "custom", path: [key], message: `missing a response for: ${missing.join(", ")}` });
  };
}

const idsEnum = (ids: readonly string[]) => z.enum(ids as [string, ...string[]]);

/** Implementer's answer to the open findings (dynamic: exactly these ids). */
export function respondSchema(ids: readonly string[]) {
  return z
    .object({
      responses: z.array(
        z
          .object({
            id: idsEnum(ids),
            action: z.enum(["fixed", "rejected"]).describe("fixed: you changed the code to address it; rejected: you disagree and changed nothing for it"),
            reasoning: z.string().min(1),
            refs: z.array(z.string().min(1)).describe("repo-relative path:line refs supporting your answer (for fixed: where the fix is)"),
          })
          .strict(),
      ),
    })
    .strict()
    .superRefine(eachIdOnce(ids, "responses"));
}
export type RespondOutput = z.infer<ReturnType<typeof respondSchema>>;

/** Reviewer's rebuttal (dynamic: exactly these ids). Maintaining needs new evidence. */
export function rebuttalSchema(ids: readonly string[]) {
  return z
    .object({
      rebuttals: z.array(
        z
          .object({
            id: idsEnum(ids),
            verdict: z.enum(["withdrawn", "maintained"]).describe("withdrawn: the response settles it; maintained: the problem remains"),
            reasoning: z.string().min(1),
            refs: z.array(z.string().min(1)).describe("for maintained: at least one repo-relative path:line ref into the current code"),
          })
          .strict(),
      ),
    })
    .strict()
    .superRefine(eachIdOnce(ids, "rebuttals"))
    .superRefine((v, ctx) => {
      v.rebuttals.forEach((r, i) => {
        if (r.verdict === "maintained" && r.refs.length === 0) ctx.addIssue({ code: "custom", path: ["rebuttals", i, "refs"], message: "a maintained finding needs new evidence (at least one ref)" });
      });
    });
}
export type RebuttalOutput = z.infer<ReturnType<typeof rebuttalSchema>>;
