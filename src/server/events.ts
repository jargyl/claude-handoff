// Server-sent events: the UI subscribes once and refetches what changed.

import type { ServerEvent } from '../shared/types.js';

type Client = (e: ServerEvent) => void;

export class EventHub {
  private clients = new Set<Client>();

  subscribe(c: Client): () => void {
    this.clients.add(c);
    return () => this.clients.delete(c);
  }

  emit(e: ServerEvent): void {
    for (const c of this.clients) {
      try {
        c(e);
      } catch {
        /* a dead client is removed by its own abort handler */
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}
