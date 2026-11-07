import type { StepFailureKind } from "../schemas/run-events.js";

/** Thrown by a step when a worker hit its usage limit. Pauses the run; never retried automatically. */
export class QuotaExhaustedError extends Error {
  override name = "QuotaExhaustedError";
  constructor(
    readonly workerId: string,
    readonly resetsAt?: number,
  ) {
    super(
      `quota exhausted for ${workerId}` + (resetsAt !== undefined ? ` until ${new Date(resetsAt).toISOString()}` : ""),
    );
  }
}

/** A deterministic step failure with a classified kind. */
export class StepFailure extends Error {
  override name = "StepFailure";
  constructor(
    readonly kind: StepFailureKind,
    message: string,
  ) {
    super(message);
  }
}

export class AbortedError extends Error {
  override name = "AbortedError";
}

/** Resume preconditions not met (quota not reset, approval missing, ...). */
export class ResumeRefusedError extends Error {
  override name = "ResumeRefusedError";
}
