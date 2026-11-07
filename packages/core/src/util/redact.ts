export const REDACTED = "[REDACTED]";

/** Env var names whose values are treated as secrets. */
const SECRET_ENV_NAME = /(API_?KEY|_KEY$|^KEY$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)/i;
const MIN_SECRET_LENGTH = 8;

/** Well-known credential shapes, redacted even when not registered as a secret. */
export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/**
 * Removes secrets from strings and from arbitrarily nested JSON-like values.
 * Every event and log line passes through one of these before it is written.
 */
export class Redactor {
  #secrets: string[] = [];
  readonly #patterns: readonly RegExp[];

  constructor(secrets: Iterable<string> = [], patterns: readonly RegExp[] = DEFAULT_SECRET_PATTERNS) {
    this.#patterns = patterns;
    for (const s of secrets) this.addSecret(s);
  }

  /** Registers the values of secret-looking env vars (plus any extra values). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, extra: Iterable<string> = []): Redactor {
    const r = new Redactor(extra);
    for (const [name, value] of Object.entries(env)) {
      if (value && SECRET_ENV_NAME.test(name)) r.addSecret(value);
    }
    return r;
  }

  addSecret(secret: string): void {
    const s = secret.trim();
    if (s.length < MIN_SECRET_LENGTH || this.#secrets.includes(s)) return;
    this.#secrets.push(s);
    // Longest first so a secret that contains another is removed whole.
    this.#secrets.sort((a, b) => b.length - a.length);
  }

  get secretCount(): number {
    return this.#secrets.length;
  }

  string(input: string): string {
    let out = input;
    for (const s of this.#secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
    for (const p of this.#patterns) {
      out = out.replace(p, (_m: string, prefix: unknown) =>
        typeof prefix === "string" ? prefix + REDACTED : REDACTED,
      );
    }
    return out;
  }

  /** Deep-redacts strings inside arrays and plain objects; other values pass through. */
  value<T>(input: T): T {
    return this.#walk(input) as T;
  }

  #walk(v: unknown): unknown {
    if (typeof v === "string") return this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.#walk(x));
    if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.#walk(x);
      return out;
    }
    return v;
  }
}
