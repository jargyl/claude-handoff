import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, History, Inbox as InboxIcon, MonitorSmartphone, Undo2, Upload } from 'lucide-react';
import type { HistoryEntry } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useHistory, useImports } from '../lib/queries';
import { plural, relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { DropZone } from '../components/DropZone';
import { Badge, Button, EmptyState, PageHeader, Panel } from '../components/ui';

const ACTION_LABEL: Record<string, string> = { import: 'Imported', update: 'Updated', overwrite: 'Replaced', copy: 'Kept both', skip: 'Skipped' };

function HistoryRow({ e }: { e: HistoryEntry }) {
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{e.source.label}</span>
        <span className="text-sm text-ink-3">{relative(e.at)}</span>
        {e.undone && <Badge>Undone</Badge>}
        {!e.undone && (
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            className="ml-auto"
            onClick={async () => {
              if (!confirm('Undo this import? Files it created are removed and anything it replaced is restored.')) return;
              try {
                const r = await api.post<{ removed: number; restored: number }>(`/api/history/${e.id}/undo`);
                toast({ tone: 'success', message: `Undone: removed ${plural(r.removed, 'file')}, restored ${plural(r.restored, 'file')}` });
                void qc.invalidateQueries({ queryKey: qk.history });
                void qc.invalidateQueries({ queryKey: qk.sessions });
              } catch (err) {
                toast({ tone: 'error', message: err instanceof ApiError ? err.message : String(err) });
              }
            }}
          >
            Undo
          </Button>
        )}
      </div>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {e.items.map((i) => (
          <li key={i.sessionId + i.action} className="flex min-w-0 items-center gap-2 text-sm">
            <span className="w-20 shrink-0 text-ink-3">{ACTION_LABEL[i.action] ?? i.action}</span>
            {e.undone ? (
              <span className="truncate text-ink-2">{i.title}</span>
            ) : (
              <Link to={`/sessions/${i.newSessionId ?? i.sessionId}`} className="truncate text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
                {i.title}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export default function Inbox() {
  const imports = useImports();
  const history = useHistory();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pending = imports.data?.imports ?? [];
  return (
    <>
      <PageHeader title="Inbox" description="Sessions coming in from your other machines wait here until you decide where they go." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <DropZone />
          <Panel title="Waiting for review" description={pending.length ? undefined : 'Nothing waiting right now.'} padded={false}>
            {pending.length === 0 ? (
              <EmptyState icon={InboxIcon} title="Your inbox is empty">
                Drop a file above, pull from a{' '}
                <Link to="/devices" className="underline decoration-line-strong underline-offset-2">
                  paired device
                </Link>
                , or from your{' '}
                <Link to="/sync" className="underline decoration-line-strong underline-offset-2">
                  sync folder
                </Link>
                .
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {pending.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-[7px] border border-line bg-raised text-ink-2">
                      {p.source.kind === 'device' || p.source.kind === 'push' ? <MonitorSmartphone className="size-4" /> : p.source.kind === 'sync' ? <Cloud className="size-4" /> : <Upload className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.source.label}</p>
                      <p className="truncate text-sm text-ink-3">
                        {plural(p.sessions.length, 'session')} · {relative(p.createdAt)} · {p.sessions.slice(0, 3).map((s) => s.title).join(', ')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.del(`/api/imports/${p.id}`);
                        void qc.invalidateQueries({ queryKey: qk.imports });
                      }}
                    >
                      Discard
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => navigate(`/inbox/${p.id}`)}>
                      Review
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <Panel title="Other ways in" padded={false}>
            <ul className="divide-y divide-line text-sm">
              <li>
                <Link to="/devices" className="flex gap-3 px-4 py-3 hover:bg-sunken/60">
                  <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <span>
                    <span className="block font-medium text-ink">Pull from a paired device</span>
                    <span className="text-ink-3">Both computers on the same network, Handoff running on both.</span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/sync" className="flex gap-3 px-4 py-3 hover:bg-sunken/60">
                  <Cloud className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <span>
                    <span className="block font-medium text-ink">Pull from the sync folder</span>
                    <span className="text-ink-3">Works when the other computer is off. Uses OneDrive, Dropbox or any shared folder.</span>
                  </span>
                </Link>
              </li>
            </ul>
          </Panel>
          <Panel
            title={
              <span className="flex items-center gap-2">
                <History className="size-4 text-ink-3" aria-hidden /> Recent imports
              </span>
            }
            padded={false}
          >
            {history.data?.history.length ? (
              <ul className="max-h-[520px] divide-y divide-line overflow-y-auto scroll-thin">
                {history.data.history.slice(0, 30).map((e) => (
                  <HistoryRow key={e.id} e={e} />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-ink-3">Imports you make show up here, with an undo.</p>
            )}
          </Panel>
        </aside>
      </div>
    </>
  );
}
