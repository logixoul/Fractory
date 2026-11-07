import * as fs from "node:fs";
import { randomHex } from "./random.js";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes the whole buffer, looping over partial writes. */
export function writeAllSync(fd: number, data: string | Buffer): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * tmp file + fsync + rename. On Windows a rename onto a file another process has open
 * (indexer, antivirus, a reader) can fail transiently with EPERM/EBUSY, so retry briefly.
 */
export function writeFileAtomicSync(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    writeAllSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt < 10 && RETRYABLE.has(code)) {
        sleepSync(15 * (attempt + 1));
        continue;
      }
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
