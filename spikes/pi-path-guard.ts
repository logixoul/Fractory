// fractory Pi path guard (spike). Fail-closed allowlist for Pi's built-in file tools.
// Config: env FRACTORY_PI_GUARD = JSON {"read": [dirOrFile...], "write": [dirOrFile...]}.
// Read access is granted by read ∪ write entries; write/edit only by write entries.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Guard = { read: string[]; write: string[] };
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const KNOWN = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function realpathLoose(p: string): string {
  // realpath of the longest existing prefix, then re-append the missing tail.
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

function canonical(input: string, cwd: string): string {
  let p = input.replace(/[  -​  　]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
  return realpathLoose(path.resolve(cwd, p));
}

function inside(child: string, root: string): boolean {
  const norm = (s: string) => (CASE_INSENSITIVE ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function loadGuard(): Guard | null {
  try {
    const g = JSON.parse(process.env.FRACTORY_PI_GUARD ?? "");
    if (!Array.isArray(g.read) || !Array.isArray(g.write)) return null;
    return { read: g.read.map((p: string) => realpathLoose(p)), write: g.write.map((p: string) => realpathLoose(p)) };
  } catch {
    return null;
  }
}

function globEscapes(glob: string): boolean {
  return path.isAbsolute(glob) || /^[A-Za-z]:/.test(glob) || glob.startsWith("~") || glob.split(/[\\/]/).includes("..");
}

export default function (pi: any) {
  const guard = loadGuard();
  pi.on("tool_call", async (event: any, ctx: any) => {
    const deny = (why: string) => ({ block: true, reason: `fractory path guard: ${why}` });
    if (!guard) return deny("no guard config (fail closed)");
    if (!KNOWN.has(event.toolName)) return deny(`tool '${event.toolName}' not permitted`);
    const cwd: string = ctx?.cwd ?? process.cwd();
    const input = event.input ?? {};
    const isWrite = event.toolName === "write" || event.toolName === "edit";
    const raw: string = typeof input.path === "string" && input.path !== "" ? input.path : ".";
    const target = canonical(raw, cwd);
    const roots = isWrite ? guard.write : [...guard.read, ...guard.write];
    if (!roots.some((r) => inside(target, r))) return deny(`${isWrite ? "write" : "read"} outside allowlist: ${target}`);
    if (event.toolName === "grep" && typeof input.glob === "string" && globEscapes(input.glob)) return deny(`glob escapes search root: ${input.glob}`);
    if (event.toolName === "find" && typeof input.pattern === "string" && globEscapes(input.pattern)) return deny(`pattern escapes search root: ${input.pattern}`);
    input.path = target; // execute exactly what was validated
    return undefined;
  });
}
