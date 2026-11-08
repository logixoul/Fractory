import * as path from "node:path";

/** Default filesystems on Windows and macOS are case-insensitive. */
export function caseInsensitiveFs(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export const normCase = (p: string): string => (caseInsensitiveFs() ? p.toLowerCase() : p);

/** child === root or below it. */
export function isInside(child: string, root: string): boolean {
  const rel = path.relative(normCase(root), normCase(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** child strictly below root. */
export function isStrictlyInside(child: string, root: string): boolean {
  const rel = path.relative(normCase(root), normCase(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Forward-slash repo-relative form. */
export const toPosix = (p: string): string => p.split(path.sep).join("/");
