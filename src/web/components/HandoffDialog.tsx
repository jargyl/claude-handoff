// "Hand off": send selected sessions to another machine — as a file, straight to
// a paired device, or into the sync folder.

import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, MonitorSmartphone, Send } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { qk, useDevices, useSync } from '../lib/queries';
import { plural, relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { Dialog } from './Dialog';
import { Button, Spinner, cx } from './ui';

export function HandoffDialog({ ids, open, onClose, onDone }: { ids: string[]; open: boolean; onClose: () => void; onDone?: () => void }) {
  const devices = useDevices();
  const sync = useSync();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const n = ids.length;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      onDone?.();
      onClose();
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const Row = ({ id, icon: Icon, title, desc, action, disabled }: { id: string; icon: typeof Send; title: string; desc: React.ReactNode; action: () => void; disabled?: boolean }) => (
    <li>
      <button
        disabled={disabled || !!busy}
        onClick={action}
        className={cx('flex w-full items-center gap-3 rounded-[8px] border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50')}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[7px] border border-line bg-surface text-ink-2">
          {busy === id ? <Spinner /> : <Icon className="size-4" aria-hidden />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">{title}</span>
          <span className="block text-sm text-ink-3">{desc}</span>
        </span>
      </button>
    </li>
  );

  const paired = devices.data?.devices ?? [];

  return (
    <Dialog open={open} onClose={onClose} title={`Hand off ${plural(n, 'session')}`} description="Pick how to get them to your other machine. You'll review where they go over there.">
      <ul className="flex flex-col gap-2">
        <Row
          id="zip"
          icon={Download}
          title="Download a bundle (.zip)"
          desc="Move it however you like: USB stick, email, chat. Drop it on Handoff on the other machine."
          action={() =>
            run('zip', async () => {
              download(`/api/export?ids=${ids.join(',')}`);
              toast({ tone: 'success', message: `Downloading ${plural(n, 'session')}` });
            })
          }
        />
        {paired.map((d) => (
          <Row
            key={d.id}
            id={d.id}
            icon={MonitorSmartphone}
            title={`Send to ${d.name}`}
            disabled={!d.online}
            desc={d.online ? 'Lands in its inbox, ready to review' : (d.error ?? 'Offline')}
            action={() =>
              run(d.id, async () => {
                const r = await api.post<{ sessions: number; device: string }>(`/api/devices/${d.id}/push`, { ids });
                toast({ tone: 'success', message: `Sent ${plural(r.sessions, 'session')} to ${r.device}. Open its inbox to finish.` });
              })
            }
          />
        ))}
        {sync.data?.folder ? (
          <Row
            id="sync"
            icon={Cloud}
            title="Copy to the sync folder"
            desc={`${sync.data.folder}${sync.data.lastPushAt ? ` · last copy ${relative(sync.data.lastPushAt)}` : ''}`}
            action={() =>
              run('sync', async () => {
                const r = await api.post<{ pushed: string[]; skipped: Array<{ id: string; reason: string }> }>('/api/sync/push', { ids });
                void qc.invalidateQueries({ queryKey: qk.sync });
                if (r.pushed.length) toast({ tone: 'success', message: `Copied ${plural(r.pushed.length, 'session')} to the sync folder` });
                for (const s of r.skipped.slice(0, 3)) toast({ tone: 'info', message: `${s.id.slice(0, 8)}: ${s.reason}` });
              })
            }
          />
        ) : null}
      </ul>
      {(!paired.length || !sync.data?.folder) && (
        <p className="mt-4 text-sm text-ink-3">
          {!paired.length && (
            <>
              <Link className="underline decoration-line-strong underline-offset-2 hover:decoration-ink" to="/devices" onClick={onClose}>
                Pair a device
              </Link>{' '}
              to send directly over your network.{' '}
            </>
          )}
          {!sync.data?.folder && (
            <>
              <Link className="underline decoration-line-strong underline-offset-2 hover:decoration-ink" to="/sync" onClick={onClose}>
                Set up a sync folder
              </Link>{' '}
              to use OneDrive, Dropbox or a shared drive.
            </>
          )}
        </p>
      )}
    </Dialog>
  );
}
