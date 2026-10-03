// Line-level rewriting applied when a session is imported on another machine.
//
// Two levels:
//  - metadata (default on): cwd, worktree info and checkpoint paths. None of this
//    is sent to the model, so it can't disturb the conversation.
//  - content (opt-in): paths inside messages, tool results and attachments.
//    Editing earlier turns changes the conversation history, which makes newer
//    models drop their saved reasoning blocks when the session is resumed.
//    Thinking blocks themselves and signatures are never touched.
//
// "copy" mode additionally gives the session (and every message) fresh ids so it
// can live next to the original.

import crypto from 'node:crypto';
import { buildRewriter, type PathRule } from '../../shared/paths.js';

export interface TransformOptions {
  rules: PathRule[];
  metadata: boolean;
  content: boolean;
  /** when set, re-key the session: old session id → new, and every message uuid */
  copy?: { fromId: string; toId: string; uuidMap: Map<string, string> };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LineTransformer {
  /** returns the line to write (unchanged text when nothing changed) */
  apply(line: string): string;
  rewrites(): number;
}

export function makeTransformer(opts: TransformOptions): LineTransformer {
  const rw = buildRewriter(opts.rules);
  const r = (s: string) => rw.rewrite(s);

  const deep = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return r(v);
    if (depth > 40 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = deep(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    const o = v as Record<string, unknown>;
    // never edit reasoning blocks or binary payloads
    if (o.type === 'thinking' || o.type === 'redacted_thinking') return v;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (k === 'signature' || (k === 'data' && o.type === 'base64')) {
        out[k] = x;
        continue;
      }
      const y = deep(x, depth + 1);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  };

  const rewriteMetadata = (o: any): boolean => {
    let changed = false;
    const set = (obj: any, key: string) => {
      if (obj && typeof obj[key] === 'string') {
        const n = r(obj[key]);
        if (n !== obj[key]) {
          obj[key] = n;
          changed = true;
        }
      }
    };
    set(o, 'cwd');
    set(o, 'relocatedCwd');
    if (o.worktreeSession && typeof o.worktreeSession === 'object') {
      for (const k of Object.keys(o.worktreeSession)) set(o.worktreeSession, k);
    }
    if (o.type === 'file-history-snapshot' && o.snapshot?.trackedFileBackups && typeof o.snapshot.trackedFileBackups === 'object') {
      const next: Record<string, any> = {};
      for (const [k, v] of Object.entries<any>(o.snapshot.trackedFileBackups)) {
        const nk = r(k);
        if (nk !== k) changed = true;
        if (v && typeof v === 'object') set(v, 'realParentDir');
        next[nk] = v;
      }
      o.snapshot.trackedFileBackups = next;
    }
    if (o.type === 'file-history-delta') {
      set(o, 'trackingPath');
      if (o.backup && typeof o.backup === 'object') set(o.backup, 'realParentDir');
    }
    return changed;
  };

  const CONTENT_KEYS = ['message', 'toolUseResult', 'attachment', 'rendered', 'content', 'summary', 'lastPrompt'];

  const remapIds = (o: any, copy: NonNullable<TransformOptions['copy']>): boolean => {
    let changed = false;
    const walk = (v: any, depth: number): any => {
      if (typeof v === 'string') {
        if (v === copy.fromId) {
          changed = true;
          return copy.toId;
        }
        if (v.length === 36 && UUID_RE.test(v)) {
          const m = copy.uuidMap.get(v);
          if (m) {
            changed = true;
            return m;
          }
        }
        return v;
      }
      if (depth > 40 || v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1);
        return v;
      }
      if (v.type === 'thinking' || v.type === 'redacted_thinking') return v;
      for (const k of Object.keys(v)) {
        if (k === 'signature' || (k === 'data' && v.type === 'base64')) continue;
        v[k] = walk(v[k], depth + 1);
      }
      return v;
    };
    walk(o, 0);
    return changed;
  };

  return {
    apply(line: string): string {
      if (!line.trim()) return line;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        return line;
      }
      if (!o || typeof o !== 'object') return line;
      let changed = false;
      if (opts.metadata && opts.rules.length) changed = rewriteMetadata(o) || changed;
      if (opts.content && opts.rules.length) {
        for (const k of CONTENT_KEYS) {
          if (o[k] === undefined) continue;
          const n = deep(o[k], 0);
          if (n !== o[k]) {
            o[k] = n;
            changed = true;
          }
        }
      }
      if (opts.copy) changed = remapIds(o, opts.copy) || changed;
      return changed ? JSON.stringify(o) : line;
    },
    rewrites: () => rw.count(),
  };
}

/** Collect every message uuid in a file's lines so copy mode can re-key them consistently. */
export function buildUuidMap(lines: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    for (const m of line.matchAll(/"uuid":"([0-9a-f-]{36})"/gi)) {
      if (!map.has(m[1]!)) map.set(m[1]!, crypto.randomUUID());
    }
  }
  return map;
}
