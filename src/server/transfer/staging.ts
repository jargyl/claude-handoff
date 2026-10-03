// Incoming sessions wait in an inbox (staging area) until the user reviews where
// they should go. Uploads, pulls from a device, pulls from the sync folder and
// pushes from another device all end up here in the same shape:
//
//   inbox/<id>/meta.json   source + manifest
//   inbox/<id>/files/...   Claude-layout copy (projects/<dir>/<session>.jsonl, ...)

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BundleManifest, BundleSession, DeviceInfo, StagingSourceInfo } from '../../shared/types.js';
import { encodeProjectDir, naiveDecodeProjectDir, sameEncodedDir } from '../../shared/paths.js';
import { summarizeFile, type SessionCore } from '../claude/parse.js';
import { readLines, tryParse } from '../util/lines.js';
import { extractZip } from './bundle.js';
import { writeJsonAtomic } from '../config.js';
import { isUuid } from '../claude/locate.js';

export interface StagedSession extends BundleSession {
  core: SessionCore;
  mainFile: string; // absolute path inside staging
}

export interface Staging {
  id: string;
  dir: string;
  filesDir: string;
  createdAt: string;
  source: StagingSourceInfo;
  manifest: BundleManifest;
}

interface StagingMeta {
  id: string;
  createdAt: string;
  source: StagingSourceInfo;
  manifest: BundleManifest;
}

const UNKNOWN_DEVICE: DeviceInfo = { id: 'unknown', name: 'Unknown device', platform: 'unknown', homeDir: '', claudeDir: '', app: 'unknown', version: '' };

export class StagingStore {
  constructor(private root: string) {}

  private dirOf(id: string) {
    if (!/^[a-z0-9-]{8,64}$/i.test(id)) throw new Error('Bad staging id');
    return path.join(this.root, id);
  }

  async create(source: StagingSourceInfo): Promise<Staging> {
    const id = crypto.randomUUID();
    const dir = this.dirOf(id);
    const filesDir = path.join(dir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    const meta: StagingMeta = {
      id,
      createdAt: new Date().toISOString(),
      source,
      manifest: { format: 'claude-handoff-bundle', version: 1, createdAt: new Date().toISOString(), source: UNKNOWN_DEVICE, sessions: [], memory: [] },
    };
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    return { ...meta, dir, filesDir };
  }

  async get(id: string): Promise<Staging | null> {
    let dir: string;
    try {
      dir = this.dirOf(id);
    } catch {
      return null;
    }
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) as StagingMeta;
      return { ...meta, dir, filesDir: path.join(dir, 'files') };
    } catch {
      return null;
    }
  }

  async list(): Promise<Staging[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return [];
    }
    const out: Staging[] = [];
    for (const n of names) {
      const s = await this.get(n);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<void> {
    await fsp.rm(this.dirOf(id), { recursive: true, force: true });
  }

  async saveMeta(s: Staging): Promise<void> {
    const meta: StagingMeta = { id: s.id, createdAt: s.createdAt, source: s.source, manifest: s.manifest };
    await writeJsonAtomic(path.join(s.dir, 'meta.json'), meta);
  }

  /** Add an uploaded file: a bundle zip, a session .jsonl, or a subagent .jsonl. */
  async addFile(s: Staging, data: Uint8Array, filename: string): Promise<void> {
    const lower = filename.toLowerCase();
    const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
    if (isZip) {
      const tmp = path.join(s.dir, `unzip-${Date.now()}`);
      await fsp.mkdir(tmp, { recursive: true });
      const written = await extractZip(data, tmp);
      if (written.includes('manifest.json')) {
        try {
          const m = JSON.parse(await fsp.readFile(path.join(tmp, 'manifest.json'), 'utf8')) as BundleManifest;
          if (m?.format === 'claude-handoff-bundle') {
            if (s.manifest.source.id === 'unknown') s.manifest.source = m.source;
            s.manifest.memory.push(...(m.memory ?? []));
            for (const sess of m.sessions ?? []) {
              if (!s.manifest.sessions.some((x) => x.id === sess.id)) s.manifest.sessions.push(sess);
            }
          }
        } catch {
          /* ignore a broken manifest; files are re-scanned anyway */
        }
      }
      await copyTree(tmp, s.filesDir, (rel) => rel !== 'manifest.json' && rel !== 'README.txt');
      await fsp.rm(tmp, { recursive: true, force: true });
    } else if (lower.endsWith('.jsonl')) {
      await this.addJsonl(s, Buffer.from(data), filename);
    } else {
      throw new Error(`${filename} isn't a session file. Drop a .zip bundle or a .jsonl transcript.`);
    }
    await this.saveMeta(s);
  }

  private async addJsonl(s: Staging, data: Buffer, filename: string): Promise<void> {
    // Peek at the lines for sessionId and cwd.
    const text = data.toString('utf8');
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let isSidechain = false;
    let parent: string | undefined;
    for (const raw of text.split('\n', 400)) {
      const o = tryParse(raw);
      if (!o) continue;
      if (!sessionId && typeof o.sessionId === 'string') sessionId = o.sessionId;
      if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
      if (o.isSidechain === true) isSidechain = true;
      if (o.type === 'fork-context-ref' && typeof o.parentSessionId === 'string') parent = o.parentSessionId;
      if (sessionId && cwd) break;
    }
    const base = path.basename(filename).replace(/\.jsonl$/i, '');
    if (base.startsWith('agent-') || (isSidechain && parent)) {
      const owner = parent ?? sessionId;
      if (!owner) throw new Error(`${filename}: can't tell which session this subagent belongs to.`);
      const dir = await this.findProjectDirOf(s, owner, cwd);
      const target = path.join(s.filesDir, 'projects', dir, owner, 'subagents', `${base}.jsonl`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data);
      return;
    }
    const id = isUuid(base) ? base : sessionId;
    if (!id || !isUuid(id)) throw new Error(`${filename}: no session id found in the file.`);
    const dir = cwd ? encodeProjectDir(cwd) : 'unknown-project';
    const target = path.join(s.filesDir, 'projects', dir, `${id}.jsonl`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }

  private async findProjectDirOf(s: Staging, sessionId: string, cwd?: string): Promise<string> {
    const projects = path.join(s.filesDir, 'projects');
    try {
      for (const d of await fsp.readdir(projects)) {
        if (fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`))) return d;
      }
    } catch {
      /* empty */
    }
    return cwd ? encodeProjectDir(cwd) : 'unknown-project';
  }

  /** Copy a directory that already has the Claude layout (sync folder entry) into staging. */
  async addTree(s: Staging, srcFilesDir: string): Promise<void> {
    await copyTree(srcFilesDir, s.filesDir, () => true);
  }

  /** Scan the staged files and describe every session in them. */
  async sessions(s: Staging): Promise<StagedSession[]> {
    const out: StagedSession[] = [];
    const projects = path.join(s.filesDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = await fsp.readdir(projects);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fsp.readdir(path.join(projects, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.startsWith('agent-')) continue;
        const id = name.slice(0, -6);
        const mainFile = path.join(projects, dir, name);
        const core = await summarizeFile(mainFile);
        const fromManifest = s.manifest.sessions.find((x) => x.id === id);
        const matching = [...core.cwds].reverse().find((c) => sameEncodedDir(encodeProjectDir(c), dir));
        const projectPath = fromManifest?.projectPath ?? matching ?? core.cwds[core.cwds.length - 1] ?? naiveDecodeProjectDir(dir);
        const files: string[] = [];
        const sideRoot = path.join(projects, dir, id);
        await listRel(sideRoot, `projects/${dir}/${id}`, files);
        await listRel(path.join(s.filesDir, 'file-history', id), `file-history/${id}`, files);
        const st = await fsp.stat(mainFile);
        out.push({
          id,
          projectDir: dir,
          projectPath,
          title: core.customTitle ?? core.aiTitle ?? core.summaryTitle ?? fromManifest?.title ?? core.firstPrompt?.slice(0, 90) ?? 'Untitled session',
          startedAt: core.startedAt,
          endedAt: core.endedAt,
          userMessages: core.userMessages,
          sizeBytes: st.size,
          idCount: core.idSeq.length,
          idHash: core.idHash,
          files: [`projects/${dir}/${name}`, ...files],
          core,
          mainFile,
        });
      }
    }
    return out.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  }

  async memoryProjects(s: Staging): Promise<Array<{ projectDir: string; files: string[] }>> {
    const out: Array<{ projectDir: string; files: string[] }> = [];
    const projects = path.join(s.filesDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = await fsp.readdir(projects);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      const files: string[] = [];
      await listRel(path.join(projects, dir, 'memory'), `projects/${dir}/memory`, files);
      if (files.length) out.push({ projectDir: dir, files });
    }
    return out;
  }
}

async function listRel(abs: string, rel: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await listRel(path.join(abs, e.name), `${rel}/${e.name}`, out);
    else if (e.isFile()) out.push(`${rel}/${e.name}`);
  }
}

export async function copyTree(src: string, dest: string, filter: (rel: string) => boolean, rel = ''): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyTree(from, to, filter, r);
    else if (e.isFile() && filter(r)) {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
    }
  }
}

/** Count lines of a staged JSONL (used for previews). */
export async function countLines(file: string): Promise<number> {
  let n = 0;
  for await (const _ of readLines(file)) n++;
  return n;
}
