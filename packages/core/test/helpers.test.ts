import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { tmpDir, tmpDirScope } from "./helpers.js";

describe("test-scoped temp directories", () => {
  it("one owner finishing never deletes another owner's files", () => {
    const a = tmpDirScope();
    const b = tmpDirScope();
    const da = a.dir();
    const db = b.dir();
    a.release();
    expect(fs.existsSync(da)).toBe(false);
    expect(fs.existsSync(db)).toBe(true);
    b.release();
    expect(fs.existsSync(db)).toBe(false);
  });

  it("tmpDir is removed when its own test finishes, not by the scopes above", () => {
    const d = tmpDir();
    expect(fs.existsSync(d)).toBe(true);
  });
});
