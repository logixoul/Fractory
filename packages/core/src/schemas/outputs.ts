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
