import { StringDecoder } from "node:string_decoder";

/**
 * Splits a byte or text stream into lines on "\n" only, stripping one trailing "\r".
 * Deliberately not `readline`: that also splits on U+2028/U+2029, which can occur raw
 * inside JSON strings. Multi-byte UTF-8 sequences split across chunks are handled.
 * Blank lines are dropped.
 */
export class LineSplitter {
  #buf = "";
  readonly #decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): string[] {
    this.#buf += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const out: string[] = [];
    let start = 0;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n", start)) !== -1) {
      pushLine(out, this.#buf.slice(start, nl));
      start = nl + 1;
    }
    this.#buf = this.#buf.slice(start);
    return out;
  }

  /** Flushes the final unterminated line, if any. */
  end(): string[] {
    this.#buf += this.#decoder.end();
    const out: string[] = [];
    pushLine(out, this.#buf);
    this.#buf = "";
    return out;
  }
}

function pushLine(out: string[], line: string): void {
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (l.trim() !== "") out.push(l);
}

export type JsonLine = { ok: true; value: unknown; raw: string } | { ok: false; raw: string };

/** Parses one line as JSON; anything that is not a JSON object/array is reported as noise. */
export function parseJsonLine(raw: string): JsonLine {
  const t = raw.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false, raw };
  try {
    return { ok: true, value: JSON.parse(t), raw };
  } catch {
    return { ok: false, raw };
  }
}
