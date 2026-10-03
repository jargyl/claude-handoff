// In-memory index of every session on this machine, kept fresh by a file watcher
// and persisted to a cache so restarts are instant.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  claudeLayout,
  dirExists,
  listMemoryFiles,
  listSessionFiles,
  listSessionSideFiles,
  readLiveRegistry,
  resolveEncodedDir,
  type ClaudeLayout,
  type RegistryEntry,
  type SessionFileRef,
} from './locate.js';
import { PARSER_VERSION, summarizeFile, type SessionCore } from './parse.js';
import { buildTranscript, type CorpusEntry, type TranscriptBuild } from './transcript.js';
import { tryParse } from '../util/lines.js';
import type { MetaStore, SettingsStore } from '../config.js';
import { readJsonSync, writeJsonAtomic } from '../config.js';
import {
  addUsage,
  emptyUsage,
  totalTokens,
  type FileTouch,
  type IndexStatus,
  type ModelStat,
  type ProjectSummary,
  type ResumeInfo,
  type SessionDetail,
  type SessionListItem,
  type SubagentInfo,
  type TitleSource,
  type Usage,
} from '../../shared/types.js';
import { basename, canonicalPath, encodeProjectDir, isInside, naiveDecodeProjectDir, sameEncodedDir } from '../../shared/paths.js';
import { costOf, modelLabel } from '../../shared/pricing.js';

export interface IndexedFile {
  file: string;
  size: number;
  mtimeMs: number;
  core: SessionCore;
}

export interface SubagentFile extends IndexedFile {
  agentId: string;
  description?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface IndexedSession {
  id: string;
  projectDir: string;
  main: IndexedFile;
  subagents: SubagentFile[];
}

interface ProjectInfo {
  dir: string;
  path: string;
  exact: boolean;
  exists: boolean;
}

interface CacheFile {
  version: number;
  files: Record<string, { size: number; mtimeMs: number; core: SessionCore }>;
}

export class SessionIndex extends EventEmitter {
  layout: ClaudeLayout;
  private sessions = new Map<string, IndexedSession>();
  private projects = new Map<string, ProjectInfo>();
  private fileCache = new Map<string, { size: number; mtimeMs: number; core: SessionCore }>();
  private cacheFile: string;
  private cacheDirty = false;
  private cacheTimer?: NodeJS.Timeout;
  live = new Map<string, RegistryEntry>();
  status: IndexStatus = { state: 'idle', done: 0, total: 0, sessions: 0 };
  private watchers: fs.FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private pending = new Map<string, { timer: NodeJS.Timeout; first: number }>();
  private transcripts = new Map<string, { size: number; mtimeMs: number; build: TranscriptBuild }>();
  private scanning?: Promise<void>;
  private existsCache = new Map<string, boolean>();

  constructor(
    private settings: SettingsStore,
    private meta: MetaStore,
    cacheDir: string,
    /** --claude-dir: used for this run only, never saved */
    claudeDirOverride?: string,
  ) {
    super();
    this.setMaxListeners(100);
    this.layout = claudeLayout(claudeDirOverride ?? settings.get().claudeDir);
    this.cacheFile = path.join(cacheDir, `index-v${PARSER_VERSION}.json`);
    const cached = readJsonSync<CacheFile | null>(this.cacheFile, null);
    if (cached?.version === PARSER_VERSION && cached.files) {
      for (const [k, v] of Object.entries(cached.files)) this.fileCache.set(k, v);
    }
  }

  // ------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await this.refreshLive();
    await this.scanAll();
    this.watch();
    this.timers.push(setInterval(() => void this.refreshLive(), 5000));
    this.timers.push(setInterval(() => void this.scanAll(true), 60_000));
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.watchers = [];
    this.timers = [];
    void this.flushCache();
  }

  /** Re-point at a different Claude dir (settings change). */
  async relocate(dir: string | null): Promise<void> {
    this.stop();
    this.layout = claudeLayout(dir);
    this.sessions.clear();
    this.projects.clear();
    this.transcripts.clear();
    await this.start();
    this.emit('sessions', { changed: [], removed: [] });
  }

  private watch(): void {
    try {
      const w = fs.watch(this.layout.projects, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const parts = filename.toString().split(/[\\/]+/);
        if (parts.length === 2 && parts[1]!.endsWith('.jsonl')) {
          if (parts[1]!.startsWith('agent-')) this.schedule(parts[0]!, '*');
          else this.schedule(parts[0]!, parts[1]!.slice(0, -6));
        } else if (parts.length === 4 && parts[2] === 'subagents' && parts[3]!.endsWith('.jsonl')) {
          this.schedule(parts[0]!, parts[1]!);
        } else if (parts.length === 1) {
          this.schedule(parts[0]!, '*');
        }
      });
      w.on('error', () => void 0);
      this.watchers.push(w);
    } catch {
      // projects dir missing or recursive watch unsupported: the periodic scan covers it
      this.timers.push(setInterval(() => void this.scanAll(true), 10_000));
    }
    try {
      let t: NodeJS.Timeout | undefined;
      const w = fs.watch(this.layout.registry, () => {
        clearTimeout(t);
        t = setTimeout(() => void this.refreshLive(), 300);
      });
      w.on('error', () => void 0);
      this.watchers.push(w);
    } catch {
      /* no registry dir yet */
    }
  }

  private schedule(dir: string, id: string): void {
    const key = `${dir}/${id}`;
    const now = Date.now();
    const p = this.pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      if (now - p.first > 2500) {
        this.pending.delete(key);
        void this.refresh(dir, id);
        return;
      }
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      void this.refresh(dir, id);
    }, 400);
    this.pending.set(key, { timer, first: p?.first ?? now });
  }

  private async refresh(dir: string, id: string): Promise<void> {
    try {
      await this.refreshUnsafe(dir, id);
    } catch (e: any) {
      console.error('[handoff] refresh failed:', e?.message ?? e);
    }
  }

  private async refreshUnsafe(dir: string, id: string): Promise<void> {
    if (id === '*') return this.scanAll(true);
    const file = path.join(this.layout.projects, dir, `${id}.jsonl`);
    let st: fs.Stats | null = null;
    try {
      st = await fsp.stat(file);
    } catch {
      st = null;
    }
    if (!st) {
      if (this.sessions.get(id)?.projectDir === dir) {
        this.sessions.delete(id);
        this.updateProjects();
        this.emit('sessions', { changed: [], removed: [id] });
      }
      return;
    }
    await this.indexSession({ id, projectDir: dir, file, size: st.size, mtimeMs: st.mtimeMs });
    this.updateProjects();
    this.emit('sessions', { changed: [id], removed: [] });
  }

  async refreshLive(): Promise<void> {
    const next = await readLiveRegistry(this.layout);
    const sig = (m: Map<string, RegistryEntry>) =>
      [...m.values()]
        .map((e) => `${e.sessionId}:${e.status}`)
        .sort()
        .join('|');
    if (sig(next) !== sig(this.live)) {
      this.live = next;
      this.emit('live', { sessions: [...next.keys()] });
    } else {
      this.live = next;
    }
  }

  // ------------------------------------------------------------ scanning

  scanAll(quiet = false): Promise<void> {
    if (this.scanning) return this.scanning;
    // a file can vanish between listing and reading (Claude Code cleanup, moves): never let that crash us
    this.scanning = this.doScan(quiet)
      .catch((e) => console.error('[handoff] scan failed:', e?.message ?? e))
      .finally(() => {
        this.scanning = undefined;
      });
    return this.scanning;
  }

  private async doScan(quiet: boolean): Promise<void> {
    const { sessions } = await listSessionFiles(this.layout);
    const seen = new Set<string>();
    const changed: string[] = [];
    if (!quiet) {
      this.status = { state: 'scanning', done: 0, total: sessions.length, sessions: this.sessions.size };
      this.emit('index', this.status);
    }
    let i = 0;
    let lastEmit = 0;
    for (const ref of sessions) {
      seen.add(ref.id);
      const prev = this.sessions.get(ref.id);
      let touched = false;
      try {
        touched = await this.indexSession(ref, prev);
      } catch {
        continue; // vanished or unreadable right now; the next scan picks it up
      }
      if (touched) changed.push(ref.id);
      i++;
      if (!quiet && Date.now() - lastEmit > 250) {
        lastEmit = Date.now();
        this.status = { state: 'scanning', done: i, total: sessions.length, sessions: this.sessions.size };
        this.emit('index', this.status);
      }
    }
    const removed: string[] = [];
    for (const id of this.sessions.keys()) {
      if (!seen.has(id)) {
        this.sessions.delete(id);
        removed.push(id);
      }
    }
    await this.updateProjectsAsync();
    this.status = { state: 'idle', done: sessions.length, total: sessions.length, sessions: this.sessions.size, lastScanAt: new Date().toISOString() };
    if (!quiet) this.emit('index', this.status);
    if (changed.length || removed.length) this.emit('sessions', { changed, removed });
  }

  private async parseCached(file: string, size: number, mtimeMs: number): Promise<IndexedFile> {
    const c = this.fileCache.get(file);
    if (c && c.size === size && c.mtimeMs === mtimeMs) return { file, size, mtimeMs, core: c.core };
    const core = await summarizeFile(file);
    this.fileCache.set(file, { size, mtimeMs, core });
    this.markCacheDirty();
    return { file, size, mtimeMs, core };
  }

  /** Returns true when anything about the session changed. */
  private async indexSession(ref: SessionFileRef, prev?: IndexedSession): Promise<boolean> {
    let changed = !prev || prev.main.size !== ref.size || prev.main.mtimeMs !== ref.mtimeMs || prev.projectDir !== ref.projectDir;
    const main = changed ? await this.parseCached(ref.file, ref.size, ref.mtimeMs) : prev!.main;
    const subDir = path.join(this.layout.projects, ref.projectDir, ref.id, 'subagents');
    const subagents: SubagentFile[] = [];
    let names: string[] = [];
    try {
      names = await fsp.readdir(subDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(subDir, name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      const old = prev?.subagents.find((s) => s.file === file);
      if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) {
        subagents.push(old);
        continue;
      }
      changed = true;
      const parsed = await this.parseCached(file, st.size, st.mtimeMs);
      const agentId = name.slice(0, -6).replace(/^agent-/, '');
      const metaRaw = tryParse(await fsp.readFile(path.join(subDir, name.slice(0, -6) + '.meta.json'), 'utf8').catch(() => ''));
      subagents.push({
        ...parsed,
        agentId,
        description: typeof metaRaw?.description === 'string' ? metaRaw.description : undefined,
        agentType: typeof metaRaw?.agentType === 'string' ? metaRaw.agentType : undefined,
        toolUseId: typeof metaRaw?.toolUseId === 'string' ? metaRaw.toolUseId : undefined,
      });
    }
    if (prev && prev.subagents.length !== subagents.length) changed = true;
    subagents.sort((a, b) => (a.core.startedAt ?? '').localeCompare(b.core.startedAt ?? ''));
    this.sessions.set(ref.id, { id: ref.id, projectDir: ref.projectDir, main, subagents });
    return changed;
  }

  private markCacheDirty(): void {
    this.cacheDirty = true;
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = undefined;
      void this.flushCache();
    }, 5000);
  }

  private async flushCache(): Promise<void> {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    const files: CacheFile['files'] = {};
    const keep = new Set<string>();
    for (const s of this.sessions.values()) {
      keep.add(s.main.file);
      for (const a of s.subagents) keep.add(a.file);
    }
    for (const [k, v] of this.fileCache) if (keep.has(k)) files[k] = v;
    try {
      await writeJsonAtomic(this.cacheFile, { version: PARSER_VERSION, files } satisfies CacheFile);
    } catch {
      /* cache is best-effort */
    }
  }

  // ------------------------------------------------------------ projects

  private updateProjects(): void {
    void this.updateProjectsAsync();
  }

  private async updateProjectsAsync(): Promise<void> {
    const byDir = new Map<string, IndexedSession[]>();
    for (const s of this.sessions.values()) {
      const list = byDir.get(s.projectDir) ?? [];
      list.push(s);
      byDir.set(s.projectDir, list);
    }
    const next = new Map<string, ProjectInfo>();
    for (const [dir, list] of byDir) {
      const known = this.projects.get(dir);
      let found: string | undefined;
      // newest sessions first: their cwd reflects where the project lives now
      for (const s of [...list].sort((a, b) => b.main.mtimeMs - a.main.mtimeMs)) {
        found = [...s.main.core.cwds].reverse().find((c) => sameEncodedDir(encodeProjectDir(c), dir));
        if (found) break;
      }
      if (found) {
        next.set(dir, { dir, path: found, exact: true, exists: this.exists(found) });
        continue;
      }
      if (known && !known.exact) {
        next.set(dir, known);
        continue;
      }
      const resolved = await resolveEncodedDir(dir);
      const p = resolved ?? naiveDecodeProjectDir(dir);
      next.set(dir, { dir, path: p, exact: !!resolved, exists: resolved ? true : this.exists(p) });
    }
    this.projects = next;
  }

  private exists(p: string): boolean {
    const k = canonicalPath(p);
    const c = this.existsCache.get(k);
    if (c !== undefined) return c;
    const v = dirExists(p);
    this.existsCache.set(k, v);
    return v;
  }

  projectInfo(dir: string): ProjectInfo {
    return this.projects.get(dir) ?? { dir, path: naiveDecodeProjectDir(dir), exact: false, exists: false };
  }

  /** Project folder already used for a given absolute path, if any (handles casing and long-path quirks). */
  findProjectDirForPath(p: string): string | undefined {
    for (const info of this.projects.values()) if (canonicalPath(info.path) === canonicalPath(p)) return info.dir;
    const enc = encodeProjectDir(p);
    for (const dir of this.projects.keys()) if (sameEncodedDir(dir, enc)) return dir;
    return undefined;
  }

  // ------------------------------------------------------------ queries

  get(id: string): IndexedSession | undefined {
    return this.sessions.get(id);
  }

  all(): IndexedSession[] {
    return [...this.sessions.values()];
  }

  size(): number {
    return this.sessions.size;
  }

  sessionCost(s: IndexedSession): { usage: Usage; cost: number | null; partial: boolean; models: ModelStat[] } {
    const overrides = this.settings.get().pricingOverrides;
    const byModel = new Map<string, ModelStat>();
    let cost = 0;
    let priced = false;
    let partial = false;
    const usage = emptyUsage();
    const files = [s.main, ...s.subagents];
    for (const f of files) {
      for (const ev of f.core.usage) {
        addUsage(usage, ev.u);
        const c = costOf(ev.u, ev.model, { fast: ev.fast, overrides });
        if (c === null) partial = true;
        else {
          cost += c;
          priced = true;
        }
        const label = modelLabel(ev.model);
        const m = byModel.get(label) ?? { model: ev.model, label, messages: 0, usage: emptyUsage(), cost: 0 };
        m.messages++;
        addUsage(m.usage, ev.u);
        // one label is one price family, so a model is either fully priced or not at all
        m.cost = c === null ? null : (m.cost ?? 0) + c;
        byModel.set(label, m);
      }
    }
    const models = [...byModel.values()].sort((a, b) => totalTokens(b.usage) - totalTokens(a.usage));
    return { usage, cost: priced ? cost : partial ? null : 0, partial: partial && priced, models };
  }

  private title(s: IndexedSession): { title: string; source: TitleSource } {
    const meta = this.meta.get(s.id);
    const c = s.main.core;
    if (meta.title) return { title: meta.title, source: 'custom' };
    if (c.customTitle) return { title: c.customTitle, source: 'claude' };
    if (c.aiTitle) return { title: c.aiTitle, source: 'ai' };
    if (c.summaryTitle) return { title: c.summaryTitle, source: 'summary' };
    if (c.firstPrompt) return { title: c.firstPrompt.length > 90 ? c.firstPrompt.slice(0, 89) + '…' : c.firstPrompt, source: 'prompt' };
    return { title: 'Untitled session', source: 'none' };
  }

  private hasForeignPaths(s: IndexedSession, projectPath: string): boolean {
    const home = os.homedir();
    return s.main.core.cwds.some((c) => !isInside(c, projectPath) && !isInside(c, home) && !this.exists(c));
  }

  listItem(s: IndexedSession): SessionListItem {
    const c = s.main.core;
    const proj = this.projectInfo(s.projectDir);
    const { title, source } = this.title(s);
    const { usage, cost, partial, models } = this.sessionCost(s);
    const meta = this.meta.get(s.id);
    const live = this.live.get(s.id);
    const start = c.startedAt ? Date.parse(c.startedAt) : NaN;
    const end = c.endedAt ? Date.parse(c.endedAt) : NaN;
    const realBranch = [...c.branches].reverse().find((b) => b !== 'HEAD') ?? c.branches[c.branches.length - 1];
    return {
      id: s.id,
      projectDir: s.projectDir,
      projectPath: proj.path,
      projectName: basename(proj.path),
      title,
      titleSource: source,
      firstPrompt: c.firstPrompt,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      durationMs: Number.isNaN(start) || Number.isNaN(end) ? 0 : end - start,
      activeMs: c.activeMs,
      userMessages: c.userMessages,
      assistantMessages: c.assistantMessages,
      toolCalls: c.toolCalls,
      toolErrors: c.toolErrors,
      usage,
      totalTokens: totalTokens(usage),
      cost,
      costPartial: partial,
      models: models.map((m) => m.label),
      branch: realBranch,
      version: c.version,
      sizeBytes: s.main.size + s.subagents.reduce((n, a) => n + a.size, 0),
      mtimeMs: Math.max(s.main.mtimeMs, ...s.subagents.map((a) => a.mtimeMs)),
      subagentCount: s.subagents.length,
      compactions: c.compactions,
      hasForeignPaths: this.hasForeignPaths(s, proj.path),
      ...(live ? { live: { pid: live.pid, status: live.status, name: live.name, updatedAt: live.updatedAt, startedAt: live.startedAt } } : {}),
      starred: !!meta.starred,
      tags: meta.tags ?? [],
      ...(meta.note ? { note: meta.note } : {}),
      idCount: c.idSeq.length,
      idHash: c.idHash,
    };
  }

  list(): SessionListItem[] {
    return this.all()
      .map((s) => this.listItem(s))
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || b.mtimeMs - a.mtimeMs);
  }

  async detail(id: string): Promise<SessionDetail | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const item = this.listItem(s);
    const c = s.main.core;
    const { models } = this.sessionCost(s);
    const tools: Record<string, number> = { ...c.tools };
    const filesTouched: FileTouch[] = Object.entries(c.files)
      .map(([p, [reads, edits, writes]]) => ({ path: p, reads, edits, writes }))
      .sort((a, b) => b.edits + b.writes - (a.edits + a.writes) || b.reads - a.reads);
    const subagents: SubagentInfo[] = s.subagents.map((a) => {
      const sc = this.sessionCost({ ...s, main: a, subagents: [] });
      return {
        agentId: a.agentId,
        description: a.description,
        agentType: a.agentType,
        toolUseId: a.toolUseId,
        model: a.core.model ? modelLabel(a.core.model) : undefined,
        lines: a.core.lines,
        sizeBytes: a.size,
        usage: sc.usage,
        cost: sc.cost,
        toolCalls: a.core.toolCalls,
        startedAt: a.core.startedAt,
        endedAt: a.core.endedAt,
      };
    });
    const side = await listSessionSideFiles(this.layout, s.projectDir, s.id);
    return {
      ...item,
      aiTitle: c.aiTitle,
      lastPrompt: c.lastPrompt,
      recap: c.recap,
      cwds: c.cwds,
      branches: c.branches,
      modelStats: models,
      tools,
      subagents,
      filesTouched,
      diskFiles: [
        { rel: `projects/${s.projectDir}/${s.id}.jsonl`, size: s.main.size },
        ...side.map((f) => ({ rel: f.rel, size: f.size })),
      ],
      resume: resumeInfo(item.projectPath, s.id, this.exists(item.projectPath)),
    };
  }

  async projectsSummary(): Promise<ProjectSummary[]> {
    const by = new Map<string, ProjectSummary>();
    for (const s of this.sessions.values()) {
      const info = this.projectInfo(s.projectDir);
      const item = this.listItem(s);
      const p =
        by.get(s.projectDir) ??
        ({
          dir: s.projectDir,
          path: info.path,
          name: basename(info.path),
          pathExists: info.exists,
          sessions: 0,
          usage: emptyUsage(),
          totalTokens: 0,
          cost: 0,
          userMessages: 0,
          live: 0,
          hasMemory: false,
        } as ProjectSummary);
      p.sessions++;
      addUsage(p.usage, item.usage);
      p.totalTokens += item.totalTokens;
      p.cost = item.cost === null || p.cost === null ? p.cost : p.cost + item.cost;
      p.userMessages += item.userMessages;
      if (item.live) p.live++;
      if (item.endedAt && (!p.lastActive || item.endedAt > p.lastActive)) p.lastActive = item.endedAt;
      if (item.startedAt && (!p.firstActive || item.startedAt < p.firstActive)) p.firstActive = item.startedAt;
      by.set(s.projectDir, p);
    }
    for (const p of by.values()) p.hasMemory = (await listMemoryFiles(this.layout, p.dir)).length > 0;
    return [...by.values()].sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
  }

  // ------------------------------------------------------------ transcripts

  /** Resolve the file for a session or one of its subagents. */
  fileFor(id: string, agentId?: string): IndexedFile | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (!agentId) return s.main;
    return s.subagents.find((a) => a.agentId === agentId);
  }

  async transcript(id: string, agentId?: string): Promise<TranscriptBuild | null> {
    const f = this.fileFor(id, agentId);
    if (!f) return null;
    const key = f.file;
    let st: fs.Stats;
    try {
      st = await fsp.stat(f.file);
    } catch {
      return null;
    }
    const hit = this.transcripts.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      this.transcripts.delete(key);
      this.transcripts.set(key, hit); // LRU bump
      return hit.build;
    }
    const build = await buildTranscript(f.file, { sessionId: id, agentId, isSubagent: !!agentId });
    this.transcripts.set(key, { size: st.size, mtimeMs: st.mtimeMs, build });
    while (this.transcripts.size > 6) this.transcripts.delete(this.transcripts.keys().next().value!);
    if (!agentId) this.corpora.set(key, { size: st.size, mtimeMs: st.mtimeMs, corpus: build.corpus });
    return build;
  }

  private corpora = new Map<string, { size: number; mtimeMs: number; corpus: CorpusEntry[] }>();

  /** Searchable text of a session, cached separately from full transcripts (much smaller). */
  async corpus(id: string): Promise<CorpusEntry[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    const hit = this.corpora.get(s.main.file);
    if (hit && hit.size === s.main.size && hit.mtimeMs === s.main.mtimeMs) return hit.corpus;
    const build = await buildTranscript(s.main.file, { sessionId: id });
    this.corpora.set(s.main.file, { size: s.main.size, mtimeMs: s.main.mtimeMs, corpus: build.corpus });
    return build.corpus;
  }
}

export function resumeInfo(cwd: string, id: string, cwdExists: boolean): ResumeInfo {
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    cwd,
    cwdExists,
    powershell: `cd ${psQuote(cwd)}; claude --resume ${id}`,
    cmd: `cd /d "${cwd}" && claude --resume ${id}`,
    bash: `cd ${shQuote(cwd)} && claude --resume ${id}`,
  };
}
