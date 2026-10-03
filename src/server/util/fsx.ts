import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/** rename() that rides out the brief locks Windows antivirus/indexers put on fresh files. */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e: any) {
      if (i < 10 && RETRYABLE.has(e?.code)) {
        await sleep(30 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

export function tmpName(file: string): string {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

const chains = new Map<string, Promise<void>>();

/** Atomic, serialized JSON write: concurrent writes to one file are queued, never interleaved. */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => void 0)
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = tmpName(file);
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      await renameRetry(tmp, file);
    });
  chains.set(file, next);
  void next.finally(() => {
    if (chains.get(file) === next) chains.delete(file);
  });
  return next;
}
