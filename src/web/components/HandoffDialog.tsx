// "Hand off": send selected sessions to another machine — as a file, straight to
// a paired device, or into the sync folder.

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, MonitorSmartphone, type LucideIcon } from 'lucide-react';
import { api, ApiError, downloadPost, seg } from '../lib/api';
import { qk, useDevices, useMe, useSync } from '../lib/queries';
import { plural, relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { Dialog } from './Dialog';
import { Spinner } from './ui';

function Option({ icon: Icon, title, desc, onClick, disabled, busy }: { icon: LucideIcon; title: string; desc: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <li>
      <button
        disabled={disabled}
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-[8px] border border-line bg-raised px-3.5 py-3 text-left transition-colors hover:border-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[7px] border border-line bg-surface text-ink-2">{busy ? <Spinner /> : <Icon className="size-4" aria-hidden />}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-ink">{title}</span>
          <span className="block text-sm text-ink-3">{desc}</span>
        </span>
      </button>
    </li>
  );
}

export function HandoffDialog({ ids, open, onClose, onDone }: { ids: string[]; open: boolean; onClose: () => void; onDone?: () => void }) {
  const me = useMe();
  const local = me.data?.access === 'local';
  // only ask about devices and the sync folder while the dialog is open
  const devices = useDevices(open && local);
  const sync = useSync(open && local);
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

  const paired = devices.data?.devices ?? [];

  return (
    <Dialog open={open} onClose={onClose} title={`Hand off ${plural(n, 'session')}`} description="Pick how to get them to your other machine. You'll review where they go over there.">
      <ul className="flex flex-col gap-2">
        <Option
          icon={Download}
          title="Download a bundle (.zip)"
          desc="Move it however you like: USB stick, email, chat. Drop it on Handoff on the other machine."
          busy={busy === 'zip'}
          disabled={!!busy}
          onClick={() =>
            run('zip', async () => {
              await downloadPost('/api/export', { ids }, 'claude-sessions.zip');
              toast({ tone: 'success', message: `Saved ${plural(n, 'session')} as a bundle` });
            })
          }
        />
        {paired.map((d) => (
          <Option
            key={d.id}
            icon={MonitorSmartphone}
            title={`Send to ${d.name}`}
            disabled={!d.online || !!busy}
            busy={busy === d.id}
            desc={d.online ? 'Lands in its inbox, ready to review' : (d.error ?? 'Offline')}
            onClick={() =>
              run(d.id, async () => {
                const r = await api.post<{ sessions: number; device: string }>(`/api/devices/${seg(d.id)}/push`, { ids });
                toast({ tone: 'success', message: `Sent ${plural(r.sessions, 'session')} to ${r.device}. Open its inbox to finish.` });
              })
            }
          />
        ))}
        {sync.data?.folder ? (
          <Option
            icon={Cloud}
            title="Copy to the sync folder"
            desc={`${sync.data.folder}${sync.data.lastPushAt ? ` · last copy ${relative(sync.data.lastPushAt)}` : ''}`}
            busy={busy === 'sync'}
            disabled={!!busy}
            onClick={() =>
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
      {local && (!paired.length || !sync.data?.folder) && (
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
