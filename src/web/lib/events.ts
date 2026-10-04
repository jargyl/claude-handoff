import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { IndexStatus, ServerEvent } from '../../shared/types';
import { qk } from './queries';
import { useToast } from './toast';

/**
 * One EventSource for the whole app. Server events invalidate the queries they
 * affect; bursts (a live session writing every second) are coalesced.
 */
export function useServerEvents(): { connected: boolean; index: IndexStatus | null } {
  const qc = useQueryClient();
  const toast = useToast();
  const [connected, setConnected] = useState(false);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const pending = useRef(new Set<string>());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const flush = () => {
      timer.current = undefined;
      const changed = [...pending.current];
      pending.current.clear();
      void qc.invalidateQueries({ queryKey: qk.sessions });
      void qc.invalidateQueries({ queryKey: qk.projects });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      for (const id of changed) {
        void qc.invalidateQueries({ queryKey: qk.session(id) });
        void qc.invalidateQueries({ queryKey: ['transcript', id] });
      }
    };
    const schedule = (ids: string[]) => {
      for (const id of ids) pending.current.add(id);
      if (timer.current === undefined) timer.current = window.setTimeout(flush, 1200);
    };

    let es: EventSource | null = null;
    let retry: number | undefined;
    const connect = () => {
      es = new EventSource('/api/events', { withCredentials: true });
      es.addEventListener('open', () => setConnected(true));
      es.addEventListener('error', () => {
        setConnected(false);
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = window.setTimeout(connect, 3000);
        }
      });
      const on = <T extends ServerEvent['type']>(type: T, fn: (e: Extract<ServerEvent, { type: T }>) => void) =>
        es!.addEventListener(type, (m) => {
          try {
            fn(JSON.parse((m as MessageEvent).data));
          } catch {
            /* malformed */
          }
        });
      on('index', (e) => {
        setIndex(e.status);
        if (e.status.state === 'idle') schedule([]);
      });
      on('sessions', (e) => schedule([...e.changed, ...e.removed]));
      on('live', () => schedule([]));
      on('inbox', () => {
        void qc.invalidateQueries({ queryKey: qk.imports });
        void qc.invalidateQueries({ queryKey: qk.me });
      });
      on('devices', () => void qc.invalidateQueries({ queryKey: qk.devices }));
      on('sync', () => void qc.invalidateQueries({ queryKey: qk.sync }));
      on('runs', () => {
        void qc.invalidateQueries({ queryKey: qk.runs });
        void qc.invalidateQueries({ queryKey: ['run-project'] });
      });
      on('toast', (e) => toast({ tone: e.tone, message: e.message }));
    };
    connect();
    return () => {
      clearTimeout(retry);
      clearTimeout(timer.current);
      es?.close();
    };
  }, [qc, toast]);

  return { connected, index };
}
