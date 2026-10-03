import fs from 'node:fs';
import fsp from 'node:fs/promises';

export interface Line {
  /** 0-based line number */
  no: number;
  /** byte offset of the first byte of the line */
  start: number;
  /** byte length, excluding the newline */
  length: number;
  text: string;
  /** false for a trailing line without "\n" (possibly still being written) */
  complete: boolean;
}

/**
 * Stream a file line by line with exact byte offsets, so a single line can be
 * re-read later without scanning the whole file (used for images and "show full").
 */
export async function* readLines(file: string, highWaterMark = 1 << 20): AsyncGenerator<Line> {
  const stream = fs.createReadStream(file, { highWaterMark });
  let carry: Buffer[] = [];
  let carryLen = 0;
  let lineStart = 0;
  let pos = 0; // absolute offset of current chunk start
  let no = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    while (from < chunk.length) {
      const nl = chunk.indexOf(10, from);
      if (nl === -1) {
        const piece = chunk.subarray(from);
        carry.push(piece);
        carryLen += piece.length;
        break;
      }
      let buf: Buffer;
      const piece = chunk.subarray(from, nl);
      if (carryLen) {
        carry.push(piece);
        buf = Buffer.concat(carry, carryLen + piece.length);
        carry = [];
        carryLen = 0;
      } else {
        buf = piece;
      }
      let len = buf.length;
      if (len && buf[len - 1] === 13) len--; // \r\n
      yield { no: no++, start: lineStart, length: len, text: buf.toString('utf8', 0, len), complete: true };
      lineStart = pos + nl + 1;
      from = nl + 1;
    }
    pos += chunk.length;
  }
  if (carryLen) {
    const buf = Buffer.concat(carry, carryLen);
    yield { no: no++, start: lineStart, length: buf.length, text: buf.toString('utf8'), complete: false };
  }
}

export async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function tryParse(text: string): any | undefined {
  if (!text || text.charCodeAt(0) !== 123 /* { */) {
    const t = text.trim();
    if (!t.startsWith('{')) return undefined;
    text = t;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
