// Where Claude Code keeps things on disk, and how to read the bits that aren't transcripts.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LiveInfo } from '../../shared/types.js';
import { encodeProjectDir } from '../../shared/paths.js';
import { tryParse } from '../util/lines.js';

export interface ClaudeLayout {
  root: string;
  projects: string;
  registry: string;
  fileHistory: string;
  todos: string;
  settingsFile: string;
}

export function claudeLayout(dir?: string | null): ClaudeLayout {
  const root = dir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    root,
    projects: path.join(root, 'projects'),
    registry: path.join(root, 'sessions'),
    fileHistory: path.join(root, 'file-history'),
    todos: path.join(root, 'todos'),
    settingsFile: path.join(root, 'settings.json'),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export interface SessionFileRef {
  id: string;
  projectDir: string;
  file: string;
  size: number;
  mtimeMs: number;
}

export interface SideFile {
  /** path relative to the Claude dir, with "/" separators (bundle layout) */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export async function listProjectDirs(layout: ClaudeLayout): Promise<string[]> {
  try {
    const entries = await fsp.readdir(layout.projects, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Top-level session transcripts of every project (subagent files are attached to their parent later). */
export async function listSessionFiles(layout: ClaudeLayout): Promise<{ sessions: SessionFileRef[]; legacyAgents: SessionFileRef[] }> {
  const sessions: SessionFileRef[] = [];
  const legacyAgents: SessionFileRef[] = [];
  for (const dir of await listProjectDirs(layout)) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(path.join(layout.projects, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(layout.projects, dir, e.name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      const ref = { id: e.name.slice(0, -'.jsonl'.length), projectDir: dir, file, size: st.size, mtimeMs: st.mtimeMs };
      if (e.name.startsWith('agent-')) legacyAgents.push(ref);
      else sessions.push(ref);
    }
  }
  return { sessions, legacyAgents };
}

async function walk(dir: string, relBase: string, out: SideFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = `${relBase}/${e.name}`;
    if (e.isDirectory()) await walk(abs, rel, out);
    else if (e.isFile()) {
      try {
        const st = await fsp.stat(abs);
        out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
}

/** Files that belong to a session besides its transcript: subagents, persisted tool output, checkpoints, todos. */
export async function listSessionSideFiles(
  layout: ClaudeLayout,
  projectDir: string,
  id: string,
  opts: { fileHistory: boolean } = { fileHistory: true },
): Promise<SideFile[]> {
  const out: SideFile[] = [];
  await walk(path.join(layout.projects, projectDir, id), `projects/${projectDir}/${id}`, out);
  if (opts.fileHistory) await walk(path.join(layout.fileHistory, id), `file-history/${id}`, out);
  try {
    for (const name of await fsp.readdir(layout.todos)) {
      if (name.startsWith(id)) {
        const abs = path.join(layout.todos, name);
        const st = await fsp.stat(abs);
        if (st.isFile()) out.push({ rel: `todos/${name}`, abs, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  } catch {
    /* no todos dir */
  }
  return out;
}

export async function listMemoryFiles(layout: ClaudeLayout, projectDir: string): Promise<SideFile[]> {
  const out: SideFile[] = [];
  await walk(path.join(layout.projects, projectDir, 'memory'), `projects/${projectDir}/memory`, out);
  return out;
}

export interface RegistryEntry extends LiveInfo {
  sessionId: string;
  cwd?: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Running Claude Code processes register themselves in ~/.claude/sessions/<pid>.json. */
export async function readLiveRegistry(layout: ClaudeLayout): Promise<Map<string, RegistryEntry>> {
  const out = new Map<string, RegistryEntry>();
  let names: string[];
  try {
    names = await fsp.readdir(layout.registry);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(layout.registry, name), 'utf8');
    } catch {
      continue;
    }
    const o = tryParse(raw);
    if (!o || typeof o.sessionId !== 'string' || typeof o.pid !== 'number') continue;
    if (!pidAlive(o.pid)) continue;
    const prev = out.get(o.sessionId);
    const entry: RegistryEntry = {
      sessionId: o.sessionId,
      pid: o.pid,
      status: typeof o.status === 'string' ? o.status : 'running',
      name: typeof o.name === 'string' ? o.name : undefined,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : undefined,
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : undefined,
      cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
    };
    if (!prev || (entry.updatedAt ?? 0) > (prev.updatedAt ?? 0)) out.set(o.sessionId, entry);
  }
  return out;
}

export function readClaudeSettings(layout: ClaudeLayout): { cleanupPeriodDays: number | null } {
  try {
    const s = JSON.parse(fs.readFileSync(layout.settingsFile, 'utf8'));
    const v = s?.cleanupPeriodDays;
    return { cleanupPeriodDays: typeof v === 'number' ? v : null };
  } catch {
    return { cleanupPeriodDays: null };
  }
}

const decodeCache = new Map<string, string | null>();

/**
 * Recover the real path behind an encoded project folder by walking the local
 * filesystem: at each level pick the child whose encoding is a prefix of what's
 * left. Handles "_", "." and spaces that the naive decode can't tell apart.
 */
export async function resolveEncodedDir(dir: string): Promise<string | null> {
  if (decodeCache.has(dir)) return decodeCache.get(dir)!;
  let roots: Array<{ path: string; rest: string }> = [];
  const win = dir.match(/^([A-Za-z])--(.*)$/);
  if (win && process.platform === 'win32') roots = [{ path: `${win[1]!.toUpperCase()}:\\`, rest: win[2]! }];
  else if (dir.startsWith('-') && process.platform !== 'win32') roots = [{ path: '/', rest: dir.slice(1) }];
  let found: string | null = null;
  let budget = 400; // readdir calls; keeps pathological folders cheap

  async function search(base: string, rest: string, depth: number): Promise<string | null> {
    if (rest === '') return base;
    if (depth > 40 || budget-- <= 0) return null;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      return null;
    }
    const matches = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ name: e.name, enc: encodeProjectDir(e.name) }))
      .filter(({ enc }) => rest.toLowerCase() === enc.toLowerCase() || rest.toLowerCase().startsWith(enc.toLowerCase() + '-'))
      .sort((a, b) => b.enc.length - a.enc.length);
    for (const m of matches) {
      const next = rest.length === m.enc.length ? '' : rest.slice(m.enc.length + 1);
      const r = await search(path.join(base, m.name), next, depth + 1);
      if (r) return r;
    }
    return null;
  }

  for (const r of roots) {
    found = await search(r.path, r.rest, 0);
    if (found) break;
  }
  decodeCache.set(dir, found);
  return found;
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
