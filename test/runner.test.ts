import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunManager, detectRunCommands, findLocalUrl, resolveCwd } from '../src/server/runner.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-run-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe('detecting how a project runs', () => {
  it('finds package.json scripts, picks dev, and installs first when node_modules is missing', async () => {
    write('app/package.json', JSON.stringify({ scripts: { build: 'vite build', dev: 'vite', predev: 'x', lint: 'eslint .' } }));
    write('app/pnpm-lock.yaml', '');
    const cmds = await detectRunCommands(path.join(dir, 'app'));
    const dev = cmds.find((c) => c.label === 'dev')!;
    expect(dev.command).toBe('pnpm dev');
    expect(dev.primary).toBe(true);
    expect(dev.install).toBe('pnpm install');
    expect(cmds.map((c) => c.label)).not.toContain('predev');
    fs.mkdirSync(path.join(dir, 'app/node_modules'));
    expect((await detectRunCommands(path.join(dir, 'app'))).find((c) => c.label === 'dev')!.install).toBeUndefined();
  });

  it('looks one folder down and recognizes Python, static sites and extensions', async () => {
    write('mono/web/package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
    write('mono/web/node_modules/.keep', '');
    write('mono/api/main.py', 'from fastapi import FastAPI\napp = FastAPI()\n');
    write('site/index.html', '<h1>hi</h1>');
    write('ext/manifest.json', '{"manifest_version": 3}');
    const mono = await detectRunCommands(path.join(dir, 'mono'));
    expect(mono.find((c) => c.cwd === 'web')?.command).toBe('npm run dev');
    expect(mono.find((c) => c.cwd === 'api')?.command).toMatch(/uvicorn main:app --reload$/);
    expect((await detectRunCommands(path.join(dir, 'site')))[0]).toMatchObject({ kind: 'open', command: 'index.html' });
    expect((await detectRunCommands(path.join(dir, 'ext')))[0]).toMatchObject({ kind: 'open', command: 'chrome://extensions' });
  });

  it('keeps command folders inside the project', () => {
    expect(() => resolveCwd(dir, '../elsewhere')).toThrow();
    expect(resolveCwd(dir, 'mono/web')).toBe(path.join(dir, 'mono', 'web'));
  });
});

describe('local URLs in output', () => {
  it('finds dev server addresses', () => {
    expect(findLocalUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(findLocalUrl('Listening on http://0.0.0.0:8000.')).toBe('http://localhost:8000');
    expect(findLocalUrl('see https://example.com/docs')).toBeUndefined();
  });
});

describe('running a command', () => {
  it('captures output, spots the URL and reports how it ended', async () => {
    const runs = new RunManager();
    const script = `console.log('\x1b[32mready\x1b[0m'); console.log('Local: http://localhost:5999/'); console.error('warn'); process.exit(3)`;
    const r = runs.start({ path: dir, name: 'x' }, { id: 'a', label: 'test', command: `node -e "${script}"`, cwd: '', kind: 'custom', source: '' });
    await new Promise<void>((res) => runs.on('change', () => runs.get(r.id)?.status !== 'running' && res()));
    const log = runs.log(r.id)!;
    expect(log.run.status).toBe('failed');
    expect(log.run.exitCode).toBe(3);
    expect(log.run.url).toBe('http://localhost:5999/');
    expect(log.lines.map((l) => l.text)).toEqual(expect.arrayContaining(['ready', 'warn']));
  });

  it('stops a long-running command', async () => {
    const runs = new RunManager();
    const r = runs.start({ path: dir, name: 'x' }, { id: 'b', label: 'loop', command: `node -e "setInterval(() => {}, 1000)"`, cwd: '', kind: 'custom', source: '' });
    await new Promise((res) => setTimeout(res, 300));
    expect(runs.stop(r.id)).toBe(true);
    await new Promise<void>((res) => runs.on('change', () => runs.get(r.id)?.status !== 'running' && res()));
    expect(runs.get(r.id)!.status).toBe('stopped');
  });
});
