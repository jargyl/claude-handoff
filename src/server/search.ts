// Full-text search across every session. Terms are AND-ed within a single
// message; "quoted phrases" match exactly; -term excludes.

import type { SessionIndex } from './claude/sessionIndex.js';
import type { SearchHit, SearchResponse } from '../shared/types.js';

export interface SearchParams {
  q: string;
  project?: string;
  role?: 'user' | 'assistant' | 'tool';
  limit?: number;
  sessionId?: string;
}

interface ParsedQuery {
  include: string[];
  exclude: string[];
}

export function parseQuery(q: string): ParsedQuery {
  const include: string[] = [];
  const exclude: string[] = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const neg = (m[1] || m[3]) === '-';
    const term = (m[2] ?? m[4] ?? '').trim();
    if (!term || (neg && term.length < 1)) continue;
    (neg ? exclude : include).push(term.toLowerCase());
  }
  return { include, exclude };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeSnippet(text: string, terms: string[], radius = 90): { snippet: string; highlights: Array<[number, number]> } {
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) first = 0;
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + radius * 2);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ');
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  snippet = prefix + snippet.trim() + suffix;
  const highlights: Array<[number, number]> = [];
  if (terms.length) {
    const re = new RegExp(terms.map(escapeRe).join('|'), 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(snippet))) {
      highlights.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return { snippet, highlights };
}

export async function searchSessions(index: SessionIndex, params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  const { include, exclude } = parseQuery(params.q);
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 1000);
  const hits: SearchHit[] = [];
  let totalMatches = 0;
  let sessionsSearched = 0;
  if (include.length === 0) return { query: params.q, hits, totalMatches, sessionsSearched, tookMs: 0, truncated: false };

  const includeRes = include.map((t) => new RegExp(escapeRe(t), 'i'));
  const excludeRes = exclude.map((t) => new RegExp(escapeRe(t), 'i'));
  const sessions = index
    .list()
    .filter((s) => (!params.project || s.projectDir === params.project) && (!params.sessionId || s.id === params.sessionId));

  for (const s of sessions) {
    const corpus = await index.corpus(s.id);
    sessionsSearched++;
    let perSession = 0;
    for (const e of corpus) {
      if (params.role && e.role !== params.role) continue;
      if (!includeRes.every((r) => r.test(e.text))) continue;
      if (excludeRes.some((r) => r.test(e.text))) continue;
      totalMatches++;
      if (hits.length >= limit || perSession >= 25) continue;
      perSession++;
      const { snippet, highlights } = makeSnippet(e.text, include);
      hits.push({ sessionId: s.id, title: s.title, projectName: s.projectName, uuid: e.uuid, role: e.role, ts: e.ts, snippet, highlights });
    }
  }
  return { query: params.q, hits, totalMatches, sessionsSearched, tookMs: Date.now() - started, truncated: totalMatches > hits.length };
}
