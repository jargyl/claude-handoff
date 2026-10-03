import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Bot, Search, User, Wrench } from 'lucide-react';
import type { SearchHit } from '../../shared/types';
import { useProjects, useSearch } from '../lib/queries';
import { plural, relative } from '../lib/format';
import { EmptyState, PageHeader, Select, Spinner, TextInput } from '../components/ui';

function Snippet({ hit }: { hit: SearchHit }) {
  const parts: Array<{ t: string; m: boolean }> = [];
  let last = 0;
  for (const [a, b] of hit.highlights) {
    if (a > last) parts.push({ t: hit.snippet.slice(last, a), m: false });
    parts.push({ t: hit.snippet.slice(a, b), m: true });
    last = b;
  }
  parts.push({ t: hit.snippet.slice(last), m: false });
  return (
    <p className="break-words text-sm text-ink-2">
      {parts.map((p, i) =>
        p.m ? (
          <mark key={i} className="rounded-[3px] bg-signal-wash px-0.5 text-ink ring-1 ring-signal-line/40">
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </p>
  );
}

/** The longest plain search word, handed to the session page's find box. */
function findTerm(q: string): string {
  const terms = [...q.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)].filter((m) => !(m[1] || m[3])).map((m) => (m[2] ?? m[4] ?? '').trim());
  return terms.sort((a, b) => b.length - a.length)[0] ?? '';
}

const ROLE = { user: { icon: User, label: 'You' }, assistant: { icon: Bot, label: 'Claude' }, tool: { icon: Wrench, label: 'Tool' } };

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const project = params.get('project') ?? '';
  const role = params.get('role') ?? '';
  const projects = useProjects();
  const res = useSearch({ q, project: project || undefined, role: role || undefined });

  const set = (k: string, v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  // The box is local state mirrored to ?q= after a pause; a ?q= set from elsewhere
  // (the command palette, back/forward) flows back into the box.
  const pushed = useRef(q);
  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q;
      setInput(q);
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (input !== pushed.current) {
        pushed.current = input;
        set('q', input);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const grouped = useMemo(() => {
    const m = new Map<string, { title: string; project: string; hits: SearchHit[] }>();
    for (const h of res.data?.hits ?? []) {
      const g = m.get(h.sessionId) ?? { title: h.title, project: h.projectName, hits: [] };
      g.hits.push(h);
      m.set(h.sessionId, g);
    }
    return [...m.entries()];
  }, [res.data]);

  return (
    <>
      <PageHeader title="Search" description='Every prompt, reply and tool call across all sessions. Use "quotes" for exact phrases and -word to exclude.' />
      <div className="mb-5 flex flex-wrap gap-2">
        <TextInput
          data-page-search
          autoFocus
          icon={Search}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search transcripts"
          aria-label="Search transcripts"
          className="min-w-[240px] flex-1"
        />
        <Select value={project} onChange={(e) => set('project', e.target.value)} aria-label="Project" className="w-full sm:w-52">
          <option value="">All projects</option>
          {projects.data?.projects.map((p) => (
            <option key={p.dir} value={p.dir}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={role} onChange={(e) => set('role', e.target.value)} aria-label="Who said it" className="w-full sm:w-40">
          <option value="">Everything</option>
          <option value="user">Your prompts</option>
          <option value="assistant">Claude's replies</option>
          <option value="tool">Tool calls and output</option>
        </Select>
      </div>

      {q.trim().length < 2 ? (
        <EmptyState icon={Search} title="Search all your sessions">
          Find the session where you fixed that bug, the command Claude ran, or the error you saw last week.
        </EmptyState>
      ) : res.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-ink-3">
          <Spinner /> Searching… The first search reads every transcript, later ones are instant.
        </div>
      ) : res.data && res.data.hits.length === 0 ? (
        <EmptyState icon={Search} title={`Nothing found for “${q}”`}>
          Searched {plural(res.data.sessionsSearched, 'session')}. Try fewer words, or check the filters.
        </EmptyState>
      ) : (
        <>
          <p className="tnum mb-3 text-sm text-ink-3">
            {plural(res.data?.totalMatches ?? 0, 'match', 'matches')} in {plural(grouped.length, 'session')}
            {res.data?.truncated ? `, showing the first ${res.data.hits.length}` : ''} · {res.data?.tookMs} ms
          </p>
          <div className={res.isFetching ? 'opacity-60 transition-opacity' : ''}>
            {grouped.map(([sid, g]) => (
              <section key={sid} className="mb-4 rounded-[10px] border border-line bg-surface">
                <Link to={`/sessions/${sid}`} className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5 hover:bg-raised">
                  <span className="truncate font-semibold">{g.title}</span>
                  <span className="shrink-0 text-sm text-ink-3">
                    {g.project} · {plural(g.hits.length, 'hit')}
                  </span>
                </Link>
                <ul className="divide-y divide-line">
                  {g.hits.map((h, i) => {
                    const R = ROLE[h.role];
                    return (
                      <li key={`${h.uuid}-${i}`}>
                        <Link to={`/sessions/${sid}?find=${encodeURIComponent(findTerm(q))}#m-${h.uuid}`} className="flex gap-3 px-4 py-2.5 hover:bg-raised">
                          <span className="flex w-16 shrink-0 flex-col gap-0.5 text-xs text-ink-3">
                            <span className="flex items-center gap-1 font-medium text-ink-2">
                              <R.icon className="size-3" aria-hidden />
                              {R.label}
                            </span>
                            {relative(h.ts)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <Snippet hit={h} />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}
