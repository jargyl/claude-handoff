// "Claude is waiting for you": a toast from the tray icon when a session that was
// working goes back to waiting for input.

import type { SessionIndex } from './claude/sessionIndex.js';
import type { SettingsStore } from './config.js';

/** Replies shorter than this don't notify: you were probably still watching. */
export const MIN_WORK_MS = 15_000;

/** Sessions that just went from working to waiting after working long enough. `since` (when each was first seen working) is updated in place. */
export function finishedWork(since: Map<string, number>, statuses: Map<string, string>, now: number): string[] {
  const done: string[] = [];
  for (const [id, status] of statuses) {
    if (status !== 'idle') {
      if (!since.has(id)) since.set(id, now);
      continue;
    }
    const start = since.get(id);
    since.delete(id);
    if (start !== undefined && now - start >= MIN_WORK_MS) done.push(id);
  }
  for (const id of since.keys()) if (!statuses.has(id)) since.delete(id); // closed
  return done;
}

export function watchWaiting(index: SessionIndex, settings: SettingsStore, url: string, show: (title: string, body: string, url: string) => void): () => void {
  const since = new Map<string, number>();
  const onLive = () => {
    const statuses = new Map([...index.live].map(([id, e]) => [id, e.status]));
    const done = finishedWork(since, statuses, Date.now());
    if (!settings.get().notifyWhenWaiting) return;
    for (const id of done) {
      const s = index.get(id);
      const item = s ? index.listItem(s) : null;
      const where = item?.projectName ?? index.live.get(id)?.name ?? 'Claude Code';
      show(`Claude is waiting · ${where}`, item?.title || 'Your turn.', `${url}/sessions/${id}`);
    }
  };
  index.on('live', onLive);
  return () => index.off('live', onLive);
}
