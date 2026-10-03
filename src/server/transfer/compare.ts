// Sessions are append-only logs, so two copies of the same session relate in one
// of a few ways. We compare the sequence of message uuids — not raw bytes — so a
// copy whose paths were rewritten on import still counts as the same session.

import type { SyncStatus } from '../../shared/types.js';
import { hashIds } from '../claude/parse.js';

export interface Identity {
  idSeq: string[];
  idHash: string;
}

export function compareIdentity(local: Identity, other: Identity): Exclude<SyncStatus, 'new' | 'missing'> {
  const a = local.idSeq.length;
  const b = other.idSeq.length;
  if (a === b && local.idHash === other.idHash) return 'same';
  if (b > a && hashIds(other.idSeq, a) === local.idHash) return 'incoming-ahead';
  if (a > b && hashIds(local.idSeq, b) === other.idHash) return 'local-ahead';
  return 'diverged';
}

/**
 * Same comparison when we only hold the other side's (count, hash) and can ask it
 * for a prefix hash (LAN peers) — or don't need to (when it's behind us).
 */
export async function compareRemote(
  local: Identity,
  remote: { idCount: number; idHash: string },
  remotePrefix: (n: number) => Promise<string | null>,
): Promise<Exclude<SyncStatus, 'new' | 'missing'>> {
  const a = local.idSeq.length;
  const b = remote.idCount;
  if (a === b && local.idHash === remote.idHash) return 'same';
  if (a > b) return hashIds(local.idSeq, b) === remote.idHash ? 'local-ahead' : 'diverged';
  if (b > a) {
    const p = await remotePrefix(a);
    return p === local.idHash ? 'incoming-ahead' : 'diverged';
  }
  return 'diverged';
}
