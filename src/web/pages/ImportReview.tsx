import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, CircleCheck, CircleX, FolderCheck, FolderOpen, FolderX, Inbox, Play, Undo2 } from 'lucide-react';
import type { ImportAction, ImportOptions, ImportPlan, ImportResult } from '../../shared/types';
import { api, ApiError, seg } from '../lib/api';
import { qk, useMe, usePlan, useSettings } from '../lib/queries';
import { bytes, plural, relative } from '../lib/format';
import { useToast } from '../lib/toast';
import { tildify } from '../../shared/paths';
import { FolderPicker } from '../components/FolderPicker';
import { Badge, Button, Callout, CopyButton, EmptyState, PageHeader, Panel, Select, Spinner, StatusBadge, Switch, TextInput, cx } from '../components/ui';

const ACTIONS: Record<ImportAction, string> = {
  import: 'Import',
  update: 'Update my copy',
  overwrite: 'Replace my copy',
  copy: 'Import as a separate session',
  skip: 'Skip',
};

function MappingRow({
  m,
  value,
  locked,
  onChange,
  home,
  sourceName,
}: {
  m: ImportPlan['mappings'][number];
  value: string;
  locked: boolean;
  onChange: (v: string) => void;
  home: string;
  sourceName: string;
}) {
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <li className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)] lg:items-start">
      <div className="min-w-0">
        <p className="text-xs text-ink-3">On {sourceName}</p>
        <p className="mt-0.5 break-all font-mono text-[12px] text-ink-2">{m.from}</p>
        <p className="mt-1 text-xs text-ink-3">{plural(m.sessions, 'session')}</p>
      </div>
      <ArrowRight className="mt-5 hidden size-4 text-ink-3 lg:block" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs text-ink-3">On this computer</p>
        {locked ? (
          <p className="mt-0.5 break-all font-mono text-[12px] text-ink">{value}</p>
        ) : (
          <form
            className="mt-0.5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onChange(draft.trim());
            }}
          >
            <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() !== value && onChange(draft.trim())} className="flex-1 font-mono" aria-label={`Folder for ${m.from}`} spellCheck={false} />
            <Button type="button" icon={FolderOpen} onClick={() => setPicker(true)}>
              Browse
            </Button>
          </form>
        )}
        <p className={cx('mt-1.5 flex items-center gap-1.5 text-sm', m.exists ? 'text-good' : 'text-warn')}>
          {m.exists ? <FolderCheck className="size-3.5" aria-hidden /> : <FolderX className="size-3.5" aria-hidden />}
          {m.exists ? 'Folder found' : "This folder doesn't exist here"}
          <span className="text-ink-3">· {locked ? 'Already here, updates stay in place' : m.reason}</span>
        </p>
        {!m.exists && !locked && <p className="mt-1 text-sm text-ink-3">Point this at your copy of the project (for example where you cloned the repo). You can also import now and create the folder later.</p>}
      </div>
      <FolderPicker open={picker} onClose={() => setPicker(false)} initial={m.exists ? value : home} onPick={(p) => onChange(p)} title="Where does this project live on this computer?" description={`Sessions from ${m.from}`} />
    </li>
  );
}

function Results({ result, platform, home }: { result: ImportResult; platform: string; home: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ok = result.items.filter((i) => i.ok);
  const failed = result.items.filter((i) => !i.ok);
  return (
    <>
      <PageHeader
        title={ok.length ? `Brought over ${plural(ok.length, 'session')}` : 'Nothing was imported'}
        description={failed.length ? `${plural(failed.length, 'session')} couldn't be imported. See below.` : 'They now show up in Claude Code. Resume one right away, or find it in your sessions later.'}
        actions={
          <>
            <Button
              icon={Undo2}
              onClick={async () => {
                if (!confirm('Undo this import?')) return;
                try {
                  await api.post(`/api/history/${result.historyId}/undo`);
                  void qc.invalidateQueries({ queryKey: qk.sessions });
                  toast({ tone: 'success', message: 'Import undone' });
                  navigate('/inbox');
                } catch (e) {
                  toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
                }
              }}
            >
              Undo
            </Button>
            <Link to="/inbox">
              <Button variant="primary">Done</Button>
            </Link>
          </>
        }
      />
      <div className="flex flex-col gap-2">
        {result.items.map((i) => {
          const id = i.newSessionId ?? i.sessionId;
          const cmd = i.resume ? (platform === 'win32' ? i.resume.powershell : i.resume.bash) : '';
          return (
            <div key={i.sessionId + i.action} className="rounded-[8px] border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {i.ok ? <CircleCheck className="size-4 text-good" aria-label="Done" /> : <CircleX className="size-4 text-bad" aria-label="Failed" />}
                <Link to={`/sessions/${id}`} className="min-w-0 flex-1 truncate font-semibold hover:underline">
                  {i.title}
                </Link>
                <Badge>{ACTIONS[i.action]}</Badge>
                {i.ok && i.rewrites > 0 && <Badge tone="info">{plural(i.rewrites, 'path')} updated</Badge>}
              </div>
              {i.ok ? (
                <>
                  <p className="mt-1 text-sm text-ink-3">
                    Resumes in <span className="font-mono text-[12px] text-ink-2">{tildify(i.targetPath, home)}</span>
                    {i.backup ? ' · your previous copy was backed up' : ''}
                  </p>
                  {i.resume && !i.resume.cwdExists && <p className="mt-1 text-sm text-warn">Create or clone the project there before resuming: Claude Code starts in that folder.</p>}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={Play}
                      disabled={!i.resume?.cwdExists}
                      onClick={async () => {
                        try {
                          const r = await api.post<{ terminal: string }>(`/api/sessions/${id}/resume`);
                          toast({ tone: 'success', message: `Opened in ${r.terminal}` });
                        } catch (e) {
                          toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
                        }
                      }}
                    >
                      Resume in a terminal
                    </Button>
                    {cmd && <CopyButton text={cmd} label="Copy command" />}
                    {cmd && <code className="min-w-0 truncate rounded-[5px] bg-sunken px-2 py-1 font-mono text-[11px] text-ink-2">{cmd}</code>}
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-bad">{i.error}</p>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function ImportReview() {
  const { id = '' } = useParams();
  const planQ = usePlan(id);
  const settings = useSettings();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<Record<string, ImportAction>>({});
  const [options, setOptions] = useState<ImportOptions | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const home = me.data?.device.homeDir ?? '';
  const seq = useRef(0);

  useEffect(() => {
    if (planQ.data && !plan) {
      setPlan(planQ.data);
      setMappings(Object.fromEntries(planQ.data.mappings.map((m) => [m.from, m.to])));
      setActions(Object.fromEntries(planQ.data.candidates.map((c) => [c.session.id, c.suggestedAction])));
    }
  }, [planQ.data, plan]);
  useEffect(() => {
    if (settings.data && !options) setOptions(settings.data.settings.importDefaults);
  }, [settings.data, options]);

  const changeMapping = async (from: string, to: string) => {
    if (!to || mappings[from] === to) return;
    const next = { ...mappings, [from]: to };
    setMappings(next);
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const p = await api.post<ImportPlan>(`/api/imports/${seg(id)}/plan`, { mappings: next });
      if (mine !== seq.current) return;
      setPlan(p);
      setActions((prev) => Object.fromEntries(p.candidates.map((c) => [c.session.id, c.allowedActions.includes(prev[c.session.id]!) ? prev[c.session.id]! : c.suggestedAction])));
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    } finally {
      if (mine === seq.current) setRefreshing(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of Object.values(actions)) c[a] = (c[a] ?? 0) + 1;
    return c;
  }, [actions]);
  const toDo = Object.values(actions).filter((a) => a !== 'skip').length;

  if (result) return <Results result={result} platform={me.data?.device.platform ?? 'win32'} home={home} />;
  if (planQ.isLoading || (!plan && !planQ.error)) {
    return (
      <div className="grid h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }
  if (planQ.error || !plan) {
    return (
      <EmptyState
        icon={Inbox}
        title="This import isn't available anymore"
        action={
          <Link to="/inbox">
            <Button variant="primary">Back to inbox</Button>
          </Link>
        }
      >
        It was finished or discarded.
      </EmptyState>
    );
  }

  const sourceName = plan.sourceDevice?.name ?? plan.source.deviceName ?? 'the other computer';
  const lockedFrom = new Set(plan.mappings.filter((m) => plan.candidates.filter((c) => c.session.projectPath === m.from).every((c) => c.status !== 'new')).map((m) => m.from));

  return (
    <>
      <PageHeader
        back={{ to: '/inbox', label: 'Inbox' }}
        title="Review import"
        description={
          <>
            {plural(plan.candidates.length, 'session')} from {sourceName}
            {plan.sourceDevice ? ` · ${plan.sourceDevice.platform === 'win32' ? 'Windows' : plan.sourceDevice.platform === 'darwin' ? 'macOS' : plan.sourceDevice.platform}` : ''} · added {relative(plan.createdAt)}
          </>
        }
      />
      {plan.warnings.map((w) => (
        <div key={w} className="mb-4">
          <Callout tone="warn" icon={CircleAlert} title={w} />
        </div>
      ))}

      <div className={cx('flex flex-col gap-5', refreshing && 'opacity-70 transition-opacity')}>
        {plan.mappings.length > 0 && (
          <Panel title="Where do these projects live on this computer?" description="Claude Code finds sessions by project folder, so each one needs to land in the right place." padded={false}>
            <ul className="divide-y divide-line">
              {plan.mappings.map((m) => (
                <MappingRow key={m.from} m={m} value={mappings[m.from] ?? m.to} locked={lockedFrom.has(m.from)} onChange={(v) => void changeMapping(m.from, v)} home={home} sourceName={sourceName} />
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="Sessions" padded={false}>
          <ul className="divide-y divide-line">
            {plan.candidates.map((c) => (
              <li key={c.session.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{c.session.title}</span>
                    <StatusBadge status={c.status} labels={{ new: 'New here' }} />
                  </div>
                  <p className="mt-0.5 truncate text-sm text-ink-3">
                    {relative(c.session.endedAt)} · {plural(c.session.userMessages, 'prompt')} · {bytes(c.session.sizeBytes)} · into <span className="font-mono text-[12px]">{tildify(c.targetPath, home)}</span>
                  </p>
                  {c.warnings.map((w) => (
                    <p key={w} className="mt-1 flex items-start gap-1.5 text-sm text-warn">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {w}
                    </p>
                  ))}
                </div>
                <Select value={actions[c.session.id] ?? c.suggestedAction} onChange={(e) => setActions({ ...actions, [c.session.id]: e.target.value as ImportAction })} aria-label={`What to do with ${c.session.title}`} className="w-full md:w-60">
                  {c.allowedActions.map((a) => (
                    <option key={a} value={a}>
                      {ACTIONS[a]}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </Panel>

        {options && (
          <Panel title="Options">
            <div className="flex flex-col gap-4">
              <Switch
                checked={options.rewriteMetadata}
                onChange={(v) => setOptions({ ...options, rewriteMetadata: v })}
                label="Point session details at the new folder"
                description="Updates the working directory and checkpoint paths Claude Code keeps next to each message. Recommended."
              />
              <Switch
                checked={options.rewriteContent}
                onChange={(v) => setOptions({ ...options, rewriteContent: v })}
                label="Also update paths inside the conversation"
                description="Rewrites old folder paths in messages and tool output. Editing earlier turns makes newer Claude models set aside their saved reasoning when you resume, so leave this off unless Claude keeps reaching for the old paths."
              />
              <Switch checked={options.includeFileHistory} onChange={(v) => setOptions({ ...options, includeFileHistory: v })} label="Bring checkpoints" description="File backups that let /rewind restore your code. Takes more space." />
              {plan.memory.length > 0 && (
                <Switch
                  checked={options.includeMemory}
                  onChange={(v) => setOptions({ ...options, includeMemory: v })}
                  label="Bring project memory"
                  description={plan.memory.every((m) => m.targetHasMemory) ? 'The projects here already have memory, so nothing will be copied.' : 'Copied only into projects that have no memory here yet.'}
                />
              )}
            </div>
          </Panel>
        )}
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <p className="mr-auto text-sm text-ink-2">
          {Object.entries(counts)
            .filter(([, n]) => n)
            .map(([a, n]) => `${ACTIONS[a as ImportAction]}: ${n}`)
            .join(' · ')}
        </p>
        <Button
          variant="ghost"
          onClick={async () => {
            await api.del(`/api/imports/${seg(id)}`);
            void qc.invalidateQueries({ queryKey: qk.imports });
            navigate('/inbox');
          }}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          loading={committing}
          disabled={toDo === 0 || refreshing}
          onClick={async () => {
            setCommitting(true);
            try {
              const r = await api.post<ImportResult>(`/api/imports/${seg(id)}/commit`, { mappings, actions, options });
              setResult(r);
              void qc.invalidateQueries({ queryKey: qk.sessions });
              void qc.invalidateQueries({ queryKey: qk.imports });
              void qc.invalidateQueries({ queryKey: qk.history });
              window.scrollTo({ top: 0 });
            } catch (e) {
              toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
            } finally {
              setCommitting(false);
            }
          }}
        >
          {toDo ? `Bring over ${plural(toDo, 'session')}` : 'Nothing selected'}
        </Button>
      </div>
    </>
  );
}
