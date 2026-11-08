/** Env vars that would divert Claude Code from the Pro subscription login. Always removed. */
export const CLAUDE_SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * Copy of `env` without the named variables. Matching is case-insensitive because Windows
 * env names are (`Anthropic_Api_Key` would still be read by the child there).
 */
export function withoutEnv(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.has(k.toUpperCase())) out[k] = v;
  return out;
}

/** Sets variables, replacing any existing key that differs only in case (Windows semantics). */
export function withEnv(env: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const out = withoutEnv(env, Object.keys(extra));
  return Object.assign(out, extra);
}
