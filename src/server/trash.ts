// Deleting a session moves its files here first, so a mistake can be undone.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionIndex } from './claude/sessionIndex.js';
import { listSessionSideFiles } from './claude/locate.js';
import { renameRetry, writeJsonAtomic } from './util/fsx.js';

export interface TrashEntry {
  id: string;
  sessionId: string;
  title: string;
  projectPath: string;
  deletedAt: string;
  files: string[]; // relative to the Claude dir
  sizeBytes: number;
}

async function move(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await renameRetry(from, to);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

export class Trash {
  constructor(
    private root: string,
    private index: SessionIndex,
  ) {}

  async trash(sessionId: string): Promise<TrashEntry> {
    const s = this.index.get(sessionId);
    if (!s) throw new Error('Session not found');
    if (this.index.live.has(sessionId)) throw new Error('This session is open in Claude Code. Close it first.');
    const item = this.index.listItem(s);
    const claude = this.index.layout.root;
    const rels = [`projects/${s.projectDir}/${s.id}.jsonl`, ...(await listSessionSideFiles(this.index.layout, s.projectDir, s.id)).map((f) => f.rel)];
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${s.id.slice(0, 8)}`;
    const dir = path.join(this.root, id);
    const moved: string[] = [];
    for (const rel of rels) {
      const from = path.join(claude, ...rel.split('/'));
      if (!fs.existsSync(from)) continue;
      await move(from, path.join(dir, 'files', ...rel.split('/')));
      moved.push(rel);
    }
    // tidy now-empty session folder
    await fsp.rm(path.join(claude, 'projects', s.projectDir, s.id), { recursive: true, force: true }).catch(() => void 0);
    const entry: TrashEntry = { id, sessionId: s.id, title: item.title, projectPath: item.projectPath, deletedAt: new Date().toISOString(), files: moved, sizeBytes: item.sizeBytes };
    await writeJsonAtomic(path.join(dir, 'entry.json'), entry);
    await this.index.scanAll(true);
    return entry;
  }

  async list(): Promise<TrashEntry[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.root);
    } catch {
      return [];
    }
    const out: TrashEntry[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await fsp.readFile(path.join(this.root, n, 'entry.json'), 'utf8')));
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  private dirOf(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Bad id');
    return path.join(this.root, id);
  }

  async restore(id: string): Promise<void> {
    const dir = this.dirOf(id);
    const entry = JSON.parse(await fsp.readFile(path.join(dir, 'entry.json'), 'utf8')) as TrashEntry;
    const claude = this.index.layout.root;
    const main = path.join(claude, ...entry.files[0]!.split('/'));
    if (fs.existsSync(main)) throw new Error('A session with this id exists again. Delete it first or keep both.');
    for (const rel of entry.files) await move(path.join(dir, 'files', ...rel.split('/')), path.join(claude, ...rel.split('/')));
    await fsp.rm(dir, { recursive: true, force: true });
    await this.index.scanAll(true);
  }

  async purge(id?: string): Promise<void> {
    if (id) await fsp.rm(this.dirOf(id), { recursive: true, force: true });
    else await fsp.rm(this.root, { recursive: true, force: true });
  }
}
