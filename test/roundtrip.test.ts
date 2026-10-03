// End-to-end: export a session on "machine A", import it on "machine B" whose
// project lives somewhere else, continue it, bring it back, and diverge it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetaStore, SettingsStore, defaultImportOptions, resolvePaths } from '../src/server/config.js';
import { SessionIndex } from '../src/server/claude/sessionIndex.js';
import { bundleToBuffer, planBundle } from '../src/server/transfer/bundle.js';
import { StagingStore } from '../src/server/transfer/staging.js';
import { HistoryStore, Importer, MappingMemory } from '../src/server/transfer/importer.js';
import { encodeProjectDir } from '../src/shared/paths.js';
import type { DeviceInfo } from '../src/shared/types.js';

const SID = '4b423c21-3e8a-4d57-9947-5b2ed1695070';
let root: string;

interface Machine {
  name: string;
  claude: string;
  home: string;
  project: string;
  index: SessionIndex;
  staging: StagingStore;
  importer: Importer;
  device: DeviceInfo;
}

async function machine(name: string, projectRel: string): Promise<Machine> {
  const base = path.join(root, name);
  const claude = path.join(base, '.claude');
  const home = path.join(base, 'home', name === 'A' ? 'JARI' : 'jarig');
  const project = path.join(home, ...projectRel.split('/'));
  await fsp.mkdir(path.join(claude, 'projects'), { recursive: true });
  await fsp.mkdir(project, { recursive: true });
  const paths = resolvePaths(path.join(base, 'data'));
  const settings = new SettingsStore(paths.configFile);
  await settings.update((s) => {
    s.claudeDir = claude;
  });
  const meta = new MetaStore(paths.metaFile);
  const index = new SessionIndex(settings, meta, paths.cacheDir);
  const staging = new StagingStore(paths.inboxDir);
  const device: DeviceInfo = { id: `dev-${name}`, name: `PC-${name}`, platform: process.platform, homeDir: home, claudeDir: claude, app: 'claude-handoff', version: 'test' };
  const importer = new Importer({
    index,
    staging,
    mappings: new MappingMemory(path.join(paths.dataDir, 'mappings.json')),
    history: new HistoryStore(paths.historyFile),
    backupsDir: paths.backupsDir,
    device: () => device,
    defaults: defaultImportOptions,
  });
  return { name, claude, home, project, index, staging, importer, device };
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function lines(project: string, count: number, parent: string | null, sessionId = SID): { text: string; last: string } {
  const out: string[] = [];
  let prev = parent;
  for (let i = 0; i < count; i++) {
    const u = uuid();
    const a = uuid();
    out.push(
      JSON.stringify({ type: 'user', uuid: u, parentUuid: prev, sessionId, cwd: project, timestamp: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(), message: { role: 'user', content: `step ${i}: edit ${project}${path.sep}a.ts` } }),
    );
    out.push(
      JSON.stringify({
        type: 'assistant',
        uuid: a,
        parentUuid: u,
        sessionId,
        cwd: project,
        timestamp: new Date(Date.UTC(2026, 9, 1, 10, i, 30)).toISOString(),
        message: { id: `msg_${a}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 } },
      }),
    );
    prev = a;
  }
  return { text: out.join('\n') + '\n', last: prev! };
}

const importAll = async (from: Machine, to: Machine, actions: Record<string, any> = {}, extra: Partial<ReturnType<typeof defaultImportOptions>> = {}) => {
  await from.index.scanAll(true);
  const plan = await planBundle(from.index, [SID], from.device, { fileHistory: true, memory: true });
  const zip = await bundleToBuffer(plan);
  const st = await to.staging.create({ kind: 'upload', label: 'test.zip', filename: 'test.zip' });
  await to.staging.addFile(st, zip, 'test.zip');
  await to.index.scanAll(true);
  const p = await to.importer.plan(st, { [from.project]: to.project });
  const res = await to.importer.commit(st, { mappings: { [from.project]: to.project }, actions, options: { ...defaultImportOptions(), ...extra } });
  return { plan: p, res };
};

let A: Machine;
let B: Machine;
let lastA = '';

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));
  A = await machine('A', 'Dev/portfolio_cc/app');
  B = await machine('B', 'work/app');
  const dirA = path.join(A.claude, 'projects', encodeProjectDir(A.project));
  await fsp.mkdir(path.join(dirA, SID, 'subagents'), { recursive: true });
  await fsp.mkdir(path.join(dirA, SID, 'tool-results'), { recursive: true });
  const first = lines(A.project, 3, null);
  lastA = first.last;
  await fsp.writeFile(path.join(dirA, `${SID}.jsonl`), first.text);
  await fsp.writeFile(path.join(dirA, SID, 'subagents', 'agent-abc.jsonl'), lines(A.project, 1, null).text);
  await fsp.writeFile(path.join(dirA, SID, 'subagents', 'agent-abc.meta.json'), '{"description":"helper"}');
  await fsp.writeFile(path.join(dirA, SID, 'tool-results', 'out.txt'), 'big output');
  await fsp.mkdir(path.join(A.claude, 'file-history', SID), { recursive: true });
  await fsp.writeFile(path.join(A.claude, 'file-history', SID, 'abc@v1'), 'old file');
  await fsp.mkdir(path.join(dirA, 'memory'), { recursive: true });
  await fsp.writeFile(path.join(dirA, 'memory', 'MEMORY.md'), '- note');
});

afterAll(async () => {
  A?.index.stop();
  B?.index.stop();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('handoff round trip', () => {
  it('imports a new session into the mapped project folder with paths fixed', async () => {
    const { plan, res } = await importAll(A, B);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.status).toBe('new');
    expect(plan.candidates[0]!.targetDir).toBe(encodeProjectDir(B.project));
    expect(res.items[0]!.ok).toBe(true);
    const dirB = path.join(B.claude, 'projects', encodeProjectDir(B.project));
    const text = await fsp.readFile(path.join(dirB, `${SID}.jsonl`), 'utf8');
    const first = JSON.parse(text.split('\n')[0]!);
    expect(first.cwd).toBe(B.project);
    // conversation content untouched by default
    expect(first.message.content).toContain(A.project);
    expect(fs.existsSync(path.join(dirB, SID, 'subagents', 'agent-abc.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, SID, 'subagents', 'agent-abc.meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, SID, 'tool-results', 'out.txt'))).toBe(true);
    expect(fs.existsSync(path.join(B.claude, 'file-history', SID, 'abc@v1'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, 'memory', 'MEMORY.md'))).toBe(true);
    await B.index.scanAll(true);
    const b = B.index.get(SID)!;
    expect(b.main.core.idHash).toBe(A.index.get(SID)!.main.core.idHash);
    expect(B.index.listItem(b).projectPath).toBe(B.project);
    expect(res.items[0]!.resume?.powershell).toContain(`claude --resume ${SID}`);
  });

  it('sees an identical copy as already in sync', async () => {
    const { plan } = await importAll(A, B, { [SID]: 'skip' });
    expect(plan.candidates[0]!.status).toBe('same');
    expect(plan.candidates[0]!.suggestedAction).toBe('skip');
  });

  it('updates in place when the incoming copy continues the local one', async () => {
    const dirA = path.join(A.claude, 'projects', encodeProjectDir(A.project));
    const more = lines(A.project, 2, lastA);
    lastA = more.last;
    await fsp.appendFile(path.join(dirA, `${SID}.jsonl`), more.text);
    const { plan, res } = await importAll(A, B);
    expect(plan.candidates[0]!.status).toBe('incoming-ahead');
    expect(res.items[0]!.action).toBe('update');
    expect(res.items[0]!.backup).toBeTruthy();
    await B.index.scanAll(true);
    expect(B.index.get(SID)!.main.core.idSeq.length).toBe(10);
  });

  it('imports a diverged copy next to the original, then undoes it', async () => {
    const dirA = path.join(A.claude, 'projects', encodeProjectDir(A.project));
    const dirB = path.join(B.claude, 'projects', encodeProjectDir(B.project));
    await fsp.appendFile(path.join(dirA, `${SID}.jsonl`), lines(A.project, 1, lastA).text);
    await fsp.appendFile(path.join(dirB, `${SID}.jsonl`), lines(B.project, 1, lastA).text);
    const { plan, res } = await importAll(A, B);
    expect(plan.candidates[0]!.status).toBe('diverged');
    const item = res.items[0]!;
    expect(item.action).toBe('copy');
    expect(item.newSessionId).toBeTruthy();
    const copyFile = path.join(dirB, `${item.newSessionId}.jsonl`);
    const firstLine = JSON.parse((await fsp.readFile(copyFile, 'utf8')).split('\n')[0]!);
    expect(firstLine.sessionId).toBe(item.newSessionId);
    expect(fs.existsSync(path.join(dirB, `${SID}.jsonl`))).toBe(true);
    await B.importer.undo(res.historyId);
    expect(fs.existsSync(copyFile)).toBe(false);
  });

  it('accepts a raw .jsonl dropped on its own', async () => {
    const st = await B.staging.create({ kind: 'upload', label: 'x.jsonl' });
    const raw = lines('/Users/someone/elsewhere', 1, null, '9b423c21-3e8a-4d57-9947-5b2ed1695071').text;
    await B.staging.addFile(st, Buffer.from(raw), '9b423c21-3e8a-4d57-9947-5b2ed1695071.jsonl');
    const plan = await B.importer.plan(st);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!.session.projectPath).toBe('/Users/someone/elsewhere');
    await B.staging.remove(st.id);
  });
});
