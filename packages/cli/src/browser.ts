import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

/**
 * Opens a URL in the default browser without a shell (argv only): the URL contains the token
 * and `&`, which a shell (`cmd /c start`) would interpret.
 */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

/** packages/web/dist next to this package (built in M6); undefined if absent. */
export function defaultWebDir(): string | undefined {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return fs.existsSync(dir) ? dir : undefined;
}
