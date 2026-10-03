import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  ChevronDown,
  ChevronUp,
  Download,
  Ellipsis,
  FileDown,
  FolderOpen,
  MessagesSquare,
  Pencil,
  Play,
  Search,
  Send,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import type { SessionDetail } from '../../shared/types';
import { api, ApiError, download } from '../lib/api';
import { qk, useMe, useSession, useSessionMeta, useTranscript } from '../lib/queries';
import { bytes, compact, cost, dateTime, duration, middleTruncate, plural, relative, shortId, time } from '../lib/format';
import { useToast } from '../lib/toast';
import { dirname, tildify } from '../../shared/paths';
import { HandoffDialog } from '../components/HandoffDialog';
import { DEFAULT_FILTERS, TranscriptView, buildUnits, plainPromptText, unitText, unitUuids, type TranscriptFilters } from '../components/transcript/Transcript';
import type { ToolContext } from '../components/transcript/ToolCall';
import { BarList } from '../components/charts/BarList';
import { Badge, Button, Callout, CopyButton, EmptyState, IconButton, LiveDot, Menu, MenuItem, Panel, Spinner, Tabs, TextInput, cx } from '../components/ui';

type Tab = 'conversation' | 'files' | 'agents' | 'details';

function Cell({ label, children, title, className }: { label: string; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <div className={cx('min-w-0 border-line px-3 py-2 [&:not(:first-child)]:border-l', className)} title={title}>
      <p className="text-xs text-ink-3">{label}</p>
      <div className="mt-0.5 truncate text-sm text-ink">{children}</div>
    </div>
  );
}

function Header({ s, home, onHandoff }: { s: SessionDetail; home: string; onHandoff: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const meta = useSessionMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const remote = me.data?.access === 'remote';
  useEffect(() => setTitle(s.title), [s.title]);

  const resume = async () => {
    try {
      const r = await api.post<{ terminal: string }>(`/api/sessions/${s.id}/resume`);
      toast({ tone: 'success', message: `Opened in ${r.terminal}` });
    } catch (e) {
      toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
    }
  };
  const save = () => {
    setEditing(false);
    if (title.trim() !== s.title) meta.mutate({ id: s.id, title: title.trim() });
  };

  return (
    <header className="mb-5">
      <Link to="/sessions" className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Sessions
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
              className="flex max-w-2xl gap-2"
            >
              <TextInput
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => e.key === 'Escape' && (setTitle(s.title), setEditing(false))}
                aria-label="Session title"
                className="flex-1"
              />
            </form>
          ) : (
            <h1 className="group flex items-start gap-2 text-2xl font-semibold tracking-[-0.01em]">
              <span className="min-w-0 break-words">{s.title}</span>
              {!remote && (
                <button onClick={() => setEditing(true)} aria-label="Rename" title="Rename (only in Handoff)" className="mt-1.5 rounded p-1 text-ink-3 opacity-60 hover:bg-sunken hover:text-ink group-hover:opacity-100">
                  <Pencil className="size-3.5" />
                </button>
              )}
            </h1>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-2">
            {s.live && (
              <Badge tone="signal">
                <LiveDot status={s.live.status} /> {s.live.status === 'idle' ? 'Open, waiting for you' : 'Claude is working'}
              </Badge>
            )}
            {s.hasForeignPaths && (
              <Badge tone="info" icon={ArrowLeftRight} title="Some paths inside point to another machine">
                Moved from another machine
              </Badge>
            )}
            {s.titleSource === 'ai' && <span className="text-ink-3">Title written by Claude Code</span>}
            {s.titleSource === 'custom' && (
              <button className="text-ink-3 underline decoration-line-strong underline-offset-2" onClick={() => meta.mutate({ id: s.id, title: '' })}>
                Restore original title
              </button>
            )}
          </div>
        </div>
        {!remote && (
          <div className="flex flex-wrap items-center gap-2">
            <IconButton
              label={s.starred ? 'Unstar' : 'Star'}
              icon={Star}
              className={s.starred ? '[&_svg]:fill-signal [&_svg]:text-signal-line' : ''}
              onClick={() => meta.mutate({ id: s.id, starred: !s.starred })}
            />
            <Button icon={Send} onClick={onHandoff}>
              Hand off
            </Button>
            <div className="flex">
              <Button variant="primary" icon={Play} onClick={resume} disabled={!s.resume.cwdExists} title={s.resume.cwdExists ? 'Open a terminal and resume this session' : "The project folder doesn't exist on this machine"} className="rounded-r-none">
                Resume
              </Button>
              <Menu
                trigger={(p) => (
                  <Button variant="primary" className="rounded-l-none border-l border-l-surface/30 px-2" aria-label="Copy resume command" {...p}>
                    <ChevronDown className="size-4" />
                  </Button>
                )}
              >
                {(close) => (
                  <div className="w-[min(440px,85vw)] p-2">
                    <p className="px-1 pb-2 text-sm text-ink-2">Run this in a terminal:</p>
                    {(['powershell', 'cmd', 'bash'] as const).map((k) => (
                      <div key={k} className="mb-2 last:mb-0">
                        <div className="flex items-center justify-between px-1 pb-1">
                          <span className="text-xs text-ink-3">{k === 'powershell' ? 'PowerShell' : k === 'cmd' ? 'Command Prompt' : 'bash / zsh'}</span>
                          <CopyButton text={s.resume[k]} />
                        </div>
                        <code className="block break-all rounded-[6px] bg-sunken px-2 py-1.5 font-mono text-[12px] text-ink" onClick={close}>
                          {s.resume[k]}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </Menu>
            </div>
            <Menu trigger={(p) => <IconButton label="More actions" icon={Ellipsis} {...p} />}>
              {(close) => (
                <>
                  <MenuItem icon={FileDown} onClick={() => (download(`/api/sessions/${s.id}/export.md`), close())}>
                    Export as Markdown
                  </MenuItem>
                  <MenuItem icon={Download} onClick={() => (download(`/api/sessions/${s.id}/raw`), close())}>
                    Download raw transcript (.jsonl)
                  </MenuItem>
                  <MenuItem
                    icon={FolderOpen}
                    disabled={!s.resume.cwdExists}
                    onClick={async () => {
                      close();
                      await api.post('/api/reveal', { path: s.projectPath }).catch((e) => toast({ tone: 'error', message: e.message }));
                    }}
                  >
                    Open project folder
                  </MenuItem>
                  <div className="my-1 border-t border-line" />
                  <MenuItem
                    icon={Trash2}
                    danger
                    disabled={!!s.live}
                    onClick={async () => {
                      close();
                      if (!confirm('Move this session to the trash? You can restore it from Settings.')) return;
                      try {
                        await api.del(`/api/sessions/${s.id}`);
                        void qc.invalidateQueries({ queryKey: qk.sessions });
                        toast({ tone: 'success', message: 'Moved to the trash' });
                        navigate('/sessions');
                      } catch (e) {
                        toast({ tone: 'error', message: e instanceof ApiError ? e.message : String(e) });
                      }
                    }}
                  >
                    Delete session
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-[5px] border border-line bg-surface sm:grid-cols-4 xl:grid-cols-[auto_minmax(0,1.6fr)_repeat(5,minmax(0,1fr))]">
        <Cell label="Session" title={s.id}>
          <span className="font-mono">{shortId(s.id)}</span>
        </Cell>
        <Cell label="Project" title={s.projectPath} className="col-span-1 sm:col-span-3 xl:col-span-1">
          <span className="font-medium">{s.projectName}</span>
          {s.branch && s.branch !== 'HEAD' && <span className="ml-1.5 text-ink-3">on {s.branch}</span>}
          <span className="ml-1.5 font-mono text-[11px] text-ink-3">{middleTruncate(tildify(dirname(s.projectPath), home), 40)}</span>
        </Cell>
        <Cell label="Started" title={dateTime(s.startedAt)}>
          {relative(s.startedAt)}
        </Cell>
        <Cell label="Active" title={`Wall clock ${duration(s.durationMs)}`}>
          {duration(s.activeMs)}
        </Cell>
        <Cell label="Prompts · tools">
          <span className="tnum">
            {s.userMessages.toLocaleString()} · {s.toolCalls.toLocaleString()}
          </span>
        </Cell>
        <Cell label="Tokens" title={`${s.totalTokens.toLocaleString()} tokens`}>
          <span className="tnum">{compact(s.totalTokens)}</span>
        </Cell>
        <Cell label="API-equivalent" title="What this would cost on the Anthropic API at list prices">
          <span className="tnum">{cost(s.cost)}</span>
        </Cell>
      </div>
    </header>
  );
}

function FilesTab({ s, home }: { s: SessionDetail; home: string }) {
  const changed = s.filesTouched.filter((f) => f.edits || f.writes);
  const read = s.filesTouched.filter((f) => !f.edits && !f.writes);
  const List = ({ files, title }: { files: SessionDetail['filesTouched']; title: string }) => (
    <Panel title={title} padded={false}>
      {files.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-3">None.</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={f.path}>
                {tildify(f.path, home)}
              </span>
              <span className="tnum shrink-0 text-xs text-ink-3">
                {[f.writes && `${f.writes} write${f.writes > 1 ? 's' : ''}`, f.edits && `${f.edits} edit${f.edits > 1 ? 's' : ''}`, f.reads && `${f.reads} read${f.reads > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <List files={changed} title={`Changed (${changed.length})`} />
      <List files={read} title={`Only read (${read.length})`} />
    </div>
  );
}

function AgentsTab({ s, onOpen }: { s: SessionDetail; onOpen: (id: string) => void }) {
  if (!s.subagents.length) return <EmptyState icon={Bot} title="No subagents in this session">When Claude delegates work to an agent, its separate transcript shows up here.</EmptyState>;
  return (
    <div className="flex flex-col gap-1.5">
      {s.subagents.map((a) => (
        <button key={a.agentId} onClick={() => onOpen(a.agentId)} className="grid grid-cols-[4px_minmax(0,1fr)_auto] items-stretch rounded-[5px] border border-line bg-surface text-left hover:border-line-strong hover:bg-raised">
          <span className="rounded-l-[5px] bg-line-strong/70" />
          <span className="min-w-0 px-3 py-2">
            <span className="block truncate font-semibold">{a.description ?? a.agentId}</span>
            <span className="block truncate text-sm text-ink-3">
              {a.agentType ?? 'agent'} · {a.model ?? ''} · {relative(a.startedAt)} · {duration(a.startedAt && a.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : 0)}
            </span>
          </span>
          <span className="flex flex-col items-end justify-center border-l border-line px-3 text-sm">
            <span className="tnum font-medium">{cost(a.cost)}</span>
            <span className="tnum text-xs text-ink-3">{a.toolCalls} tools</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function DetailsTab({ s, home }: { s: SessionDetail; home: string }) {
  const meta = useSessionMeta();
  const [note, setNote] = useState(s.note ?? '');
  const [tags, setTags] = useState(s.tags.join(', '));
  const me = useMe();
  const remote = me.data?.access === 'remote';
  const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Tokens and cost by model" padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left font-medium">Model</th>
                <th className="px-2 py-2 text-right font-medium">Input</th>
                <th className="px-2 py-2 text-right font-medium">Output</th>
                <th className="px-2 py-2 text-right font-medium">Cache read</th>
                <th className="px-2 py-2 text-right font-medium">Cache write</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {s.modelStats.map((m) => (
                <tr key={m.label} className="tnum border-b border-line last:border-0">
                  <td className="px-4 py-2 text-ink">{m.label}</td>
                  <td className="px-2 py-2 text-right text-ink-2">{compact(m.usage.input)}</td>
                  <td className="px-2 py-2 text-right text-ink-2">{compact(m.usage.output)}</td>
                  <td className="px-2 py-2 text-right text-ink-2">{compact(m.usage.cacheRead)}</td>
                  <td className="px-2 py-2 text-right text-ink-2">{compact(m.usage.cacheWrite5m + m.usage.cacheWrite1h)}</td>
                  <td className="px-4 py-2 text-right text-ink">{cost(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Includes subagents. API list prices; a Claude subscription doesn't bill per token.</p>
      </Panel>
      <Panel title="Tools used">{tools.length ? <BarList rows={tools.slice(0, 12).map(([n, c]) => ({ key: n, label: n, value: c }))} format={(n) => n.toLocaleString()} /> : <p className="text-sm text-ink-3">No tool calls.</p>}</Panel>
      {!remote && (
        <Panel title="Notes and tags" description="Kept in Handoff only. Claude Code never sees them.">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (s.note ?? '') && meta.mutate({ id: s.id, note })}
            rows={4}
            placeholder="What was this session about? What's left to do?"
            className="w-full rounded-[7px] border border-line-strong bg-raised px-3 py-2 text-base text-ink placeholder:text-ink-3 focus:border-ink-2 focus:outline-none"
          />
          <TextInput
            className="mt-2"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => {
              const next = tags.split(',').map((t) => t.trim()).filter(Boolean);
              if (next.join(',') !== s.tags.join(',')) meta.mutate({ id: s.id, tags: next });
            }}
            placeholder="Tags, separated by commas"
            aria-label="Tags"
          />
        </Panel>
      )}
      <Panel title="On disk" padded={false}>
        <dl className="divide-y divide-line text-sm">
          <div className="flex gap-3 px-4 py-2">
            <dt className="w-28 shrink-0 text-ink-3">Session id</dt>
            <dd className="min-w-0 flex-1 break-all font-mono text-[12px]">{s.id}</dd>
            <CopyButton text={s.id} />
          </div>
          <div className="flex gap-3 px-4 py-2">
            <dt className="w-28 shrink-0 text-ink-3">Claude Code</dt>
            <dd>{s.version ? `v${s.version}` : '—'}</dd>
          </div>
          <div className="flex gap-3 px-4 py-2">
            <dt className="w-28 shrink-0 text-ink-3">Working dirs</dt>
            <dd className="min-w-0 flex-1">
              {s.cwds.map((c) => (
                <p key={c} className="truncate font-mono text-[12px]" title={c}>
                  {tildify(c, home)}
                </p>
              ))}
            </dd>
          </div>
          <div className="flex gap-3 px-4 py-2">
            <dt className="w-28 shrink-0 text-ink-3">Files</dt>
            <dd className="min-w-0 flex-1">
              <p>
                {plural(s.diskFiles.length, 'file')}, {bytes(s.diskFiles.reduce((n, f) => n + f.size, 0))}
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer text-ink-3">Show files</summary>
                <ul className="mt-1 max-h-48 overflow-auto scroll-thin">
                  {s.diskFiles.map((f) => (
                    <li key={f.rel} className="flex justify-between gap-3 font-mono text-[11px] text-ink-2">
                      <span className="truncate">{f.rel}</span>
                      <span className="shrink-0">{bytes(f.size)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={cx('h-7 rounded-full border px-3 text-sm', on ? 'border-ink bg-ink text-surface' : 'border-line-strong bg-raised text-ink-2 hover:text-ink')}>
      {children}
    </button>
  );
}

function Conversation({ s, agent, home, onOpenSubagent }: { s: SessionDetail; agent?: string; home: string; onOpenSubagent: (id: string) => void }) {
  const t = useTranscript(s.id, agent);
  const location = useLocation();
  const [f, setF] = useState<TranscriptFilters>(() => {
    try {
      return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem('handoff-filters') ?? '{}') };
    } catch {
      return DEFAULT_FILTERS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('handoff-filters', JSON.stringify(f));
    } catch {
      /* ignore */
    }
  }, [f]);
  // A search result link (#m-<uuid>) may point at injected context or a slash-command
  // message, which the default filters hide: show those until you change a filter.
  const [reveal, setReveal] = useState(false);
  const shownFilters = useMemo(() => (reveal ? { ...f, context: true, meta: true } : f), [f, reveal]);
  const units = useMemo(() => buildUnits(t.data?.items ?? [], shownFilters), [t.data, shownFilters]);
  // ?find= comes with links from search results, so the word you searched for is marked here too
  const [find, setFind] = useState(() => new URLSearchParams(location.search).get('find') ?? '');
  const [pos, setPos] = useState(0);
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
  const findQ = find.trim().toLowerCase();
  const matches = useMemo(() => {
    if (findQ.length < 2) return [];
    return units.map((u, i) => (unitText(u).toLowerCase().includes(findQ) ? i : -1)).filter((i) => i >= 0);
  }, [units, findQ]);

  // Off-screen messages render with an estimated height (content-visibility), so a single
  // scroll lands short once they lay out. Keep correcting each frame until the target holds
  // still. A newer jump, the wheel or a touch cancels the one in flight.
  const scrollJob = useRef(0);
  const [renderTo, setRenderTo] = useState<number | undefined>(undefined);
  const scrollToEl = useCallback((getEl: () => Element | null, block: ScrollLogicalPosition) => {
    const job = ++scrollJob.current;
    const started = performance.now();
    let lastTop = NaN;
    let still = 0;
    const step = () => {
      if (job !== scrollJob.current) return;
      const el = getEl();
      if (el) {
        el.scrollIntoView({ block, behavior: 'auto' });
        const top = el.getBoundingClientRect().top;
        still = Math.abs(top - lastTop) < 1 ? still + 1 : 0;
        lastTop = top;
        if (still >= 4) return;
      }
      if (performance.now() - started < 3000) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);
  useEffect(() => {
    const cancel = () => scrollJob.current++;
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchmove', cancel, { passive: true });
    return () => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchmove', cancel);
    };
  }, []);

  /** Matches are centered; prompts go to the top so the outline and J/K agree on which one is current. */
  const scrollToUnit = useCallback(
    (i: number, block: ScrollLogicalPosition = 'center') => {
      setHighlight(block === 'center' ? i : undefined);
      const u = units[i];
      if (!u) return;
      setRenderTo(i);
      const id = `m-${unitUuids(u)[0]}`;
      scrollToEl(() => document.getElementById(id), block);
    },
    [units, scrollToEl],
  );

  // New search text jumps to the first match; new messages arriving (live) keep your place.
  // Opened from a search result, the hash picks the match instead (below).
  const lastFind = useRef(location.hash.startsWith('#m-') ? find : '');
  useEffect(() => {
    if (find !== lastFind.current) {
      lastFind.current = find;
      setPos(0);
      if (matches.length) scrollToUnit(matches[0]!);
      else setHighlight(undefined);
    } else if (pos >= matches.length) {
      setPos(Math.max(0, matches.length - 1));
    }
  }, [matches, find]);

  // Jump to #m-<uuid> (links from search results)
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    const hash = location.hash.replace(/^#m-/, '');
    if (!hash || !t.data || jumped.current === hash) return;
    const i = units.findIndex((u) => unitUuids(u).includes(hash));
    if (i >= 0) {
      jumped.current = hash;
      const m = matches.indexOf(i);
      if (m >= 0) setPos(m);
      scrollToUnit(i);
    } else if (!reveal) {
      setReveal(true);
    }
  }, [location.hash, units, t.data, matches, scrollToUnit, reveal]);
  const setFilters = (next: TranscriptFilters) => {
    setReveal(false);
    setF(next);
  };

  // Follow live sessions only while the end of the conversation is on screen. A sentinel
  // after the last message tells us; it stays accurate as content grows, unlike scroll events.
  const atBottom = useRef(false);
  const [atEnd, setAtEnd] = useState(true);
  const [newBelow, setNewBelow] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const sentinelEl = useRef<HTMLDivElement | null>(null);
  const sentinel = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    sentinelEl.current = el;
    if (!el) return;
    observer.current = new IntersectionObserver(
      ([e]) => {
        atBottom.current = !!e?.isIntersecting;
        setAtEnd(!!e?.isIntersecting);
        if (e?.isIntersecting) setNewBelow(false);
      },
      { rootMargin: '0px 0px 240px 0px' },
    );
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const jumpToEnd = useCallback(() => {
    setHighlight(undefined);
    setRenderTo(Number.MAX_SAFE_INTEGER);
    scrollToEl(() => sentinelEl.current, 'end');
  }, [scrollToEl]);
  const count = t.data?.items.length ?? 0;
  const prevCount = useRef(count);
  useLayoutEffect(() => {
    // only follow growth after the first load, never on opening the page
    if (prevCount.current > 0 && count > prevCount.current && s.live) {
      if (atBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
      else setNewBelow(true);
    }
    prevCount.current = count;
  }, [count, s.live]);

  // Outline: your prompts, with the one in view highlighted
  const prompts = useMemo(
    () =>
      units
        .map((u, i) => ({ u, i }))
        .filter(({ u }) => u.kind === 'item' && u.item.kind === 'user' && !u.item.meta && u.item.text)
        .map(({ u, i }) => ({ i, uuid: (u as any).item.uuid as string, text: plainPromptText((u as any).item.text as string), ts: (u as any).item.ts as string | undefined })),
    [units],
  );
  const [active, setActive] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let cur = 0;
        for (let k = 0; k < prompts.length; k++) {
          const el = document.getElementById(`m-${prompts[k]!.uuid}`);
          if (el && el.getBoundingClientRect().top < 160) cur = k;
        }
        setActive(cur);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [prompts]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      // the browser's own End stops at whatever has rendered so far
      if (e.key === 'End') {
        e.preventDefault();
        jumpToEnd();
        return;
      }
      if (e.key === 'j' || e.key === 'k') {
        // before the first prompt reaches the top, J goes to the first one
        const firstEl = prompts[0] ? document.getElementById(`m-${prompts[0].uuid}`) : null;
        const beforeFirst = !!firstEl && firstEl.getBoundingClientRect().top > 160;
        const next = e.key === 'j' ? (beforeFirst ? 0 : active + 1) : active - 1;
        const target = prompts[Math.max(0, Math.min(prompts.length - 1, next))];
        if (target) scrollToUnit(target.i, 'start');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, prompts, scrollToUnit, jumpToEnd]);

  const ctxFind = findQ.length >= 2 ? findQ : undefined;
  const ctx: ToolContext = useMemo(
    () => ({ sessionId: s.id, agent, projectPath: s.projectPath, home, live: !!s.live, onOpenSubagent, find: ctxFind }),
    [s.id, agent, s.projectPath, home, s.live, onOpenSubagent, ctxFind],
  );

  if (t.isLoading) {
    return (
      <div className="grid h-60 place-items-center">
        <Spinner />
      </div>
    );
  }
  // a failed background refresh keeps what's on screen
  if (t.error && !t.data) return <Callout tone="warn" title="Couldn't load the conversation">{(t.error as Error).message}</Callout>;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        <div className="sticky top-12 z-10 -mx-2 mb-2 flex flex-wrap items-center gap-2 bg-bg/95 px-2 py-2 backdrop-blur lg:top-0">
          <div className="flex min-w-[220px] flex-1 items-center gap-1">
            <TextInput data-page-search icon={Search} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find in this conversation" aria-label="Find in conversation" className="flex-1" />
            {find.trim().length >= 2 && (
              <>
                <span className="tnum w-16 shrink-0 text-center text-sm text-ink-3">{matches.length ? `${pos + 1} of ${matches.length}` : 'No match'}</span>
                <IconButton label="Previous match" icon={ChevronUp} size="sm" disabled={!matches.length} onClick={() => { const p = (pos - 1 + matches.length) % matches.length; setPos(p); scrollToUnit(matches[p]!); }} />
                <IconButton label="Next match" icon={ChevronDown} size="sm" disabled={!matches.length} onClick={() => { const p = (pos + 1) % matches.length; setPos(p); scrollToUnit(matches[p]!); }} />
                <IconButton label="Clear" icon={X} size="sm" onClick={() => setFind('')} />
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip on={shownFilters.tools} onClick={() => setFilters({ ...shownFilters, tools: !shownFilters.tools })}>Tool calls</FilterChip>
            <FilterChip on={shownFilters.thinking} onClick={() => setFilters({ ...shownFilters, thinking: !shownFilters.thinking })}>Reasoning</FilterChip>
            <FilterChip on={shownFilters.context} onClick={() => setFilters({ ...shownFilters, context: !shownFilters.context })}>Injected context</FilterChip>
            <FilterChip on={shownFilters.branches} onClick={() => setFilters({ ...shownFilters, branches: !shownFilters.branches })}>Rewound branches</FilterChip>
          </div>
        </div>
        {units.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="Nothing to show yet">This conversation has no messages, or they're all hidden by the filters above.</EmptyState>
        ) : (
          <TranscriptView units={units} ctx={ctx} f={shownFilters} highlightIndex={highlight} renderTo={renderTo} renderAll={findQ.length >= 2} />
        )}
        <div ref={sentinel} aria-hidden className="h-px" />
        {s.live && !agent && (
          <p className="mt-4 flex items-center gap-2 px-2 text-sm text-ink-3">
            <LiveDot status={s.live.status} />
            {s.live.status === 'idle' ? 'Waiting for your next prompt in Claude Code.' : 'Claude is working. New messages appear here as they happen.'}
          </p>
        )}
        {newBelow ? (
          <button onClick={jumpToEnd} className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-signal-line bg-signal px-4 py-2 text-sm font-medium text-signal-ink shadow-[var(--shadow)] lg:ml-[120px]">
            <ArrowDown className="size-4" /> New messages
          </button>
        ) : (
          !atEnd &&
          units.length > 0 && (
            <button
              onClick={jumpToEnd}
              aria-label="Jump to the end"
              title="Jump to the end (End)"
              className="fixed bottom-6 right-6 z-20 grid size-10 place-items-center rounded-full border border-line-strong bg-raised text-ink-2 shadow-[var(--shadow)] hover:text-ink xl:right-[calc(260px+3rem)]"
            >
              <ArrowDown className="size-4" />
            </button>
          )
        )}
      </div>
      <aside className="hidden xl:block">
        <div className="sticky top-4 max-h-[calc(100dvh-2rem)] overflow-y-auto pr-1 scroll-thin">
          <p className="mb-2 text-sm font-semibold text-ink">Your prompts</p>
          {prompts.length === 0 ? (
            <p className="text-sm text-ink-3">No prompts.</p>
          ) : (
            <ol className="flex flex-col border-l border-line">
              {prompts.map((p, k) => (
                <li key={p.uuid}>
                  <button onClick={() => scrollToUnit(p.i, 'start')} className={cx('-ml-px block w-full border-l-2 py-1.5 pl-3 text-left text-sm', k === active ? 'border-signal-line text-ink' : 'border-transparent text-ink-3 hover:text-ink-2')}>
                    <span className="line-clamp-2">{p.text.slice(0, 160)}</span>
                    <span className="tnum text-xs text-ink-3">{time(p.ts)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-xs text-ink-3">Press J / K to move between prompts.</p>
        </div>
      </aside>
    </div>
  );
}

export default function SessionPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const session = useSession(id);
  const me = useMe();
  const [handoff, setHandoff] = useState(false);
  const agent = params.get('agent') ?? undefined;
  const tab = (params.get('tab') as Tab) || 'conversation';
  const home = me.data?.device.homeDir ?? '';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'conversation') next.delete('tab');
    else next.set('tab', t);
    next.delete('agent');
    setParams(next);
  };
  const openAgent = useCallback(
    (a: string) => {
      const next = new URLSearchParams();
      next.set('agent', a);
      setParams(next);
      window.scrollTo({ top: 0 });
    },
    [setParams],
  );

  if (session.isLoading) {
    return (
      <div className="grid h-[50vh] place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!session.data) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title="Session not found"
        action={
          <Link to="/sessions">
            <Button variant="primary">Back to sessions</Button>
          </Link>
        }
      >
        It may have been deleted, or Claude Code cleaned it up.
      </EmptyState>
    );
  }
  const s = session.data;
  const sub = agent ? s.subagents.find((a) => a.agentId === agent) : undefined;

  return (
    <>
      <Header s={s} home={home} onHandoff={() => setHandoff(true)} />
      {s.recap && !agent && tab === 'conversation' && (
        <div className="mb-4 rounded-[8px] border border-line bg-surface px-4 py-3 text-sm">
          <p className="mb-0.5 flex items-center gap-1.5 font-medium">
            <Sparkles className="size-3.5 text-ink-3" aria-hidden /> Where this left off
          </p>
          <p className="text-ink-2">{s.recap}</p>
        </div>
      )}
      {agent ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[8px] border border-line bg-surface px-4 py-2.5">
          <Bot className="size-4 text-ink-3" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{sub?.description ?? agent}</p>
            <p className="text-sm text-ink-3">Subagent transcript{sub?.model ? ` · ${sub.model}` : ''}</p>
          </div>
          <Button size="sm" icon={ArrowLeft} onClick={() => setParams(new URLSearchParams())}>
            Back to the main conversation
          </Button>
        </div>
      ) : (
        <div className="mb-4">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'conversation', label: 'Conversation' },
              { value: 'files', label: 'Files', count: s.filesTouched.length },
              { value: 'agents', label: 'Subagents', count: s.subagents.length },
              { value: 'details', label: 'Details' },
            ]}
          />
        </div>
      )}
      {agent || tab === 'conversation' ? (
        <Conversation key={agent ?? 'main'} s={s} agent={agent} home={home} onOpenSubagent={openAgent} />
      ) : tab === 'files' ? (
        <FilesTab s={s} home={home} />
      ) : tab === 'agents' ? (
        <AgentsTab s={s} onOpen={openAgent} />
      ) : (
        <DetailsTab s={s} home={home} />
      )}
      <HandoffDialog ids={[s.id]} open={handoff} onClose={() => setHandoff(false)} />
    </>
  );
}
