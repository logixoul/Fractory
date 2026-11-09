import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { jsonSchemaOf } from "../schemas/outputs.js";
import type { DoneEvent } from "../schemas/worker-events.js";
import { StepFailure } from "./errors.js";
import type { StepContext, WorkerRunOptions } from "./types.js";

/**
 * Structured output with exactly one repair attempt (§8.5).
 *  - Claude: `--json-schema`, value from result.structured_output.
 *  - Pi (and any other kind): the prompt designates steps/<id>/out/<name>.json, which the
 *    path guard lets Pi write; the adapter parses it into done.structured.
 * Both are validated by the same zod schema. On failure the same session is resumed once
 * with the validation error; a second failure fails the step (exit_check).
 */
export interface StructuredOptions<T extends z.ZodType> {
  workerId: string;
  schema: T;
  /** File name stem for the out file, e.g. "revise" → out/revise.json. */
  name: string;
  task: Omit<WorkerRunOptions, "outFile" | "jsonSchema">;
}

export interface StructuredResult<T> {
  value: T;
  done: DoneEvent;
  repaired: boolean;
}

export function outputInstructions(kind: string, outFile: string, schema: Record<string, unknown>): string {
  if (kind === "claude") {
    return "\n\nReturn your final answer as the structured output (it is validated against a JSON Schema).";
  }
  return [
    "",
    "",
    `Write your final answer as a single JSON document to this file, using the write tool: ${outFile}`,
    "The file must contain only JSON (no markdown fences) and must validate against this JSON Schema:",
    "",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

export async function runStructured<T extends z.ZodType>(ctx: StepContext, o: StructuredOptions<T>): Promise<StructuredResult<z.infer<T>>> {
  const kind = ctx.config.workers[o.workerId]?.kind ?? "unknown";
  const schema = jsonSchemaOf(o.schema);
  const outFile = path.join(ctx.stepDir, "out", `${o.name}.json`);
  const io = kind === "claude" ? { jsonSchema: schema } : { outFile };
  const instructions = outputInstructions(kind, outFile, schema);

  const attempt = async (prompt: string, sessionId?: string) => {
    fs.rmSync(outFile, { force: true });
    return ctx.runWorker(o.workerId, {
      ...o.task,
      ...io,
      prompt,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  };
  const check = (done: DoneEvent) => {
    if (done.structured === undefined) {
      return { ok: false as const, error: kind === "claude" ? "no structured output was returned" : `the file ${outFile} is missing or is not valid JSON` };
    }
    const r = o.schema.safeParse(done.structured);
    return r.success ? { ok: true as const, value: r.data } : { ok: false as const, error: z.prettifyError(r.error) };
  };

  const first = await attempt(o.task.prompt + instructions, o.task.sessionId);
  const c1 = check(first);
  if (c1.ok) return { value: c1.value, done: first, repaired: false };

  const repairPrompt = `Your previous output was rejected by the orchestrator's validator:\n\n${c1.error}\n\nProduce the corrected, complete answer now.${instructions}`;
  const second = await attempt(repairPrompt, first.sessionId);
  const c2 = check(second);
  if (c2.ok) return { value: c2.value, done: second, repaired: true };
  throw new StepFailure("exit_check", `structured output '${o.name}' invalid after one repair attempt: ${c2.error}`);
}
