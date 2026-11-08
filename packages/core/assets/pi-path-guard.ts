// fractory Pi path guard. Loaded into every Pi invocation with `--no-extensions -e <this file>`
// (docs/interfaces.md §2, §8.12). Pi loads TypeScript directly; this file must stay
// self-contained (node built-ins only).
//
// Config: env FRACTORY_PI_GUARD = JSON {"read": [path...], "write": [path...], "ack"?: file, "nonce"?: string}.
// Read access is granted by read ∪ write entries; write/edit only by write entries.
// Missing or invalid config blocks every tool call (fail closed). Unknown tools are blocked.
// On load, the guard writes `nonce` to `ack` so the adapter can assert it was loaded.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GuardConfig {
  read: string[];
  write: string[];
}

export type Decision = { allow: true; path: string } | { allow: false; reason: string };

const KNOWN = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const UNICODE_SPACES = /[  -   　]/g;

export function caseInsensitive(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** realpath of the longest existing prefix, with the missing tail re-appended. */
export function realpathLoose(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Mirrors Pi's own path resolution (strip "@", expand "~", normalize spaces), then realpath. */
export function canonical(input: string, cwd: string): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
  return realpathLoose(path.resolve(cwd, p));
}

export function inside(child: string, root: string, ci: boolean = caseInsensitive()): boolean {
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function globEscapes(glob: string): boolean {
  return path.isAbsolute(glob) || /^[A-Za-z]:/.test(glob) || glob.startsWith("~") || glob.split(/[\\/]/).includes("..");
}

export function parseGuardConfig(raw: string | undefined): GuardConfig | null {
  try {
    const g = JSON.parse(raw ?? "");
    const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
    if (!g || !strings(g.read) || !strings(g.write)) return null;
    return { read: g.read.map(realpathLoose), write: g.write.map(realpathLoose) };
  } catch {
    return null;
  }
}

/** Pure decision for one tool call. On allow, `path` is the canonical path to execute. */
export function decide(guard: GuardConfig | null, toolName: string, input: Record<string, unknown>, cwd: string): Decision {
  const deny = (why: string): Decision => ({ allow: false, reason: `fractory path guard: ${why}` });
  if (!guard) return deny("no guard config (fail closed)");
  if (!KNOWN.has(toolName)) return deny(`tool '${toolName}' not permitted`);
  const isWrite = WRITE_TOOLS.has(toolName);
  const raw = typeof input.path === "string" && input.path !== "" ? input.path : ".";
  const target = canonical(raw, cwd);
  const roots = isWrite ? guard.write : [...guard.read, ...guard.write];
  if (!roots.some((r) => inside(target, r))) return deny(`${isWrite ? "write" : "read"} outside allowlist: ${target}`);
  if (toolName === "grep" && typeof input.glob === "string" && globEscapes(input.glob)) {
    return deny(`glob escapes search root: ${input.glob}`);
  }
  if (toolName === "find" && typeof input.pattern === "string" && globEscapes(input.pattern)) {
    return deny(`pattern escapes search root: ${input.pattern}`);
  }
  return { allow: true, path: target };
}

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

interface PiApi {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: { cwd?: string } | undefined) => unknown): void;
}

export default function fractoryPathGuard(pi: PiApi): void {
  const raw = process.env.FRACTORY_PI_GUARD;
  const guard = parseGuardConfig(raw);
  try {
    const meta = JSON.parse(raw ?? "{}");
    if (typeof meta.ack === "string" && typeof meta.nonce === "string") fs.writeFileSync(meta.ack, meta.nonce);
  } catch {
    // no ack requested; the adapter then fails the step (it always requests one)
  }
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input ?? {};
    const d = decide(guard, event.toolName, input, ctx?.cwd ?? process.cwd());
    if (!d.allow) return { block: true, reason: d.reason };
    input.path = d.path; // execute exactly what was validated
    return undefined;
  });
}
