// Talking to the desktop: open the browser, open a terminal that resumes a
// session, reveal a folder, and list folders for the folder picker.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detached(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean } = {}): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, cwd: opts.cwd, shell: opts.shell ?? false });
  child.on('error', () => void 0);
  child.unref();
}

function has(cmd: string): boolean {
  const probe = process.platform === 'win32' ? spawnSync('where', [cmd], { stdio: 'ignore' }) : spawnSync('which', [cmd], { stdio: 'ignore' });
  return probe.status === 0;
}

export function openBrowser(url: string): void {
  try {
    // empty first argument = window title, so start doesn't treat the URL as one
    if (process.platform === 'win32') detached('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]);
    else if (process.platform === 'darwin') detached('open', [url]);
    else detached('xdg-open', [url]);
  } catch {
    /* the URL is printed in the console anyway */
  }
}

export function revealFolder(p: string): void {
  if (!fs.existsSync(p)) throw new Error('Folder not found');
  if (process.platform === 'win32') detached('explorer.exe', [p]);
  else if (process.platform === 'darwin') detached('open', [p]);
  else detached('xdg-open', [p]);
}

/** Open a new terminal window in cwd running `claude --resume <id>`. */
export function openResumeTerminal(cwd: string, sessionId: string): { terminal: string } {
  if (!UUID_RE.test(sessionId)) throw new Error('Invalid session id');
  let st: fs.Stats;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new Error(`The project folder doesn't exist on this machine: ${cwd}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${cwd}`);

  if (process.platform === 'win32') {
    if (/["%^&|<>;]/.test(cwd)) throw new Error('This folder name has characters the terminal launcher can’t pass safely. Copy the command instead.');
    if (has('wt')) {
      detached('wt.exe', ['-d', cwd, 'cmd', '/k', 'claude', '--resume', sessionId]);
      return { terminal: 'Windows Terminal' };
    }
    // "start" treats the first quoted argument as the window title
    detached('cmd.exe', ['/c', 'start', 'Claude Code', '/D', cwd, 'cmd', '/k', 'claude', '--resume', sessionId]);
    return { terminal: 'Command Prompt' };
  }

  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `cd ${sh(cwd)} && claude --resume ${sessionId}`;
  if (process.platform === 'darwin') {
    const appleScript = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    detached('osascript', ['-e', `tell application "Terminal" to do script "${appleScript(command)}"`, '-e', 'tell application "Terminal" to activate']);
    return { terminal: 'Terminal' };
  }
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', `${command}; exec bash`]],
    ['gnome-terminal', ['--working-directory', cwd, '--', 'bash', '-lc', `claude --resume ${sessionId}; exec bash`]],
    ['konsole', ['--workdir', cwd, '-e', 'bash', '-lc', `claude --resume ${sessionId}; exec bash`]],
    ['kitty', ['--directory', cwd, 'bash', '-lc', `claude --resume ${sessionId}; exec bash`]],
    ['alacritty', ['--working-directory', cwd, '-e', 'bash', '-lc', `claude --resume ${sessionId}; exec bash`]],
    ['xterm', ['-e', 'bash', '-lc', `${command}; exec bash`]],
  ];
  for (const [cmd, args] of candidates) {
    if (has(cmd)) {
      detached(cmd, args);
      return { terminal: cmd };
    }
  }
  throw new Error('No terminal emulator found. Copy the command instead.');
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  roots: Array<{ name: string; path: string }>;
}

function windowsDrives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    try {
      fs.accessSync(d);
      out.push(d);
    } catch {
      /* not mounted */
    }
  }
  return out;
}

export async function listDirs(p?: string): Promise<DirListing> {
  const home = os.homedir();
  const target = p && p.trim() ? path.resolve(p.trim()) : home;
  const roots = [{ name: 'Home', path: home }, ...(process.platform === 'win32' ? windowsDrives().map((d) => ({ name: d, path: d })) : [{ name: '/', path: '/' }])];
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs, roots };
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

/** Open a terminal window in cwd that runs a script file (written by the runner). */
export function openTerminalScript(cwd: string, script: string, title: string): { terminal: string } {
  if (process.platform === 'win32') {
    if (has('wt')) {
      detached('wt.exe', ['-d', cwd, '--title', title.replace(/;/g, ','), 'cmd', '/k', script]);
      return { terminal: 'Windows Terminal' };
    }
    detached('cmd.exe', ['/c', 'start', title.replace(/["^&|<>%]/g, ''), '/D', cwd, 'cmd', '/k', script]);
    return { terminal: 'Command Prompt' };
  }
  if (process.platform === 'darwin') {
    detached('open', ['-a', 'Terminal', script]);
    return { terminal: 'Terminal' };
  }
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', 'bash', script]],
    ['gnome-terminal', ['--working-directory', cwd, '--', 'bash', script]],
    ['konsole', ['--workdir', cwd, '-e', 'bash', script]],
    ['kitty', ['--directory', cwd, 'bash', script]],
    ['alacritty', ['--working-directory', cwd, '-e', 'bash', script]],
    ['xterm', ['-e', 'bash', script]],
  ];
  for (const [cmd, args] of candidates) {
    if (has(cmd)) {
      detached(cmd, args);
      return { terminal: cmd };
    }
  }
  throw new Error('No terminal emulator found.');
}

export function openChromeExtensions(): void {
  if (process.platform === 'win32') detached('cmd', ['/c', 'start', '', 'chrome', 'chrome://extensions']);
  else if (process.platform === 'darwin') detached('open', ['-a', 'Google Chrome', 'chrome://extensions']);
  else detached('google-chrome', ['chrome://extensions']);
}
