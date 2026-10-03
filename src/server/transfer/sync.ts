// A sync folder is any folder both machines can see: OneDrive, Dropbox, Google
// Drive, iCloud, Syncthing, a NAS share or a USB stick. Each machine pushes its
// sessions there; the other machine pulls them through the normal import review.
// Because sessions live there independently, it also works as an archive that
// survives Claude Code's automatic cleanup of old transcripts.
//
//   <folder>/handoff-sync.json
//   <folder>/devices/<deviceId>.json
//   <folder>/sessions/<sessionId>/session.json
//   <folder>/sessions/<sessionId>/files/projects/<dir>/<id>.jsonl (+ subagents, tool-results, file-history)

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeviceInfo, SyncFolderSession, SyncState, SyncStatus } from '../../shared/types.js';
import type { SessionIndex } from '../claude/sessionIndex.js';
import { listSessionSideFiles } from '../claude/locate.js';
import { hashIds, summarizeFile, type SessionCore } from '../claude/parse.js';
import { buildTranscript, type TranscriptBuild } from '../claude/transcript.js';
import type { SettingsStore } from '../config.js';
import { renameRetry, writeJsonAtomic } from '../util/fsx.js';
import { readCompleteLines } from './bundle.js';
import { copyTree, type Staging, type StagingStore } from './staging.js';
import type { EventHub } from '../events.js';

interface SyncSessionMeta {
  id: string;
  projectDir: string;
  projectPath: string;
  projectName: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: number;
  sizeBytes: number;
  idCount: number;
  idHash: string;
  pushedAt: string;
  pushedBy: DeviceInfo;
  files: string[];
}

export interface SyncDeps {
  index: SessionIndex;
  settings: SettingsStore;
  device: () => DeviceInfo;
  staging: StagingStore;
  events: EventHub;
}

const LIVE_PUSH_INTERVAL = 5 * 60_000;

export class SyncFolder {
  private coreCache = new Map<string, { size: number; mtimeMs: number; core: SessionCore }>();
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private lastPushed = new Map<string, number>();
  private lastPushAt?: string;
  private pushing = false;
  private unsub?: () => void;

  constructor(private d: SyncDeps) {}

  folder(): string | null {
    return this.d.settings.get().sync.folder;
  }

  private sessionsDir(): string {
    return path.join(this.folder()!, 'sessions');
  }

  async ensureLayout(): Promise<void> {
    const f = this.folder();
    if (!f) throw new Error('No sync folder set');
    await fsp.mkdir(path.join(f, 'sessions'), { recursive: true });
    await fsp.mkdir(path.join(f, 'devices'), { recursive: true });
    const marker = path.join(f, 'handoff-sync.json');
    if (!fs.existsSync(marker)) await writeJsonAtomic(marker, { format: 'claude-handoff-sync', version: 1, createdAt: new Date().toISOString() });
    await this.heartbeat();
  }

  async heartbeat(): Promise<void> {
    const f = this.folder();
    if (!f) return;
    const dev = this.d.device();
    try {
      await fsp.mkdir(path.join(f, 'devices'), { recursive: true });
      await writeJsonAtomic(path.join(f, 'devices', `${dev.id}.json`), { ...dev, lastSeen: new Date().toISOString() });
    } catch {
      /* folder offline */
    }
  }

  private async readMetas(): Promise<SyncSessionMeta[]> {
    const out: SyncSessionMeta[] = [];
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.sessionsDir());
    } catch {
      return out;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      try {
        const m = JSON.parse(await fsp.readFile(path.join(this.sessionsDir(), n, 'session.json'), 'utf8')) as SyncSessionMeta;
        if (m?.id === n) out.push(m);
      } catch {
        /* half-synced or foreign folder */
      }
    }
    return out;
  }

  private mainFile(m: SyncSessionMeta): string {
    return path.join(this.sessionsDir(), m.id, 'files', 'projects', m.projectDir, `${m.id}.jsonl`);
  }

  private async syncCore(m: SyncSessionMeta): Promise<SessionCore | null> {
    const file = this.mainFile(m);
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      return null;
    }
    const hit = this.coreCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.core;
    const core = await summarizeFile(file);
    this.coreCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, core });
    return core;
  }

  private async statusOf(m: SyncSessionMeta): Promise<SyncStatus> {
    const local = this.d.index.get(m.id);
    if (!local) return 'new';
    const l = local.main.core;
    const a = l.idSeq.length;
    if (a === m.idCount && l.idHash === m.idHash) return 'same';
    if (a > m.idCount) return hashIds(l.idSeq, m.idCount) === m.idHash ? 'local-ahead' : 'diverged';
    if (m.idCount > a) {
      const core = await this.syncCore(m);
      return core && hashIds(core.idSeq, a) === l.idHash ? 'incoming-ahead' : 'diverged';
    }
    return 'diverged';
  }

  private inScope(id: string): boolean {
    const mode = this.d.settings.get().sync.autoPush;
    if (mode === 'all') return true;
    if (mode === 'starred') return this.d.index.listItem(this.d.index.get(id)!).starred;
    return false;
  }

  async state(): Promise<SyncState> {
    const s = this.d.settings.get().sync;
    const base: SyncState = { folder: s.folder, exists: false, writable: false, autoPush: s.autoPush, lastPushAt: this.lastPushAt, sessions: [], devices: [], pendingPush: 0 };
    if (!s.folder) return base;
    try {
      const st = await fsp.stat(s.folder);
      base.exists = st.isDirectory();
    } catch {
      base.error = "The sync folder can't be found. Is the drive connected?";
      return base;
    }
    try {
      await fsp.access(s.folder, fs.constants.W_OK);
      base.writable = true;
    } catch {
      base.error = "The sync folder isn't writable.";
    }
    const metas = await this.readMetas();
    const inFolder = new Set<string>();
    for (const m of metas) {
      inFolder.add(m.id);
      const status = await this.statusOf(m);
      const local = this.d.index.get(m.id);
      const v: SyncFolderSession = {
        id: m.id,
        projectPath: m.projectPath,
        projectName: m.projectName,
        title: m.title,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        userMessages: m.userMessages,
        sizeBytes: m.sizeBytes,
        idCount: m.idCount,
        idHash: m.idHash,
        live: false,
        status,
        pushedAt: m.pushedAt,
        pushedBy: { id: m.pushedBy.id, name: m.pushedBy.name },
        ...(local ? { localProjectPath: this.d.index.projectInfo(local.projectDir).path } : {}),
      };
      base.sessions.push(v);
      if (status === 'local-ahead') base.pendingPush++;
    }
    for (const l of this.d.index.all()) if (!inFolder.has(l.id) && this.inScopeOrAll(l.id)) base.pendingPush++;
    base.sessions.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    try {
      for (const n of await fsp.readdir(path.join(s.folder, 'devices'))) {
        if (!n.endsWith('.json')) continue;
        try {
          const dvc = JSON.parse(await fsp.readFile(path.join(s.folder, 'devices', n), 'utf8'));
          base.devices.push({ id: dvc.id, name: dvc.name, platform: dvc.platform, lastSeen: dvc.lastSeen });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* none yet */
    }
    return base;
  }

  private inScopeOrAll(id: string): boolean {
    return this.d.settings.get().sync.autoPush === 'off' ? true : this.inScope(id);
  }

  /** Copy sessions into the sync folder. Never overwrites a newer or diverged copy unless forced. */
  async push(ids: string[], opts: { force?: boolean } = {}): Promise<{ pushed: string[]; skipped: Array<{ id: string; reason: string }> }> {
    await this.ensureLayout();
    const metas = new Map((await this.readMetas()).map((m) => [m.id, m]));
    const pushed: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const dev = this.d.device();
    const withHistory = this.d.settings.get().importDefaults.includeFileHistory;
    for (const id of ids) {
      const s = this.d.index.get(id);
      if (!s) {
        skipped.push({ id, reason: 'Not found on this device' });
        continue;
      }
      const existing = metas.get(id);
      if (existing) {
        const status = await this.statusOf(existing);
        if (status === 'same') {
          skipped.push({ id, reason: 'Already up to date' });
          continue;
        }
        if (!opts.force && status === 'incoming-ahead') {
          skipped.push({ id, reason: 'The sync folder has a newer copy. Pull it first.' });
          continue;
        }
        if (!opts.force && status === 'diverged') {
          skipped.push({ id, reason: 'The copy in the sync folder continued separately. Pull it as a copy, or force push.' });
          continue;
        }
      }
      const item = this.d.index.listItem(s);
      const tmp = path.join(this.sessionsDir(), `.tmp-${id}-${crypto.randomBytes(3).toString('hex')}`);
      const filesDir = path.join(tmp, 'files');
      const mainRel = `projects/${s.projectDir}/${id}.jsonl`;
      const files = [mainRel];
      try {
        await fsp.mkdir(path.join(filesDir, 'projects', s.projectDir), { recursive: true });
        await fsp.writeFile(path.join(filesDir, ...mainRel.split('/')), await readCompleteLines(s.main.file));
        for (const f of await listSessionSideFiles(this.d.index.layout, s.projectDir, id, { fileHistory: withHistory })) {
          const target = path.join(filesDir, ...f.rel.split('/'));
          await fsp.mkdir(path.dirname(target), { recursive: true });
          if (f.rel.endsWith('.jsonl')) await fsp.writeFile(target, await readCompleteLines(f.abs));
          else await fsp.copyFile(f.abs, target);
          files.push(f.rel);
        }
        const meta: SyncSessionMeta = {
          id,
          projectDir: s.projectDir,
          projectPath: item.projectPath,
          projectName: item.projectName,
          title: item.title,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          userMessages: item.userMessages,
          sizeBytes: item.sizeBytes,
          idCount: item.idCount,
          idHash: item.idHash,
          pushedAt: new Date().toISOString(),
          pushedBy: dev,
          files,
        };
        await writeJsonAtomic(path.join(tmp, 'session.json'), meta);
        const final = path.join(this.sessionsDir(), id);
        if (fs.existsSync(final)) {
          const old = path.join(this.sessionsDir(), `.old-${id}-${crypto.randomBytes(3).toString('hex')}`);
          await renameRetry(final, old);
          await renameRetry(tmp, final);
          await fsp.rm(old, { recursive: true, force: true });
        } else {
          await renameRetry(tmp, final);
        }
        pushed.push(id);
        this.lastPushed.set(id, Date.now());
      } catch (e: any) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => void 0);
        skipped.push({ id, reason: e?.message ?? String(e) });
      }
    }
    if (pushed.length) {
      this.lastPushAt = new Date().toISOString();
      await this.heartbeat();
    }
    return { pushed, skipped };
  }

  /** Stage sessions from the sync folder for the import review (one staging per pushing device). */
  async pull(ids: string[]): Promise<Staging[]> {
    const metas = (await this.readMetas()).filter((m) => ids.includes(m.id));
    const byDevice = new Map<string, SyncSessionMeta[]>();
    for (const m of metas) byDevice.set(m.pushedBy.id, [...(byDevice.get(m.pushedBy.id) ?? []), m]);
    const out: Staging[] = [];
    for (const list of byDevice.values()) {
      const dev = list[0]!.pushedBy;
      const st = await this.d.staging.create({ kind: 'sync', label: `Sync folder (from ${dev.name})`, deviceId: dev.id, deviceName: dev.name });
      st.manifest.source = dev;
      for (const m of list) {
        await copyTree(path.join(this.sessionsDir(), m.id, 'files'), st.filesDir, () => true);
        st.manifest.sessions.push({
          id: m.id,
          projectDir: m.projectDir,
          projectPath: m.projectPath,
          title: m.title,
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          userMessages: m.userMessages,
          sizeBytes: m.sizeBytes,
          idCount: m.idCount,
          idHash: m.idHash,
          files: m.files,
        });
      }
      await this.d.staging.saveMeta(st);
      out.push(st);
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Bad id');
    await fsp.rm(path.join(this.sessionsDir(), id), { recursive: true, force: true });
  }

  async transcript(id: string): Promise<TranscriptBuild | null> {
    const m = (await this.readMetas()).find((x) => x.id === id);
    if (!m) return null;
    return buildTranscript(this.mainFile(m), { sessionId: id });
  }

  // ------------------------------------------------------------ auto push

  start(): void {
    this.unsub?.();
    const onSessions = (e: { changed: string[] }) => {
      if (this.d.settings.get().sync.autoPush === 'off' || !this.folder()) return;
      for (const id of e.changed) this.pending.add(id);
      this.schedule(15_000);
    };
    this.d.index.on('sessions', onSessions);
    this.unsub = () => this.d.index.off('sessions', onSessions);
    void this.heartbeat();
    // catch up on anything that changed while we weren't running
    setTimeout(() => void this.catchUp(), 5000);
  }

  stop(): void {
    this.unsub?.();
    clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), ms);
  }

  async catchUp(): Promise<void> {
    if (this.d.settings.get().sync.autoPush === 'off' || !this.folder()) return;
    for (const s of this.d.index.all()) this.pending.add(s.id);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pushing) return this.schedule(10_000);
    const mode = this.d.settings.get().sync.autoPush;
    if (mode === 'off' || !this.folder()) {
      this.pending.clear();
      return;
    }
    const now = Date.now();
    const ready: string[] = [];
    for (const id of this.pending) {
      if (!this.d.index.get(id) || !this.inScope(id)) {
        this.pending.delete(id);
        continue;
      }
      const live = this.d.index.live.has(id);
      if (live && now - (this.lastPushed.get(id) ?? 0) < LIVE_PUSH_INTERVAL) continue; // retry later
      ready.push(id);
      this.pending.delete(id);
    }
    if (ready.length) {
      this.pushing = true;
      try {
        const { pushed } = await this.push(ready);
        if (pushed.length) this.d.events.emit({ type: 'sync', pendingPush: this.pending.size, lastPushAt: this.lastPushAt });
      } catch {
        /* folder offline: try again on the next change */
      } finally {
        this.pushing = false;
      }
    }
    if (this.pending.size) this.schedule(60_000);
  }
}
