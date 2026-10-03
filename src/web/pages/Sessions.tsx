import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Filter, MessagesSquare, Search, Send, Star, Trash2, X } from 'lucide-react';
import type { SessionListItem } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { qk, useMe, useSessionMeta, useSessions } from '../lib/queries';
import { compact, cost, plural } from '../lib/format';
import { useToast } from '../lib/toast';
import { SessionStrip, StripBay } from '../components/SessionStrip';
import { HandoffDialog } from '../components/HandoffDialog';
import { Button, Checkbox, EmptyState, PageHeader, Select, Spinner, TextInput, cx } from '../components/ui';

type Sort = 'recent' | 'oldest' | 'cost' | 'tokens' | 'prompts' | 'active';
type Range = 'all' | '1' | '7' | '30' | '90';

const SORTS: Record<Sort, { label: string; fn: (a: SessionListItem, b: SessionListItem) => number }> = {
  recent: { label: 'Most recent', fn: (a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') },
  oldest: { label: 'Oldest first', fn: (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') },
  cost: { label: 'Highest cost', fn: (a, b) => (b.cost ?? 0) - (a.cost ?? 0) },
  tokens: { label: 'Most tokens', fn: (a, b) => b.totalTokens - a.totalTokens },
  prompts: { label: 'Most prompts', fn: (a, b) => b.userMessages - a.userMessages },
  active: { label: 'Longest active', fn: (a, b) => b.activeMs - a.activeMs },
};

export default function Sessions() {
  const sessions = useSessions();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [handoff, setHandoff] = useState(false);
  const meta = useSessionMeta();
  const toast = useToast();
  const qc = useQueryClient();
  const remote = me.data?.access === 'remote';

  const q = params.get('q') ?? '';
  const project = params.get('project') ?? '';
  const sort = (params.get('sort') as Sort) || 'recent';
  const range = (params.get('range') as Range) || 'all';
  const only = params.get('only') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const all = sessions.data?.sessions ?? [];
  const projects = useMemo(() => {
    const m = new Map<string, { dir: string; name: string; n: number }>();
    for (const s of all) {
      const p = m.get(s.projectDir) ?? { dir: s.projectDir, name: s.projectName, n: 0 };
      p.n++;
      m.set(s.projectDir, p);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000;
    return all
      .filter((s) => {
        if (project && s.projectDir !== project) return false;
        if (cutoff && Date.parse(s.endedAt ?? '') < cutoff) return false;
        if (only === 'starred' && !s.starred) return false;
        if (only === 'live' && !s.live) return false;
        if (only === 'moved' && !s.hasForeignPaths) return false;
        if (words.length) {
          const hay = `${s.title} ${s.firstPrompt ?? ''} ${s.projectPath} ${s.branch ?? ''} ${s.id} ${s.tags.join(' ')} ${s.note ?? ''}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      })
      .sort(SORTS[sort]?.fn ?? SORTS.recent.fn);
  }, [all, q, project, range, only, sort]);

  const totals = useMemo(
    () => ({
      tokens: filtered.reduce((n, s) => n + s.totalTokens, 0),
      cost: filtered.reduce((n, s) => n + (s.cost ?? 0), 0),
    }),
    [filtered],
  );

  const toggle = (id: string, v: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));
  const someSelected = filtered.some((s) => selected.has(s.id));
  const ids = [...selected];
  const filtersOn = !!(q || project || range !== 'all' || only);

  const deleteSelected = async () => {
    if (!confirm(`Move ${plural(ids.length, 'session')} to the trash? You can restore them from Settings.`)) return;
    let ok = 0;
    for (const id of ids) {
      try {
        await api.del(`/api/sessions/${id}`);
        ok++;
      } catch (e) {
        toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
      }
    }
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: qk.sessions });
    if (ok) toast({ tone: 'success', message: `Moved ${plural(ok, 'session')} to the trash` });
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        description={
          sessions.data ? (
            <span className="tnum">
              {filtersOn ? `${plural(filtered.length, 'session')} of ${all.length.toLocaleString()}` : plural(all.length, 'session')} · {compact(totals.tokens)} tokens · {cost(totals.cost)} API-equivalent
            </span>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TextInput
          data-page-search
          icon={Search}
          value={q}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Filter by title, prompt, project, branch or id"
          aria-label="Filter sessions"
          className="w-full min-w-[220px] flex-1 sm:w-auto"
        />
        <Select value={project} onChange={(e) => set('project', e.target.value)} aria-label="Project" className="w-full sm:w-52">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.dir} value={p.dir}>
              {p.name} ({p.n})
            </option>
          ))}
        </Select>
        <Select value={range} onChange={(e) => set('range', e.target.value === 'all' ? '' : e.target.value)} aria-label="Time range" className="w-[calc(50%-4px)] sm:w-40">
          <option value="all">Any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
        <Select value={sort} onChange={(e) => set('sort', e.target.value === 'recent' ? '' : e.target.value)} aria-label="Sort" className="w-[calc(50%-4px)] sm:w-44">
          {Object.entries(SORTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Filter className="mr-1 size-3.5 text-ink-3" aria-hidden />
        {[
          ['', 'All'],
          ['live', 'Open now'],
          ['starred', 'Starred'],
          ['moved', 'Moved from another machine'],
        ].map(([v, label]) => (
          <button
            key={v}
            onClick={() => set('only', v!)}
            className={cx('h-7 rounded-full border px-3 text-sm', only === v ? 'border-ink bg-ink text-surface' : 'border-line-strong bg-raised text-ink-2 hover:text-ink')}
          >
            {label}
          </button>
        ))}
        {filtersOn && (
          <button onClick={() => setParams(new URLSearchParams(), { replace: true })} className="ml-1 inline-flex h-7 items-center gap-1 px-2 text-sm text-ink-3 hover:text-ink">
            <X className="size-3.5" /> Clear filters
          </button>
        )}
      </div>

      {!remote && (
        <div
          className={cx(
            'sticky top-12 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-[8px] border px-3 py-2 lg:top-2',
            someSelected ? 'border-signal-line/60 bg-signal-wash' : 'border-transparent',
          )}
        >
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && someSelected}
            onChange={(v) => setSelected(v ? new Set(filtered.map((s) => s.id)) : new Set())}
            label="Select all shown sessions"
          />
          <span className="mr-auto text-sm text-ink-2">{someSelected ? `${plural(ids.length, 'session')} selected` : 'Select sessions to hand off, star or delete'}</span>
          {someSelected && (
            <>
              <Button size="sm" variant="primary" icon={Send} onClick={() => setHandoff(true)}>
                Hand off
              </Button>
              <Button
                size="sm"
                icon={Star}
                onClick={() => {
                  const star = !ids.every((id) => all.find((s) => s.id === id)?.starred);
                  for (const id of ids) meta.mutate({ id, starred: star });
                }}
              >
                Star
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={deleteSelected}>
                Delete
              </Button>
            </>
          )}
        </div>
      )}

      {sessions.isLoading ? (
        <div className="grid h-60 place-items-center">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={MessagesSquare} title={all.length ? 'No sessions match these filters' : 'No sessions yet'}>
          {all.length ? 'Try a broader search or clear the filters.' : 'Sessions show up here as soon as you use Claude Code on this machine.'}
        </EmptyState>
      ) : (
        <StripBay label="Sessions">
          {filtered.map((s) => (
            <SessionStrip key={s.id} s={s} to={`/sessions/${s.id}`} selected={selected.has(s.id)} onSelect={remote ? undefined : (v) => toggle(s.id, v)} />
          ))}
        </StripBay>
      )}

      <HandoffDialog ids={ids} open={handoff} onClose={() => setHandoff(false)} onDone={() => setSelected(new Set())} />
    </>
  );
}
