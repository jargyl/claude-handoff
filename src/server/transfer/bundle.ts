// Bundles are plain .zip files that mirror the layout of ~/.claude, plus a
// manifest. Without this app on the other side you can still unzip one into
// ~/.claude (as long as the project path is the same there).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { BundleManifest, BundleSession, DeviceInfo } from '../../shared/types.js';
import { listMemoryFiles, listSessionSideFiles, type ClaudeLayout } from '../claude/locate.js';
import type { SessionIndex } from '../claude/sessionIndex.js';

export interface BundleEntry {
  rel: string;
  abs: string;
  /** JSONL files are cut at the last complete line (the session may be live) */
  jsonl: boolean;
}

export interface BundlePlan {
  manifest: BundleManifest;
  entries: BundleEntry[];
  totalBytes: number;
}

export interface BundleOptions {
  fileHistory: boolean;
  memory: boolean;
}

export async function planBundle(index: SessionIndex, ids: string[], device: DeviceInfo, opts: BundleOptions): Promise<BundlePlan> {
  const layout: ClaudeLayout = index.layout;
  const sessions: BundleSession[] = [];
  const entries: BundleEntry[] = [];
  const memoryDirs = new Map<string, string>();
  let totalBytes = 0;
  for (const id of ids) {
    const s = index.get(id);
    if (!s) continue;
    const item = index.listItem(s);
    const mainRel = `projects/${s.projectDir}/${s.id}.jsonl`;
    const files = [mainRel];
    entries.push({ rel: mainRel, abs: s.main.file, jsonl: true });
    totalBytes += s.main.size;
    for (const f of await listSessionSideFiles(layout, s.projectDir, s.id, { fileHistory: opts.fileHistory })) {
      entries.push({ rel: f.rel, abs: f.abs, jsonl: f.rel.endsWith('.jsonl') });
      files.push(f.rel);
      totalBytes += f.size;
    }
    sessions.push({
      id: s.id,
      projectDir: s.projectDir,
      projectPath: item.projectPath,
      title: item.title,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      userMessages: item.userMessages,
      sizeBytes: item.sizeBytes,
      idCount: item.idCount,
      idHash: item.idHash,
      files,
    });
    if (opts.memory) memoryDirs.set(s.projectDir, item.projectPath);
  }
  const memory: BundleManifest['memory'] = [];
  for (const [dir, projectPath] of memoryDirs) {
    const files = await listMemoryFiles(layout, dir);
    if (!files.length) continue;
    memory.push({ projectDir: dir, projectPath, files: files.map((f) => f.rel) });
    for (const f of files) {
      entries.push({ rel: f.rel, abs: f.abs, jsonl: false });
      totalBytes += f.size;
    }
  }
  return {
    manifest: { format: 'claude-handoff-bundle', version: 1, createdAt: new Date().toISOString(), source: device, sessions, memory },
    entries,
    totalBytes,
  };
}

/** Read a JSONL file up to its last complete line. */
export async function readCompleteLines(abs: string): Promise<Buffer> {
  const buf = await fsp.readFile(abs);
  const last = buf.lastIndexOf(10);
  if (last === buf.length - 1 || buf.length === 0) return buf;
  return last === -1 ? Buffer.alloc(0) : buf.subarray(0, last + 1);
}

const README = (m: BundleManifest) => `Claude Code sessions exported by Claude Handoff
Created ${m.createdAt} on ${m.source.name} (${m.source.platform})

Sessions:
${m.sessions.map((s) => `  - ${s.title}\n    ${s.id}  (${s.projectPath})`).join('\n')}

To import: open Claude Handoff on the other machine and drop this zip on it.
It lets you pick where each project lives there and fixes the paths for you.

Without Handoff: unzip into your Claude folder (~/.claude). That only works
if the project lives at exactly the same path on both machines, because Claude
Code finds sessions by project path. Then run:  claude --resume <session id>
`;

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** Stream a bundle as a zip, compressing incrementally so the server stays responsive. */
export function streamBundle(plan: BundlePlan): ReadableStream<Uint8Array> {
  const queue: Uint8Array[] = [];
  let finished = false;
  let failure: unknown;
  let wake: (() => void) | null = null;
  let drained: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const zip = new Zip((err, data, final) => {
    if (err) failure = err;
    else {
      queue.push(data);
      if (final) finished = true;
    }
    signal();
  });

  const waitForRoom = async () => {
    while (queue.length > 32 && !failure) await new Promise<void>((r) => (drained = r));
  };

  const addBuffer = async (name: string, data: Uint8Array, store = false) => {
    const f = store ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(f);
    const CHUNK = 1 << 20;
    if (data.length === 0) {
      f.push(new Uint8Array(0), true);
      return;
    }
    for (let i = 0; i < data.length; i += CHUNK) {
      f.push(data.subarray(i, Math.min(i + CHUNK, data.length)), i + CHUNK >= data.length);
      await waitForRoom();
      await yieldLoop();
    }
  };

  (async () => {
    await addBuffer('manifest.json', strToU8(JSON.stringify(plan.manifest, null, 2)));
    await addBuffer('README.txt', strToU8(README(plan.manifest)));
    for (const e of plan.entries) {
      let data: Uint8Array;
      try {
        data = e.jsonl ? await readCompleteLines(e.abs) : await fsp.readFile(e.abs);
      } catch {
        continue; // vanished since planning
      }
      const isCompressed = /\.(png|jpe?g|gif|webp|zip|gz|woff2?)$/i.test(e.rel);
      await addBuffer(e.rel, data, isCompressed);
    }
    zip.end();
  })().catch((e) => {
    failure = e;
    signal();
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queue.length === 0 && !finished && !failure) await new Promise<void>((r) => (wake = r));
      if (failure) {
        controller.error(failure);
        return;
      }
      const chunk = queue.shift();
      if (queue.length <= 8 && drained) {
        const d = drained;
        drained = null;
        (d as () => void)();
      }
      if (chunk) controller.enqueue(chunk);
      else if (finished) controller.close();
    },
  });
}

export async function bundleToBuffer(plan: BundlePlan): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = streamBundle(plan).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- extraction

const ALLOWED_ROOTS = ['projects/', 'file-history/', 'todos/'];

/** Validate a zip entry name; returns the normalized relative path or null if unsafe/unwanted. */
export function safeEntryName(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.endsWith('/')) return null; // directory entry
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  if (n === 'manifest.json' || n === 'README.txt') return n;
  if (!ALLOWED_ROOTS.some((r) => n.startsWith(r))) return null;
  return n;
}

/**
 * Extract a bundle zip into dest. Bundles exported from Claude Handoff have the
 * Claude layout at the root; zips made by hand often wrap it in a folder
 * (e.g. ".claude/projects/..."), so a single leading folder is stripped when
 * that makes the layout line up.
 */
export async function extractZip(data: Uint8Array, dest: string): Promise<string[]> {
  const files = new Map<string, Uint8Array[]>();
  const done: Array<{ name: string; data: Buffer }> = [];
  const uz = new Unzip((file) => {
    const chunks: Uint8Array[] = [];
    files.set(file.name, chunks);
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      chunks.push(chunk);
      if (final) done.push({ name: file.name, data: Buffer.concat(chunks) });
    };
    file.start();
  });
  uz.register(UnzipInflate);
  const CHUNK = 1 << 20;
  for (let i = 0; i < data.length; i += CHUNK) {
    uz.push(data.subarray(i, Math.min(i + CHUNK, data.length)), i + CHUNK >= data.length);
    if (i % (8 * CHUNK) === 0) await yieldLoop();
  }
  // Detect a wrapper folder: every entry shares one first segment and stripping it exposes projects/.
  const names = done.map((d) => d.name.replace(/\\/g, '/')).filter((n) => !n.endsWith('/'));
  let strip = '';
  const firsts = new Set(names.map((n) => n.split('/')[0]));
  if (firsts.size === 1 && !names.some((n) => n.startsWith('projects/'))) {
    const first = [...firsts][0]!;
    if (names.some((n) => n.startsWith(`${first}/projects/`))) strip = `${first}/`;
  }
  const written: string[] = [];
  for (const d of done) {
    let n = d.name.replace(/\\/g, '/');
    if (strip && n.startsWith(strip)) n = n.slice(strip.length);
    const safe = safeEntryName(n);
    if (!safe) continue;
    const target = path.join(dest, ...safe.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, d.data);
    written.push(safe);
  }
  return written;
}

export function bundleFileName(sessions: number, deviceName: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const host = deviceName.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 24) || os.hostname();
  return `claude-sessions-${host}-${stamp}-${sessions}.zip`;
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
