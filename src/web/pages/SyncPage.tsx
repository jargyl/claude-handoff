import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Cloud, Eye, FolderOpen, HardDrive, Laptop, Search, Trash2 } from 'lucide-react';
import type { ImportPlan, SyncStatus } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useMe, useSync, useUpdateSettings } from '../lib/queries';
import { bytes, plural, relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { FolderPicker } from '../components/FolderPicker';
import { Badge, Button, Callout, Checkbox, EmptyState, IconButton, PageHeader, Panel, Segmented, Spinner, StatusBadge, TextInput, cx } from '../components/ui';

function Setup() {
  const update = useUpdateSettings();
  const me = useMe();
  const [picker, setPicker] = useState(false);
  const toast = useToast();
  const suggestions = useQuery({ queryKey: ['sync-suggestions'], queryFn: () => api.get<{ suggestions: Array<{ name: string; path: string }> }>('/api/sync/suggestions') });
  const choose = (folder: string) =>
    update.mutate(
      { sync: { folder } },
      {
        onSuccess: (r) => toast({ tone: 'success', message: `Sync folder set to ${r.settings.sync.folder}` }),
        onError: (e) => toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) }),
      },
    );
  return (
    <Panel>
      <div className="mx-auto max-w-[640px] py-6 text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-[10px] border border-line bg-raised text-ink-2">
          <Cloud className="size-5" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">Pick a folder both computers can see</h2>
        <p className="mt-1.5 text-base text-ink-2">
          OneDrive, Dropbox, Google Drive, iCloud, Syncthing, a network share or a USB stick all work. This computer copies sessions into it; your other computer picks them up, even when this one is
          switched off. It also keeps a copy of sessions Claude Code would otherwise delete after {me.data?.claude.cleanupPeriodDays ?? 30} days.
        </p>
        {suggestions.data && suggestions.data.suggestions.length > 0 && (
          <div className="mt-5 flex flex-col gap-2 text-left">
            <p className="text-sm text-ink-3">Found on this computer:</p>
            {suggestions.data.suggestions.map((s) => (
              <button key={s.path} onClick={() => choose(s.path)} className="flex items-center gap-3 rounded-[8px] border border-line bg-raised px-3.5 py-2.5 text-left hover:border-ink-3">
                <Cloud className="size-4 shrink-0 text-ink-3" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block truncate font-mono text-[12px] text-ink-3">{s.path}</span>
                </span>
                <span className="text-sm font-medium text-ink-2">Use this</span>
              </button>
            ))}
            <p className="text-xs text-ink-3">Handoff creates a “Claude Handoff” folder inside it.</p>
          </div>
        )}
        <Button variant={suggestions.data?.suggestions.length ? 'secondary' : 'primary'} icon={FolderOpen} className="mt-5" onClick={() => setPicker(true)}>
          Choose another folder
        </Button>
      </div>
      <FolderPicker open={picker} onClose={() => setPicker(false)} onPick={choose} title="Choose a sync folder" description="Pick a folder that syncs between your computers." />
    </Panel>
  );
}

export default function SyncPage() {
  const sync = useSync();
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const st = sync.data;

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (st?.sessions ?? []).filter((s) => !words.length || words.every((w) => `${s.title} ${s.projectPath} ${s.id} ${s.pushedBy.name}`.toLowerCase().includes(w)));
  }, [st, q]);
  const pullable = (s: { status: SyncStatus }) => s.status === 'new' || s.status === 'incoming-ahead' || s.status === 'diverged';
  const ids = list.filter((s) => selected.has(s.id)).map((s) => s.id);
  const all = list.length > 0 && list.every((s) => selected.has(s.id));
  const some = ids.length > 0;

  const pushAll = async () => {
    setBusy('push');
    try {
      const r = await api.post<{ pushed: string[]; skipped: Array<{ id: string; reason: string }> }>('/api/sync/push', { all: true });
      void qc.invalidateQueries({ queryKey: qk.sync });
      const real = r.skipped.filter((s) => s.reason !== 'Already up to date');
      toast({ tone: 'success', message: r.pushed.length ? `Copied ${plural(r.pushed.length, 'session')} to the sync folder` : 'Everything was already up to date' });
      if (real.length) toast({ tone: 'info', message: `${plural(real.length, 'session')} skipped: ${real[0]!.reason}` });
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const pull = async (pick: string[]) => {
    setBusy('pull');
    try {
      const r = await api.post<{ stagings: string[]; plan: ImportPlan }>('/api/sync/pull', { ids: pick });
      void qc.invalidateQueries({ queryKey: qk.imports });
      if (r.stagings.length > 1) toast({ tone: 'info', message: `Sessions from ${r.stagings.length} computers: the others are waiting in your inbox.` });
      navigate(`/inbox/${r.plan.id}`);
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (sync.isLoading) {
    return (
      <div className="grid h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Sync folder" description="Move sessions through a folder that syncs between your computers. Works even when the other computer is off." />
      {!st?.folder ? (
        <Setup />
      ) : (
        <div className="flex flex-col gap-5">
          {st.error && <Callout tone="warn" icon={HardDrive} title={st.error} />}
          <Panel
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-[13px] font-normal">{st.folder}</span>
                {st.writable ? <Badge tone="good">Connected</Badge> : <Badge tone="warn">Not writable</Badge>}
              </span>
            }
            actions={
              <>
                <Button size="sm" icon={FolderOpen} onClick={() => void api.post('/api/reveal', { path: st.folder }).catch(() => void 0)}>
                  Open
                </Button>
                <Button size="sm" onClick={() => setPicker(true)}>
                  Change
                </Button>
              </>
            }
          >
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <p className="font-medium">Copy sessions here automatically</p>
                <p className="mt-0.5 text-sm text-ink-3">Handoff copies new and updated sessions a few seconds after they change. Sessions you have open are copied at most every 5 minutes.</p>
                <div className="mt-3">
                  <Segmented
                    label="Automatic copying"
                    value={st.autoPush}
                    onChange={(v) => update.mutate({ sync: { autoPush: v } })}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'all', label: 'All sessions' },
                      { value: 'starred', label: 'Starred only' },
                    ]}
                  />
                </div>
              </div>
              <div className="flex flex-col items-start gap-2 md:items-end">
                <p className="text-sm text-ink-3">{st.lastPushAt ? `Last copy ${relative(st.lastPushAt)}` : 'Nothing copied from here yet'}</p>
                <Button variant="primary" icon={ArrowUpFromLine} loading={busy === 'push'} onClick={pushAll} disabled={!st.writable}>
                  {st.pendingPush ? `Copy ${plural(st.pendingPush, 'session')} now` : 'Copy everything now'}
                </Button>
              </div>
            </div>
            {st.devices.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="mb-2 text-sm text-ink-3">Computers using this folder</p>
                <div className="flex flex-wrap gap-2">
                  {st.devices.map((d) => (
                    <span key={d.id} className="inline-flex items-center gap-2 rounded-[6px] border border-line bg-raised px-2.5 py-1 text-sm">
                      <Laptop className="size-3.5 text-ink-3" aria-hidden />
                      {d.name}
                      <span className="text-ink-3">{relative(d.lastSeen)}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Panel>

          <section>
            <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-md font-semibold">In the folder</h2>
              <span className="text-sm text-ink-3">{plural(st.sessions.length, 'session')}</span>
            </div>
            {st.sessions.length === 0 ? (
              <Panel>
                <EmptyState icon={Cloud} title="The folder is empty">
                  Copy sessions into it from here, or from Handoff on your other computer.
                </EmptyState>
              </Panel>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <TextInput data-page-search icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter sessions" className="min-w-[220px] flex-1" />
                  <Button icon={ArrowDownToLine} onClick={() => void pull(list.filter(pullable).map((s) => s.id))} disabled={!list.some(pullable) || !!busy}>
                    Pull everything new
                  </Button>
                </div>
                <div className={cx('sticky top-12 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-[8px] border px-3 py-2 lg:top-2', some ? 'border-signal-line/60 bg-signal-wash' : 'border-transparent')}>
                  <Checkbox checked={all} indeterminate={!all && some} onChange={(v) => setSelected(v ? new Set(list.map((s) => s.id)) : new Set())} label="Select all" />
                  <span className="mr-auto text-sm text-ink-2">{some ? `${plural(ids.length, 'session')} selected` : 'Select sessions to pull or remove'}</span>
                  {some && (
                    <>
                      <Button size="sm" variant="primary" icon={ArrowDownToLine} loading={busy === 'pull'} onClick={() => void pull(ids)}>
                        Pull to this computer
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon={Trash2}
                        onClick={async () => {
                          if (!confirm(`Remove ${plural(ids.length, 'session')} from the sync folder? Copies on your computers stay.`)) return;
                          for (const i of ids) await api.del(`/api/sync/sessions/${i}`);
                          setSelected(new Set());
                          void qc.invalidateQueries({ queryKey: qk.sync });
                        }}
                      >
                        Remove from folder
                      </Button>
                    </>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  {list.map((s) => (
                    <div key={s.id} className={cx('grid grid-cols-[4px_minmax(0,1fr)_auto] items-stretch rounded-[5px] border', selected.has(s.id) ? 'border-signal-line/60 bg-signal-wash' : 'border-line bg-surface')}>
                      <span className="rounded-l-[5px] bg-line-strong/70" />
                      <label className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
                        <Checkbox
                          checked={selected.has(s.id)}
                          onChange={(v) =>
                            setSelected((p) => {
                              const n = new Set(p);
                              if (v) n.add(s.id);
                              else n.delete(s.id);
                              return n;
                            })
                          }
                          label={`Select ${s.title}`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{s.title}</span>
                          <span className="block truncate text-sm text-ink-3">
                            {s.projectName} · from {s.pushedBy.name}, {relative(s.pushedAt)} · {plural(s.userMessages, 'prompt')} · {bytes(s.sizeBytes)}
                          </span>
                        </span>
                      </label>
                      <div className="flex items-center gap-2 border-l border-line px-3">
                        <StatusBadge status={s.status} labels={{ new: 'Not here yet', 'incoming-ahead': 'Newer in folder', 'local-ahead': 'Newer here' }} />
                        {s.status === 'local-ahead' ? (
                          <IconButton label="Copy the newer version" icon={ArrowUpFromLine} size="sm" onClick={() => void api.post('/api/sync/push', { ids: [s.id] }).then(() => qc.invalidateQueries({ queryKey: qk.sync }))} />
                        ) : null}
                        {s.status !== 'same' && s.status !== 'local-ahead' ? <IconButton label="Pull" icon={ArrowDownToLine} size="sm" onClick={() => void pull([s.id])} /> : null}
                        <Link to={`/sync/sessions/${s.id}`} title="Read it" aria-label={`Read ${s.title}`} className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-sunken hover:text-ink">
                          <Eye className="size-4" />
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
          <p className="text-sm text-ink-3">
            Stop using this folder?{' '}
            <button
              className="underline decoration-line-strong underline-offset-2 hover:text-ink"
              onClick={() => {
                if (confirm('Stop using this sync folder? Nothing is deleted from it.')) update.mutate({ sync: { folder: null, autoPush: 'off' } });
              }}
            >
              Disconnect it
            </button>
            . Nothing in it is deleted.
          </p>
        </div>
      )}
      <FolderPicker
        open={picker}
        onClose={() => setPicker(false)}
        initial={st?.folder ?? undefined}
        onPick={(folder) => update.mutate({ sync: { folder } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: qk.sync }) })}
        title="Choose a sync folder"
      />
    </>
  );
}
