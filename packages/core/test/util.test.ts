import { describe, expect, it } from "vitest";
import { parseEnvFile } from "../src/util/envfile.js";
import { LineSplitter, parseJsonLine } from "../src/util/jsonl.js";
import { RUN_ID_RE, newLabels, newRunId, seededShuffle } from "../src/util/random.js";
import { REDACTED, Redactor } from "../src/util/redact.js";
import { MAX_HONORED_RETRY_AFTER_MS, retryAfterMsFromText } from "../src/util/retry-after.js";
import { stepRetryDelayMs } from "../src/engine/drive.js";

describe("Retry-After in error text", () => {
  it("parses Pi's capped-delay error, headers and prose; seconds by default", () => {
    expect(retryAfterMsFromText("Server requested 120s retry delay (max: 60s). 429 Too Many Requests")).toBe(120_000);
    expect(retryAfterMsFromText('429 {"retry-after-ms":"1500"}')).toBe(1500);
    expect(retryAfterMsFromText("Retry-After: 30")).toBe(30_000);
    expect(retryAfterMsFromText("rate limited, please try again in 2 minutes")).toBe(120_000);
    expect(retryAfterMsFromText("retry in 250ms")).toBe(250);
    expect(retryAfterMsFromText("Retry-After: 99999")).toBe(MAX_HONORED_RETRY_AFTER_MS);
    expect(retryAfterMsFromText("503 Service Unavailable")).toBeUndefined();
  });

  it("step retry delay: Retry-After, else the rate-limit list for 429, else the generic list", () => {
    const retry = { backoffMs: [5_000, 30_000], rateLimitBackoffMs: [60_000, 120_000] };
    expect(stepRetryDelayMs("deepseek: transient: 503 overloaded", 0, retry)).toBe(5_000);
    expect(stepRetryDelayMs("deepseek: transient: 503 overloaded", 5, retry)).toBe(30_000);
    expect(stepRetryDelayMs("glm: transient: 429 Too Many Requests", 0, retry)).toBe(60_000);
    expect(stepRetryDelayMs("glm: transient: rate limit exceeded", 1, retry)).toBe(120_000);
    expect(stepRetryDelayMs("glm: transient: 429; Retry-After: 7", 0, retry)).toBe(7_000);
  });
});

describe("LineSplitter", () => {
  it("handles CRLF and lines split across chunks", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(":2}\n")).toEqual(['{"b":2}']);
    expect(s.end()).toEqual([]);
  });

  it("does not split on U+2028/U+2029 inside JSON strings", () => {
    const s = new LineSplitter();
    const lines = s.push('{"t":"a b c"}\n');
    expect(lines).toHaveLength(1);
    const p = parseJsonLine(lines[0]!);
    expect(p.ok && (p.value as { t: string }).t).toBe("a b c");
  });

  it("reassembles multi-byte UTF-8 split across buffers", () => {
    const buf = Buffer.from('{"t":"é✓"}\n', "utf8");
    const s = new LineSplitter();
    const out = [...s.push(buf.subarray(0, 7)), ...s.push(buf.subarray(7, 9)), ...s.push(buf.subarray(9))];
    expect(out).toEqual(['{"t":"é✓"}']);
  });

  it("drops blank lines and flushes an unterminated tail on end()", () => {
    const s = new LineSplitter();
    expect(s.push("\n\r\n  \nx")).toEqual([]);
    expect(s.end()).toEqual(["x"]);
  });

  it("classifies non-JSON as noise", () => {
    expect(parseJsonLine("Warning: model not found").ok).toBe(false);
    expect(parseJsonLine("{broken").ok).toBe(false);
    expect(parseJsonLine('  {"ok":true}  ').ok).toBe(true);
  });
});

describe("Redactor", () => {
  it("collects secrets from secret-looking env names only", () => {
    const r = Redactor.fromEnv({
      TOGETHER_API_KEY: "tgp_supersecretvalue",
      ANTHROPIC_AUTH_TOKEN: "auth-token-123456",
      PATH: "/usr/bin:/bin",
      SHORT_TOKEN: "abc",
    });
    expect(r.secretCount).toBe(2);
    expect(r.string("key=tgp_supersecretvalue path=/usr/bin:/bin")).toBe(`key=${REDACTED} path=/usr/bin:/bin`);
  });

  it("deep-redacts nested values without touching keys or non-plain objects", () => {
    const r = new Redactor(["hunter2hunter2"]);
    const date = new Date(0);
    const out = r.value({ hunter2hunter2: ["x hunter2hunter2 y", { deep: "hunter2hunter2" }], n: 5, date });
    expect(out).toEqual({ hunter2hunter2: [`x ${REDACTED} y`, { deep: REDACTED }], n: 5, date });
  });

  it("redacts well-known credential shapes", () => {
    const r = new Redactor();
    expect(r.string("sk-ant-api03-abcdefghijk")).toBe(REDACTED);
    expect(r.string("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("removes a longer secret whole when it contains a shorter one", () => {
    const r = new Redactor(["abcdefgh", "abcdefgh-ijklmnop"]);
    expect(r.string("v=abcdefgh-ijklmnop")).toBe(`v=${REDACTED}`);
  });
});

describe("parseEnvFile", () => {
  it("parses quotes, export, comments and CRLF", () => {
    const env = parseEnvFile('# c\r\nexport A=1\r\nB="two words"\r\nC=\'x#y\'\r\nD=val # trailing\r\nbad line\r\n');
    expect(env).toEqual({ A: "1", B: "two words", C: "x#y", D: "val" });
  });
});

describe("random", () => {
  it("seededShuffle is deterministic and a permutation", () => {
    const items = ["a", "b", "c", "d", "e"];
    const one = seededShuffle(items, 1234);
    expect(seededShuffle(items, 1234)).toEqual(one);
    expect([...one].sort()).toEqual(items);
    const orders = new Set(Array.from({ length: 20 }, (_, s) => seededShuffle(items, s).join("")));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("newLabels gives unique labels even when the generator collides", () => {
    const seq = ["aaaa", "aaaa", "aaaa", "bbbb"];
    const labels = newLabels(["opus", "deepseek"], () => seq.shift()!);
    expect(labels).toEqual({ aaaa: "opus", bbbb: "deepseek" });
    expect(Object.keys(newLabels(["x", "y"])).every((l) => /^[0-9a-f]{4}$/.test(l))).toBe(true);
  });

  it("run ids are sortable and filesystem-safe", () => {
    const id = newRunId(new Date(Date.UTC(2026, 10, 7, 9, 5, 3)));
    expect(id).toMatch(RUN_ID_RE);
    expect(id.startsWith("20261107-090503-")).toBe(true);
  });
});
