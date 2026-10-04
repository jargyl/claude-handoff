// Run a project: find how it starts (package.json scripts, manage.py, a .csproj, ...),
// run it with its output kept here, spot the local URL it prints, and stop it again.
// Processes belong to Handoff: quitting Handoff stops them.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CustomRunCommand, RunCommand, RunInfo, RunKind, RunLog, RunLogLine } from '../shared/types.js';
import { readJsonSync, writeJsonAtomic } from './config.js';

const WIN = process.platform === 'win32';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'coverage', '__pycache__', 'venv', 'env']);

export const EXTENSIONS_PAGE = 'chrome://extensions';

const idFor = (cwd: string, command: string) => createHash('sha1').update(`${cwd}\0${command}`).digest('hex').slice(0, 12);

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string, max = 64 * 1024): Promise<string | null> {
  try {
    const h = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(max);
      const { bytesRead } = await h.read(buf, 0, max, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ detection

type Found = Omit<RunCommand, 'id' | 'cwd' | 'source'> & { source: string };

const SCRIPT_ORDER = ['dev', 'develop', 'start', 'serve', 'watch', 'preview', 'build', 'test', 'lint'];

function scriptKind(name: string): RunKind {
  if (/^(dev|develop|serve|watch)(:|$)/.test(name)) return 'dev';
  if (/^(start|preview)(:|$)/.test(name)) return 'start';
  if (/^build(:|$)/.test(name)) return 'build';
  if (/^test(:|$)/.test(name)) return 'test';
  return 'other';
}

async function packageManager(dir: string, root: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  for (const d of dir === root ? [dir] : [dir, root]) {
    if (await exists(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await exists(path.join(d, 'yarn.lock'))) return 'yarn';
    if ((await exists(path.join(d, 'bun.lockb'))) || (await exists(path.join(d, 'bun.lock')))) return 'bun';
    if (await exists(path.join(d, 'package-lock.json'))) return 'npm';
  }
  return 'npm';
}

function scriptCommand(pm: string, name: string): string {
  if (pm === 'npm') return name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${name}`;
  if (pm === 'bun') return `bun run ${name}`;
  return `${pm} ${name}`;
}

async function detectNode(dir: string, root: string): Promise<Found[]> {
  const raw = await readText(path.join(dir, 'package.json'), 512 * 1024);
  if (raw === null) return [];
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }
  const scripts: Record<string, unknown> = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = await packageManager(dir, root);
  const installed = (await exists(path.join(dir, 'node_modules'))) || (dir !== root && (await exists(path.join(root, 'node_modules'))));
  const install = installed ? undefined : `${pm} install`;
  const names = Object.keys(scripts).filter((n) => typeof scripts[n] === 'string' && !/^(pre|post)/.test(n) && n !== 'prepare');
  const rank = (n: string) => {
    const i = SCRIPT_ORDER.indexOf(n.split(':')[0]!);
    return i === -1 ? SCRIPT_ORDER.length : i;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const out: Found[] = names.slice(0, 14).map((n) => ({
    label: n,
    command: scriptCommand(pm, n),
    kind: scriptKind(n),
    source: `package.json: ${String(scripts[n]).slice(0, 120)}`,
    ...(install ? { install } : {}),
  }));
  if (install) out.push({ label: 'Install dependencies', command: install, kind: 'install', source: 'package.json' });
  return out;
}

async function pythonFor(dir: string): Promise<string | null> {
  for (const v of ['.venv', 'venv', 'env']) {
    const p = WIN ? path.join(v, 'Scripts', 'python.exe') : path.join(v, 'bin', 'python');
    if (await exists(path.join(dir, p))) return WIN ? `.\\${p}` : `./${p}`;
  }
  return null;
}

async function detectPython(dir: string): Promise<Found[]> {
  const out: Found[] = [];
  const venv = await pythonFor(dir);
  const uv = await exists(path.join(dir, 'uv.lock'));
  const py = venv ?? (uv ? 'uv run python' : WIN ? 'python' : 'python3');
  if (await exists(path.join(dir, 'manage.py'))) out.push({ label: 'Django server', command: `${py} manage.py runserver`, kind: 'dev', source: 'manage.py' });
  for (const f of ['app.py', 'main.py', 'server.py', 'run.py', 'streamlit_app.py', 'bot.py']) {
    const src = await readText(path.join(dir, f));
    if (src === null) continue;
    const mod = f.replace(/\.py$/, '');
    if (/^\s*(import streamlit|from streamlit)/m.test(src)) out.push({ label: `Streamlit ${f}`, command: `${py} -m streamlit run ${f}`, kind: 'dev', source: f });
    else {
      const fast = /^(\w+)\s*=\s*FastAPI\(/m.exec(src);
      if (fast) out.push({ label: `FastAPI ${f}`, command: `${py} -m uvicorn ${mod}:${fast[1]} --reload`, kind: 'dev', source: f });
      else out.push({ label: `python ${f}`, command: `${py} ${f}`, kind: /Flask\(|app\.run\(|gradio|uvicorn\.run/.test(src) ? 'dev' : 'start', source: f });
    }
  }
  if (out.length || (await exists(path.join(dir, 'requirements.txt'))) || (await exists(path.join(dir, 'pyproject.toml')))) {
    if (uv) out.push({ label: 'Install dependencies', command: 'uv sync', kind: 'install', source: 'uv.lock' });
    else if (await exists(path.join(dir, 'requirements.txt'))) {
      out.push({ label: 'Install requirements', command: `${venv ?? (WIN ? 'python' : 'python3')} -m pip install -r requirements.txt`, kind: 'install', source: 'requirements.txt' });
    }
  }
  return out;
}

async function detectOther(dir: string, entries: string[]): Promise<Found[]> {
  const out: Found[] = [];
  const has = (n: string) => entries.includes(n);
  const csproj = entries.filter((e) => e.endsWith('.csproj'));
  if (csproj.length === 1) {
    out.push({ label: 'dotnet watch', command: 'dotnet watch run', kind: 'dev', source: csproj[0]! });
    out.push({ label: 'dotnet run', command: 'dotnet run', kind: 'start', source: csproj[0]! });
  }
  if (has('Cargo.toml')) out.push({ label: 'cargo run', command: 'cargo run', kind: 'start', source: 'Cargo.toml' });
  if (has('go.mod')) out.push({ label: 'go run', command: 'go run .', kind: 'start', source: 'go.mod' });
  if (has('pubspec.yaml')) out.push({ label: 'flutter run', command: 'flutter run', kind: 'dev', source: 'pubspec.yaml' });
  const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(has);
  if (compose) out.push({ label: 'docker compose up', command: 'docker compose up', kind: 'start', source: compose });
  for (const denoFile of ['deno.json', 'deno.jsonc']) {
    if (!has(denoFile)) continue;
    try {
      const tasks = JSON.parse((await readText(path.join(dir, denoFile))) ?? '{}')?.tasks ?? {};
      for (const t of Object.keys(tasks).slice(0, 8)) out.push({ label: t, command: `deno task ${t}`, kind: scriptKind(t), source: denoFile });
    } catch {
      /* jsonc with comments: skip */
    }
  }
  if (has('Makefile')) {
    const mk = (await readText(path.join(dir, 'Makefile'))) ?? '';
    for (const m of mk.matchAll(/^(dev|run|serve|start)\s*:/gm)) out.push({ label: `make ${m[1]}`, command: `make ${m[1]}`, kind: scriptKind(m[1]!), source: 'Makefile' });
  }
  return out;
}

async function detectDir(dir: string, root: string): Promise<Found[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const found = [...(await detectNode(dir, root)), ...(await detectPython(dir)), ...(await detectOther(dir, entries))];
  // a browser extension: open the extensions page, where "Load unpacked" takes this folder
  if (!found.length && entries.includes('manifest.json')) {
    const manifest = (await readText(path.join(dir, 'manifest.json'))) ?? '';
    if (/"manifest_version"/.test(manifest)) found.push({ label: 'Load as a Chrome extension', command: EXTENSIONS_PAGE, kind: 'open', source: 'manifest.json' });
  }
  // a plain website: open the page (a framework's public/ folder doesn't count)
  if (!found.length && entries.includes('index.html') && !/^(public|static|assets|templates)$/i.test(path.basename(dir))) {
    found.push({ label: 'Open index.html', command: 'index.html', kind: 'open', source: 'index.html' });
  }
  return found;
}

/** Everything that looks like a way to run the project, best first. Looks in the root and one level down (monorepos, web/ + server/). */
export async function detectRunCommands(root: string): Promise<RunCommand[]> {
  const out: RunCommand[] = [];
  const push = (cwd: string, list: Found[]) => {
    for (const f of list) out.push({ ...f, id: idFor(cwd, f.command), cwd, label: cwd ? `${f.label} (${cwd})` : f.label });
  };
  push('', await detectDir(root, root));
  let subs: fs.Dirent[] = [];
  try {
    subs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name));
  } catch {
    /* unreadable */
  }
  let looked = 0;
  for (const d of subs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (looked >= 12) break;
    looked++;
    const found = await detectDir(path.join(root, d.name), root);
    // one level down, keep what starts things; builds and lints are noise there
    push(d.name, found.filter((f) => f.kind !== 'other' && f.kind !== 'test'));
  }
  const best = out.find((c) => c.kind === 'dev' && !c.cwd) ?? out.find((c) => c.kind === 'dev') ?? out.find((c) => c.kind === 'start') ?? out.find((c) => c.kind === 'open');
  if (best) best.primary = true;
  return out;
}

export function customToCommands(list: CustomRunCommand[]): RunCommand[] {
  return list.map((c) => {
    const cwd = (c.cwd ?? '').replace(/^[\\/]+|[\\/]+$/g, '');
    return { id: `c-${idFor(cwd, c.command)}`, label: c.label || c.command, command: c.command, cwd, kind: 'custom' as const, source: 'Saved by you' };
  });
}

/** Keep a command's folder inside the project. */
export function resolveCwd(root: string, rel: string): string {
  const abs = path.resolve(root, rel || '.');
  const r = path.relative(path.resolve(root), abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('That folder is outside the project');
  return abs;
}

// ------------------------------------------------------------------ saved commands

export class CustomCommandStore {
  private data: Record<string, CustomRunCommand[]>;
  constructor(private file: string) {
    this.data = readJsonSync(file, {});
  }
  private key(p: string) {
    return WIN ? path.resolve(p).toLowerCase() : path.resolve(p);
  }
  get(projectPath: string): CustomRunCommand[] {
    return this.data[this.key(projectPath)] ?? [];
  }
  async set(projectPath: string, list: CustomRunCommand[]): Promise<void> {
    const clean = list
      .map((c) => ({ label: String(c.label ?? '').trim().slice(0, 80), command: String(c.command ?? '').trim().slice(0, 2000), ...(c.cwd ? { cwd: String(c.cwd).trim() } : {}) }))
      .filter((c) => c.command);
    if (clean.length) this.data[this.key(projectPath)] = clean;
    else delete this.data[this.key(projectPath)];
    await writeJsonAtomic(this.file, this.data);
  }
}

// ------------------------------------------------------------------ processes

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/i;
const MAX_LINES = 4000;

const isLoopbackUrl = (u: string) => /\/\/(localhost|127\.|\[::1\]|[\w-]+\.localhost)/i.test(u);

export function findLocalUrl(line: string): string | undefined {
  const m = URL_RE.exec(line);
  if (!m) return undefined;
  return m[0].replace(/[.,;:]+$/, '').replace('//0.0.0.0', '//localhost').replace(/\/\/\[::\]/, '//localhost');
}

interface Run {
  info: RunInfo;
  lines: RunLogLine[];
  next: number;
  child?: ChildProcess;
  partial: { out: string; err: string };
  stopping?: boolean;
}

export class RunManager extends EventEmitter {
  private runs = new Map<string, Run>();

  list(): RunInfo[] {
    return [...this.runs.values()].map((r) => ({ ...r.info, lines: r.next })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  forProject(projectPath: string): RunInfo[] {
    const key = path.resolve(projectPath).toLowerCase();
    return this.list().filter((r) => path.resolve(r.projectPath).toLowerCase() === key);
  }

  get(id: string): RunInfo | undefined {
    const r = this.runs.get(id);
    return r && { ...r.info, lines: r.next };
  }

  log(id: string, after = 0): RunLog | undefined {
    const r = this.runs.get(id);
    if (!r) return undefined;
    return { run: { ...r.info, lines: r.next }, lines: r.lines.filter((l) => l.n >= after), next: r.next };
  }

  private changed() {
    this.emit('change');
  }

  private add(r: Run, text: string, err: boolean) {
    const line: RunLogLine = { n: r.next++, text, ...(err ? { err: true } : {}) };
    r.lines.push(line);
    if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
    const url = findLocalUrl(text);
    // the first loopback address wins; a LAN address only until a loopback one shows up
    if (url && (!r.info.url || (!isLoopbackUrl(r.info.url) && isLoopbackUrl(url)))) {
      r.info.url = url;
      this.changed();
    }
  }

  private feed(r: Run, chunk: Buffer, stream: 'out' | 'err') {
    const text = r.partial[stream] + chunk.toString('utf8').replace(ANSI, '');
    const parts = text.split(/\r?\n/);
    r.partial[stream] = parts.pop() ?? '';
    // progress bars redraw with \r: keep what the line finally says
    for (const p of parts) this.add(r, p.split('\r').filter(Boolean).pop() ?? '', stream === 'err');
    if (r.partial[stream].length > 8192) {
      this.add(r, r.partial[stream], stream === 'err');
      r.partial[stream] = '';
    }
  }

  /** Start a command; the same command already running in the project is returned as is. */
  start(project: { path: string; name: string }, cmd: RunCommand): RunInfo {
    const existing = [...this.runs.values()].find((r) => r.info.status === 'running' && r.info.commandId === cmd.id && r.info.projectPath === project.path);
    if (existing) return { ...existing.info, lines: existing.next };
    const cwd = resolveCwd(project.path, cmd.cwd);
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    const full = cmd.install ? `${cmd.install} && ${cmd.command}` : cmd.command;
    const info: RunInfo = {
      id: randomUUID(),
      projectPath: project.path,
      projectName: project.name,
      commandId: cmd.id,
      label: cmd.label,
      command: full,
      cwd,
      status: 'running',
      startedAt: new Date().toISOString(),
      lines: 0,
    };
    const r: Run = { info, lines: [], next: 0, partial: { out: '', err: '' } };
    this.runs.set(info.id, r);
    this.add(r, `> ${full}`, false);
    let child: ChildProcess;
    try {
      child = spawn(full, {
        cwd,
        shell: true,
        windowsHide: true,
        // own process group on Unix, so stopping takes the whole tree with it
        detached: !WIN,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      info.status = 'failed';
      info.endedAt = new Date().toISOString();
      this.add(r, `Couldn't start: ${e.message}`, true);
      this.changed();
      return { ...info, lines: r.next };
    }
    r.child = child;
    info.pid = child.pid;
    child.stdout?.on('data', (b: Buffer) => this.feed(r, b, 'out'));
    child.stderr?.on('data', (b: Buffer) => this.feed(r, b, 'err'));
    child.on('error', (e) => {
      this.add(r, `Couldn't start: ${e.message}`, true);
      info.status = 'failed';
      info.endedAt ??= new Date().toISOString();
      this.changed();
    });
    child.on('close', (code) => {
      for (const s of ['out', 'err'] as const) if (r.partial[s]) this.add(r, r.partial[s], s === 'err');
      r.partial = { out: '', err: '' };
      info.exitCode = code;
      info.endedAt = new Date().toISOString();
      info.status = r.stopping ? 'stopped' : code === 0 ? 'exited' : 'failed';
      this.add(r, r.stopping ? 'Stopped.' : `Exited with code ${code ?? '?'}.`, !r.stopping && code !== 0);
      r.child = undefined;
      this.changed();
    });
    this.changed();
    return { ...info, lines: r.next };
  }

  stop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r?.child || r.info.status !== 'running') return false;
    r.stopping = true;
    killTree(r.child);
    return true;
  }

  remove(id: string): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    if (r.info.status === 'running') this.stop(id);
    this.runs.delete(id);
    this.changed();
    return true;
  }

  /** On quit: take every child down with us. */
  stopAll(): void {
    for (const r of this.runs.values()) if (r.child && r.info.status === 'running') killTree(r.child);
  }
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** A script that opens in a terminal window: for commands that want your keyboard (flutter run, prompts). */
export async function writeTerminalScript(dir: string, cwd: string, command: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `run-${idFor(cwd, command)}${WIN ? '.cmd' : '.sh'}`);
  const body = WIN ? `@echo off\r\ncd /d "${cwd}"\r\n${command}\r\n` : `#!/usr/bin/env bash\ncd ${JSON.stringify(cwd)}\n${command}\nexec bash\n`;
  await fsp.writeFile(file, body, { mode: 0o755 });
  return file;
}
