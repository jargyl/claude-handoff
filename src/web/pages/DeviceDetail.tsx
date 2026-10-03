import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Eye, MonitorSmartphone, RefreshCw, Search } from 'lucide-react';
import type { ImportPlan, SyncStatus } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useDeviceSessions, useDevices, useSessions } from '../lib/queries';
import { bytes, plural, relative, shortId } from '../lib/format';
import { useToast } from '../lib/toast';
import { Button, Callout, Checkbox, EmptyState, IconButton, PageHeader, Spinner, StatusBadge, Tabs, TextInput, cx } from '../components/ui';

type Tab = 'get' | 'send';

const PULLABLE: SyncStatus[] = ['new', 'incoming-ahead', 'diverged'];

export default function DeviceDetail() {
  const { id = '' } = useParams();
  const devices = useDevices();
  const remote = useDeviceSessions(id);
  const local = useSessions();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('get');
  const [q, setQ] = useState('');
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const device = devices.data?.devices.find((d) => d.id === id);
  const name = remote.data?.device.name ?? device?.name ?? 'Device';

  const remoteList = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (remote.data?.sessions ?? []).filter((s) => {
      if (onlyChanges && !PULLABLE.includes(s.status)) return false;
      if (!words.length) return true;
      const hay = `${s.title} ${s.projectPath} ${s.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [remote.data, q, onlyChanges]);

  const sendList = useMemo(() => {
    const byId = new Map((remote.data?.pushable ?? []).map((p) => [p.id, p.status]));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (local.data?.sessions ?? [])
      .filter((s) => byId.has(s.id))
      .map((s) => ({ s, status: byId.get(s.id)! }))
      .filter(({ s }) => !words.length || words.every((w) => `${s.title} ${s.projectPath} ${s.id}`.toLowerCase().includes(w)));
  }, [remote.data, local.data, q]);

  const toggle = (sid: string, v: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (v) n.add(sid);
      else n.delete(sid);
      return n;
    });
  const shownIds = tab === 'get' ? remoteList.map((s) => s.id) : sendList.map((x) => x.s.id);
  const all = shownIds.length > 0 && shownIds.every((i) => selected.has(i));
  const some = shownIds.some((i) => selected.has(i));
  const ids = shownIds.filter((i) => selected.has(i));

  const pull = async () => {
    setBusy(true);
    try {
      const plan = await api.post<ImportPlan>(`/api/devices/${id}/pull`, { ids });
      void qc.invalidateQueries({ queryKey: qk.imports });
      navigate(`/inbox/${plan.id}`);
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ sessions: number; device: string }>(`/api/devices/${id}/push`, { ids });
      toast({ tone: 'success', message: `Sent ${plural(r.sessions, 'session')} to ${r.device}. Finish the import in its inbox.` });
      setSelected(new Set());
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/devices', label: 'Devices' }}
        title={name}
        description={device ? `${device.url.replace('http://', '')} · ${device.online ? 'online' : (device.error ?? 'offline')}` : undefined}
        actions={<IconButton label="Refresh" icon={RefreshCw} onClick={() => void remote.refetch()} />}
      />
      {remote.error ? (
        <Callout tone="warn" icon={MonitorSmartphone} title={`Can't reach ${name}`} action={<Button size="sm" onClick={() => void remote.refetch()}>Try again</Button>}>
          {(remote.error as Error).message}
        </Callout>
      ) : remote.isLoading ? (
        <div className="grid h-60 place-items-center">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="mb-4">
            <Tabs
              value={tab}
              onChange={(t) => {
                setTab(t);
                setSelected(new Set());
              }}
              tabs={[
                { value: 'get', label: `Get from ${name}`, count: (remote.data?.sessions ?? []).filter((s) => PULLABLE.includes(s.status)).length },
                { value: 'send', label: `Send to ${name}`, count: remote.data?.pushable.length ?? 0 },
              ]}
            />
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <TextInput data-page-search icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter sessions" aria-label="Filter sessions" className="min-w-[220px] flex-1" />
            {tab === 'get' && (
              <button onClick={() => setOnlyChanges((v) => !v)} aria-pressed={onlyChanges} className={cx('h-9 rounded-full border px-3.5 text-sm', onlyChanges ? 'border-ink bg-ink text-surface' : 'border-line-strong bg-raised text-ink-2')}>
                Only what's new or changed
              </button>
            )}
          </div>
          <div className={cx('sticky top-12 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-[8px] border px-3 py-2 lg:top-2', some ? 'border-signal-line/60 bg-signal-wash' : 'border-transparent')}>
            <Checkbox checked={all} indeterminate={!all && some} onChange={(v) => setSelected(v ? new Set(shownIds) : new Set())} label="Select all" />
            <span className="mr-auto text-sm text-ink-2">{some ? `${plural(ids.length, 'session')} selected` : tab === 'get' ? 'Select sessions to bring to this computer' : `Select sessions to send to ${name}`}</span>
            {some &&
              (tab === 'get' ? (
                <Button size="sm" variant="primary" icon={ArrowDownToLine} loading={busy} onClick={pull}>
                  Pull {plural(ids.length, 'session')}
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={ArrowUpFromLine} loading={busy} onClick={send}>
                  Send {plural(ids.length, 'session')}
                </Button>
              ))}
          </div>
          {tab === 'get' ? (
            remoteList.length === 0 ? (
              <EmptyState icon={ArrowDownToLine} title={onlyChanges ? 'You already have everything' : 'No sessions there'}>
                {onlyChanges ? `Every session on ${name} is on this computer too, and up to date.` : undefined}
              </EmptyState>
            ) : (
              <div className="flex flex-col gap-1.5">
                {remoteList.map((s) => (
                  <div key={s.id} className={cx('grid grid-cols-[4px_minmax(0,1fr)_auto] items-stretch rounded-[5px] border', selected.has(s.id) ? 'border-signal-line/60 bg-signal-wash' : 'border-line bg-surface')}>
                    <span className={cx('rounded-l-[5px]', s.live ? 'bg-signal' : 'bg-line-strong/70')} />
                    <label className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
                      <Checkbox checked={selected.has(s.id)} onChange={(v) => toggle(s.id, v)} label={`Select ${s.title}`} />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{s.title}</span>
                        <span className="block truncate text-sm text-ink-3">
                          {s.projectName} · {relative(s.endedAt)} · {plural(s.userMessages, 'prompt')} · {bytes(s.sizeBytes)} · <span className="font-mono">{shortId(s.id)}</span>
                        </span>
                      </span>
                    </label>
                    <div className="flex items-center gap-2 border-l border-line px-3">
                      <StatusBadge status={s.status} labels={{ new: 'Not here yet' }} />
                      <Link to={`/devices/${id}/sessions/${s.id}`} aria-label={`Preview ${s.title}`} title="Preview" className="grid size-7 place-items-center rounded-[6px] text-ink-3 hover:bg-sunken hover:text-ink">
                        <Eye className="size-4" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : sendList.length === 0 ? (
            <EmptyState icon={ArrowUpFromLine} title={`${name} is up to date`}>
              Every session here is on {name} too.
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-1.5">
              {sendList.map(({ s, status }) => (
                <label key={s.id} className={cx('grid cursor-pointer grid-cols-[4px_minmax(0,1fr)_auto] items-stretch rounded-[5px] border', selected.has(s.id) ? 'border-signal-line/60 bg-signal-wash' : 'border-line bg-surface')}>
                  <span className={cx('rounded-l-[5px]', s.live ? 'bg-signal' : 'bg-line-strong/70')} />
                  <span className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <Checkbox checked={selected.has(s.id)} onChange={(v) => toggle(s.id, v)} label={`Select ${s.title}`} />
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{s.title}</span>
                      <span className="block truncate text-sm text-ink-3">
                        {s.projectName} · {relative(s.endedAt)} · {plural(s.userMessages, 'prompt')}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center border-l border-line px-3">
                    <StatusBadge status={status} labels={{ missing: 'Not there yet' }} />
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
