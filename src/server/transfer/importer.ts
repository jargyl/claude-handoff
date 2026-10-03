// Planning and executing an import from a staging area into ~/.claude.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DeviceInfo,
  HistoryEntry,
  ImportAction,
  ImportCandidate,
  ImportOptions,
  ImportPlan,
  ImportRequest,
  ImportResult,
  ImportResultItem,
} from '../../shared/types.js';
import { basename, canonicalPath, detectStyle, encodeProjectDir, joinPath, relativeUnder, samePath, type PathRule } from '../../shared/paths.js';
import type { SessionIndex } from '../claude/sessionIndex.js';
import { resumeInfo } from '../claude/sessionIndex.js';
import { dirExists, listMemoryFiles } from '../claude/locate.js';
import { readLines } from '../util/lines.js';
import { readJsonSync, writeJsonAtomic } from '../config.js';
import { renameRetry } from '../util/fsx.js';
import { compareIdentity } from './compare.js';
import { buildUuidMap, makeTransformer, type LineTransformer } from './transform.js';
import type { StagedSession, Staging, StagingStore } from './staging.js';

interface RememberedMapping {
  to: string;
  deviceId?: string;
  updatedAt: string;
}

export class MappingMemory {
  private data: Record<string, RememberedMapping>;
  constructor(private file: string) {
    this.data = readJsonSync(file, {} as Record<string, RememberedMapping>);
  }
  get(from: string): RememberedMapping | undefined {
    return this.data[canonicalPath(from)];
  }
  async remember(pairs: Array<{ from: string; to: string; deviceId?: string }>): Promise<void> {
    for (const p of pairs) {
      if (!p.from || !p.to) continue;
      this.data[canonicalPath(p.from)] = { to: p.to, deviceId: p.deviceId, updatedAt: new Date().toISOString() };
    }
    await writeJsonAtomic(this.file, this.data);
  }
}

export class HistoryStore {
  private entries: HistoryEntry[];
  constructor(private file: string) {
    this.entries = readJsonSync<HistoryEntry[]>(file, []);
  }
  list(): HistoryEntry[] {
    return this.entries;
  }
  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
  async add(e: HistoryEntry): Promise<void> {
    this.entries.unshift(e);
    this.entries = this.entries.slice(0, 200);
    await writeJsonAtomic(this.file, this.entries);
  }
  async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.entries);
  }
}

/** Guess the home directory a path lives under, from the path alone. */
export function inferHome(p: string): string | undefined {
  const win = p.match(/^([a-zA-Z]:\\Users\\[^\\]+)/i) ?? p.replace(/\//g, '\\').match(/^([a-zA-Z]:\\Users\\[^\\]+)/i);
  if (win) return win[1];
  const mac = p.match(/^(\/Users\/[^/]+)/);
  if (mac) return mac[1];
  const linux = p.match(/^(\/home\/[^/]+)/);
  if (linux) return linux[1];
  if (p.startsWith('/root')) return '/root';
  return undefined;
}

const DEV_ROOTS = [
  'Development',
  'development',
  'dev',
  'Dev',
  'code',
  'Code',
  'projects',
  'Projects',
  'src',
  'repos',
  'source/repos',
  'Documents/GitHub',
  'GitHub',
  'git',
  'workspace',
  'Workspace',
  'Documents',
  'Desktop',
  '',
];

function findByName(name: string, home: string): string | undefined {
  const lower = name.toLowerCase();
  for (const r of DEV_ROOTS) {
    const root = r ? path.join(home, ...r.split('/')) : home;
    if (!dirExists(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const direct = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === lower);
    if (direct) return path.join(root, direct.name);
    if (!r) continue; // don't scan the whole home dir one level deeper
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      try {
        const inner = fs.readdirSync(path.join(root, e.name), { withFileTypes: true }).find((x) => x.isDirectory() && x.name.toLowerCase() === lower);
        if (inner) return path.join(root, e.name, inner.name);
      } catch {
        /* unreadable */
      }
    }
  }
  return undefined;
}

export interface ImporterDeps {
  index: SessionIndex;
  staging: StagingStore;
  mappings: MappingMemory;
  history: HistoryStore;
  backupsDir: string;
  device: () => DeviceInfo;
  defaults: () => ImportOptions;
}

export class Importer {
  constructor(private d: ImporterDeps) {}

  // ------------------------------------------------------------ planning

  async suggest(
    srcPath: string,
    sessionIds: string[],
    src: DeviceInfo,
  ): Promise<{ to: string; reason: string; exists: boolean }> {
    const { index } = this.d;
    const localHome = os.homedir();
    // 1. The session already lives here
    for (const id of sessionIds) {
      const local = index.get(id);
      if (local) {
        const p = index.projectInfo(local.projectDir).path;
        return { to: p, reason: 'This session already exists here', exists: dirExists(p) };
      }
    }
    // 2. Remembered from an earlier import
    const remembered = this.d.mappings.get(srcPath);
    if (remembered && dirExists(remembered.to)) return { to: remembered.to, reason: 'Used last time', exists: true };
    // 3. Same path exists on this machine
    if (detectStyle(srcPath) === (process.platform === 'win32' ? 'windows' : 'posix') && dirExists(srcPath)) {
      return { to: srcPath, reason: 'Same folder exists here', exists: true };
    }
    // 4. Swap the home directory
    const srcHome = src.homeDir || inferHome(srcPath);
    let swapped: string | undefined;
    if (srcHome) {
      const rest = relativeUnder(srcPath, srcHome);
      if (rest !== null) {
        swapped = rest ? joinPath(localHome, ...rest.split('/')) : localHome;
        if (dirExists(swapped)) return { to: swapped, reason: 'Same place under your home folder', exists: true };
      }
    }
    // 5. A project with the same folder name
    const name = basename(srcPath);
    const known = (await index.projectsSummary()).filter((p) => basename(p.path).toLowerCase() === name.toLowerCase() && p.pathExists);
    if (known.length === 1) return { to: known[0]!.path, reason: `Found a project named ${name}`, exists: true };
    const found = findByName(name, localHome);
    if (found) return { to: found, reason: `Found a folder named ${name}`, exists: true };
    // 6. Fall back to the most plausible path, flagged as missing
    if (swapped) return { to: swapped, reason: 'Folder not found on this machine', exists: false };
    return { to: srcPath, reason: 'Folder not found on this machine', exists: dirExists(srcPath) };
  }

  async plan(st: Staging, overrides: Record<string, string> = {}): Promise<ImportPlan> {
    const { index } = this.d;
    const staged = await this.d.staging.sessions(st);
    const src = st.manifest.source;
    const groups = new Map<string, string[]>();
    for (const s of staged) {
      const key = s.projectPath;
      groups.set(key, [...(groups.get(key) ?? []), s.id]);
    }
    const mappings: ImportPlan['mappings'] = [];
    const resolved = new Map<string, string>();
    for (const [from, ids] of groups) {
      const override = overrides[from];
      if (override) {
        resolved.set(from, override);
        mappings.push({ from, to: override, reason: 'Chosen by you', exists: dirExists(override), sessions: ids.length });
      } else {
        const s = await this.suggest(from, ids, src);
        resolved.set(from, s.to);
        mappings.push({ from, to: s.to, reason: s.reason, exists: s.exists, sessions: ids.length });
      }
    }

    const candidates: ImportCandidate[] = staged.map((s) => this.candidate(s, resolved.get(s.projectPath) ?? s.projectPath));
    const memory: ImportPlan['memory'] = [];
    for (const m of await this.d.staging.memoryProjects(st)) {
      const fromManifest = st.manifest.memory.find((x) => x.projectDir === m.projectDir);
      const srcProject = fromManifest?.projectPath ?? staged.find((s) => s.projectDir === m.projectDir)?.projectPath;
      if (!srcProject) continue;
      const to = resolved.get(srcProject) ?? srcProject;
      const dir = index.findProjectDirForPath(to) ?? encodeProjectDir(to);
      memory.push({ projectPath: to, files: m.files.length, targetHasMemory: (await listMemoryFiles(index.layout, dir)).length > 0 });
    }
    const srcHome = src.homeDir || (staged[0] ? inferHome(staged[0].projectPath) : undefined);
    const warnings: string[] = [];
    if (staged.length === 0) warnings.push('No sessions found in what you added. Drop a bundle .zip or a session .jsonl file.');
    return {
      id: st.id,
      createdAt: st.createdAt,
      source: st.source,
      sourceDevice: src.id === 'unknown' ? undefined : src,
      candidates,
      mappings,
      homeRule: srcHome && !samePath(srcHome, os.homedir()) ? { from: srcHome, to: os.homedir() } : undefined,
      memory,
      warnings,
    };
  }

  private candidate(s: StagedSession, mappedTo: string): ImportCandidate {
    const { index } = this.d;
    const local = index.get(s.id);
    const warnings: string[] = [];
    let status: ImportCandidate['status'] = 'new';
    let suggested: ImportAction = 'import';
    let allowed: ImportAction[] = ['import', 'skip'];
    let targetPath = mappedTo;
    let liveHere = false;
    if (local) {
      status = compareIdentity(local.main.core, s.core);
      targetPath = index.projectInfo(local.projectDir).path;
      liveHere = index.live.has(s.id);
      switch (status) {
        case 'same':
          suggested = 'skip';
          allowed = ['skip', 'copy'];
          break;
        case 'incoming-ahead':
          suggested = 'update';
          allowed = ['update', 'copy', 'skip'];
          break;
        case 'local-ahead':
          suggested = 'skip';
          allowed = ['skip', 'copy', 'overwrite'];
          warnings.push('Your copy here is newer than this one.');
          break;
        default:
          suggested = 'copy';
          allowed = ['copy', 'overwrite', 'skip'];
          warnings.push('Both copies continued separately since they were last in sync.');
      }
      if (liveHere) {
        allowed = allowed.filter((a) => a !== 'update' && a !== 'overwrite');
        if (suggested === 'update') suggested = 'skip';
        warnings.push('This session is open in Claude Code here. Close it to update it.');
      }
    }
    const targetDir = (local && status !== 'new' ? local.projectDir : undefined) ?? index.findProjectDirForPath(targetPath) ?? encodeProjectDir(targetPath);
    const exists = dirExists(targetPath);
    if (!exists) warnings.push("The project folder doesn't exist here yet. Claude Code needs it to resume.");
    if (targetDir.length > 200) warnings.push('Very long project path: Claude Code may store it under a different folder name.');
    if (s.core.parseErrors) warnings.push(`${s.core.parseErrors} unreadable line(s) will be copied as-is.`);
    const { core: _core, mainFile: _main, ...session } = s;
    return {
      session,
      targetPath,
      targetDir,
      targetPathExists: exists,
      mappingReason: local ? 'Already here' : '',
      status,
      ...(local
        ? { local: { projectDir: local.projectDir, projectPath: index.projectInfo(local.projectDir).path, idCount: local.main.core.idSeq.length, mtimeMs: local.main.mtimeMs, live: liveHere } }
        : {}),
      suggestedAction: suggested,
      allowedActions: allowed,
      warnings,
    };
  }

  // ------------------------------------------------------------ commit

  async commit(st: Staging, req: ImportRequest): Promise<ImportResult> {
    const { index } = this.d;
    const plan = await this.plan(st, req.mappings);
    const staged = await this.d.staging.sessions(st);
    const options: ImportOptions = { ...this.d.defaults(), ...req.options };
    const src = st.manifest.source;
    const dst = this.d.device();
    const historyId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const backupRoot = path.join(this.d.backupsDir, historyId);
    const results: ImportResultItem[] = [];
    const entry: HistoryEntry = { id: historyId, at: new Date().toISOString(), source: st.source, items: [] };
    const mappingRules: PathRule[] = plan.mappings.map((m) => ({ from: m.from, to: req.mappings[m.from] ?? m.to }));
    const srcHome = src.homeDir || plan.homeRule?.from;

    for (const cand of plan.candidates) {
      const s = staged.find((x) => x.id === cand.session.id)!;
      const action: ImportAction = req.actions[s.id] ?? cand.suggestedAction;
      if (action === 'skip') continue;
      if (!cand.allowedActions.includes(action)) {
        results.push({ sessionId: s.id, title: s.title, action, ok: false, error: `“${action}” isn't possible for this session right now.`, targetPath: cand.targetPath, rewrites: 0 });
        continue;
      }
      try {
        const res = await this.importOne(s, cand, action, {
          options,
          rules: [
            ...mappingRules,
            ...(src.claudeDir ? [{ from: joinPath(src.claudeDir, 'projects', s.projectDir), to: path.join(index.layout.projects, cand.targetDir) }] : []),
            ...(src.claudeDir && dst.claudeDir ? [{ from: src.claudeDir, to: dst.claudeDir }] : []),
            ...(srcHome ? [{ from: srcHome, to: os.homedir() }] : []),
          ],
          backupRoot,
        });
        results.push(res.result);
        entry.items.push({
          sessionId: s.id,
          newSessionId: res.result.newSessionId,
          action,
          title: s.title,
          targetPath: cand.targetPath,
          createdFiles: res.created,
          ...(res.backedUp ? { backupDir: backupRoot } : {}),
        });
      } catch (e: any) {
        results.push({ sessionId: s.id, title: s.title, action, ok: false, error: e?.message ?? String(e), targetPath: cand.targetPath, rewrites: 0 });
      }
    }

    if (options.includeMemory) {
      for (const m of await this.d.staging.memoryProjects(st)) {
        const srcProject = st.manifest.memory.find((x) => x.projectDir === m.projectDir)?.projectPath ?? staged.find((x) => x.projectDir === m.projectDir)?.projectPath;
        if (!srcProject) continue;
        const to = req.mappings[srcProject] ?? plan.mappings.find((x) => x.from === srcProject)?.to ?? srcProject;
        const dir = index.findProjectDirForPath(to) ?? encodeProjectDir(to);
        if ((await listMemoryFiles(index.layout, dir)).length > 0) continue; // never merge into existing memory
        const created: string[] = [];
        for (const rel of m.files) {
          const inside = rel.split('/').slice(3); // projects/<dir>/memory/...
          const target = path.join(index.layout.projects, dir, 'memory', ...inside);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(path.join(st.filesDir, ...rel.split('/')), target);
          created.push(target);
        }
        if (created.length && entry.items[0]) entry.items[0].createdFiles.push(...created);
      }
    }

    if (entry.items.length) await this.d.history.add(entry);
    await this.d.mappings.remember(
      plan.mappings.map((m) => ({ from: m.from, to: req.mappings[m.from] ?? m.to, deviceId: src.id === 'unknown' ? undefined : src.id })),
    );
    if (results.every((r) => r.ok)) await this.d.staging.remove(st.id);
    await index.scanAll(true);
    return { historyId, items: results };
  }

  private async importOne(
    s: StagedSession,
    cand: ImportCandidate,
    action: ImportAction,
    ctx: { options: ImportOptions; rules: PathRule[]; backupRoot: string },
  ): Promise<{ result: ImportResultItem; created: string[]; backedUp: boolean }> {
    const { index } = this.d;
    const claude = index.layout.root;
    const targetDir = cand.targetDir;
    const newId = action === 'copy' ? crypto.randomUUID() : s.id;
    const created: string[] = [];
    let backedUp = false;
    const stagedRoot = path.dirname(path.dirname(path.dirname(s.mainFile))); // .../files

    // For copy mode, collect uuids across the main file and its subagents so references stay consistent.
    let copy: { fromId: string; toId: string; uuidMap: Map<string, string> } | undefined;
    const subFiles = s.files.filter((f) => f.startsWith(`projects/${s.projectDir}/${s.id}/subagents/`));
    if (action === 'copy') {
      const lines: string[] = [];
      for (const f of [s.files[0]!, ...subFiles.filter((x) => x.endsWith('.jsonl'))]) {
        for await (const l of readLines(path.join(stagedRoot, ...f.split('/')))) lines.push(l.text);
      }
      copy = { fromId: s.id, toId: newId, uuidMap: buildUuidMap(lines) };
    }
    const transformer = makeTransformer({ rules: ctx.rules, metadata: ctx.options.rewriteMetadata, content: ctx.options.rewriteContent, copy });

    // Where files go: the session keeps its folder when updating in place.
    const local = index.get(s.id);
    const writeDir = (action === 'update' || action === 'overwrite') && local ? local.projectDir : targetDir;
    const mapRel = (rel: string): string | null => {
      const parts = rel.split('/');
      if (parts[0] === 'projects') {
        // projects/<srcDir>/<id>.jsonl | projects/<srcDir>/<id>/...
        const rest = parts.slice(2);
        if (rest[0] === `${s.id}.jsonl`) rest[0] = `${newId}.jsonl`;
        else if (rest[0] === s.id) rest[0] = newId;
        return ['projects', writeDir, ...rest].join('/');
      }
      if (parts[0] === 'file-history') {
        if (!ctx.options.includeFileHistory) return null;
        return ['file-history', newId, ...parts.slice(2)].join('/');
      }
      if (parts[0] === 'todos') return ['todos', parts.slice(1).join('/').split(s.id).join(newId)].join('/');
      return null;
    };

    const writeFile = async (rel: string, abs: string, transform: LineTransformer | null) => {
      const target = path.join(claude, ...rel.split('/'));
      const existed = fs.existsSync(target);
      if (existed && rel.startsWith('file-history/')) return; // content-addressed: same name, same bytes
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (existed) {
        const backup = path.join(ctx.backupRoot, ...rel.split('/'));
        await fsp.mkdir(path.dirname(backup), { recursive: true });
        await fsp.copyFile(target, backup);
        backedUp = true;
      }
      const tmp = `${target}.handoff-tmp`;
      if (transform) {
        const out = fs.createWriteStream(tmp, { encoding: 'utf8' });
        for await (const l of readLines(abs)) {
          if (!l.complete && !l.text.trim()) continue;
          const ok = out.write(transform.apply(l.text) + '\n');
          if (!ok) await new Promise<void>((r) => out.once('drain', () => r()));
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      } else {
        await fsp.copyFile(abs, tmp);
      }
      await renameRetry(tmp, target);
      if (!existed) created.push(target);
    };

    const mainRel = mapRel(s.files[0]!)!;
    await writeFile(mainRel, s.mainFile, transformer);
    for (const rel of s.files.slice(1)) {
      const dest = mapRel(rel);
      if (!dest) continue;
      const abs = path.join(stagedRoot, ...rel.split('/'));
      await writeFile(dest, abs, rel.endsWith('.jsonl') ? transformer : null);
    }

    const targetPath = (action === 'update' || action === 'overwrite') && local ? index.projectInfo(local.projectDir).path : cand.targetPath;
    return {
      result: {
        sessionId: s.id,
        title: s.title,
        action,
        ok: true,
        ...(action === 'copy' ? { newSessionId: newId } : {}),
        targetPath,
        targetFile: path.join(claude, ...mainRel.split('/')),
        rewrites: transformer.rewrites(),
        ...(backedUp ? { backup: ctx.backupRoot } : {}),
        resume: resumeInfo(targetPath, newId, dirExists(targetPath)),
      },
      created,
      backedUp,
    };
  }

  // ------------------------------------------------------------ undo

  async undo(historyId: string): Promise<{ removed: number; restored: number }> {
    const entry = this.d.history.get(historyId);
    if (!entry) throw new Error('No such import');
    if (entry.undone) throw new Error('This import was already undone');
    let removed = 0;
    let restored = 0;
    const restoredDirs = new Set<string>();
    for (const item of entry.items) {
      for (const f of item.createdFiles) {
        try {
          await fsp.rm(f, { force: true });
          removed++;
        } catch {
          /* already gone */
        }
      }
      if (item.backupDir && !restoredDirs.has(item.backupDir) && fs.existsSync(item.backupDir)) {
        restoredDirs.add(item.backupDir);
        const claude = this.d.index.layout.root;
        const walk = async (dir: string, rel: string[]) => {
          for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) await walk(abs, [...rel, e.name]);
            else {
              const target = path.join(claude, ...rel, e.name);
              await fsp.mkdir(path.dirname(target), { recursive: true });
              await fsp.copyFile(abs, target);
              restored++;
            }
          }
        };
        await walk(item.backupDir, []);
      }
    }
    entry.undone = true;
    await this.d.history.save();
    await this.d.index.scanAll(true);
    return { removed, restored };
  }
}
