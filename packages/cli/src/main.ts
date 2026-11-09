#!/usr/bin/env node
import { runCli } from "./cli.js";

const ac = new AbortController();
let interrupts = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // First Ctrl-C cancels the run cleanly (workers' process trees are killed); a second exits now.
    if (++interrupts > 1) process.exit(130);
    process.stderr.write("\ncancelling… (press Ctrl-C again to exit immediately)\n");
    ac.abort();
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  signal: ac.signal,
});
