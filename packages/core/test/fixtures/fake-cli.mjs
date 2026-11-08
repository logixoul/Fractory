// Stand-in for `claude` / `pi` in adapter tests (no model is ever called).
// Env:
//   FAKE_CLI_RECORD   file to write {argv, env, stdin, cwd} to
//   FAKE_CLI_FIXTURE  JSONL file to print to stdout (line by line)
//   FAKE_CLI_STDERR   text to print on stderr first
//   FAKE_CLI_ACK=1    emulate the Pi path guard's load acknowledgement
//   FAKE_CLI_OUTFILE  write this JSON text to the guard's write allowlist entry ending in result.json
//   FAKE_CLI_HANG=1   after printing, spawn a grandchild and hang (tree-kill test)
//   FAKE_CLI_EXIT     exit code (default 0)
import { spawn } from "node:child_process";
import fs from "node:fs";

const env = process.env;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", main);

function main() {
  if (env.FAKE_CLI_RECORD) {
    fs.writeFileSync(env.FAKE_CLI_RECORD, JSON.stringify({ argv: process.argv.slice(2), env, stdin, cwd: process.cwd() }));
  }
  if (env.FAKE_CLI_ACK === "1") {
    const g = JSON.parse(env.FRACTORY_PI_GUARD);
    fs.writeFileSync(g.ack, g.nonce);
  }
  if (env.FAKE_CLI_OUTFILE) {
    const g = JSON.parse(env.FRACTORY_PI_GUARD);
    const out = g.write.find((p) => p.endsWith("result.json"));
    fs.writeFileSync(out, env.FAKE_CLI_OUTFILE);
  }
  if (env.FAKE_CLI_STDERR) process.stderr.write(env.FAKE_CLI_STDERR + "\n");
  if (env.FAKE_CLI_FIXTURE) process.stdout.write(fs.readFileSync(env.FAKE_CLI_FIXTURE, "utf8"));
  if (env.FAKE_CLI_HANG === "1") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (env.FAKE_CLI_PIDFILE) fs.writeFileSync(env.FAKE_CLI_PIDFILE, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = Number(env.FAKE_CLI_EXIT ?? 0);
}
