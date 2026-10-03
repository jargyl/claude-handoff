import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { deleteCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { APP_NAME, APP_VERSION, defaultImportOptions, type DeviceStore, type MetaStore, type Paths, type SettingsStore } from './config.js';
import type { SessionIndex } from './claude/sessionIndex.js';
import { readClaudeSettings, isUuid } from './claude/locate.js';
import { readLines, readRange, tryParse } from './util/lines.js';
import { extractImage } from './claude/transcript.js';
import { computeStats } from './stats.js';
import { searchSessions } from './search.js';
import { transcriptToMarkdown } from './exportMarkdown.js';
import { RateLimiter, TOKEN_COOKIE, tokensEqual } from './security.js';
import { listDirs, openResumeTerminal, revealFolder } from './system.js';
import { bundleFileName, bundleToBuffer, planBundle, readCompleteLines, streamBundle } from './transfer/bundle.js';
import type { StagingStore } from './transfer/staging.js';
import type { HistoryStore, Importer } from './transfer/importer.js';
import { PeerClient, PeerError, compareWithRemote, normalizePeerUrl, parseConnectionString, peerSessionsFromIndex, type PairingCodes } from './transfer/peers.js';
import type { SyncFolder } from './transfer/sync.js';
import type { Discovery } from './transfer/discovery.js';
import type { Trash } from './trash.js';
import type { EventHub } from './events.js';
import { pricingTable } from '../shared/pricing.js';
import type { DeviceInfo, DeviceState, ImportRequest, MeResponse, Settings } from '../shared/types.js';
import { prefixHash } from './claude/parse.js';

export interface AppContext {
  settings: SettingsStore;
  meta: MetaStore;
  devices: DeviceStore;
  index: SessionIndex;
  staging: StagingStore;
  importer: Importer;
  history: HistoryStore;
  sync: SyncFolder;
  discovery: Discovery;
  pairing: PairingCodes;
  trash: Trash;
  events: EventHub;
  paths: Paths;
  device(): DeviceInfo;
  port(): number;
  lanUrls(): string[];
  applyNetwork(): Promise<void>;
  remoteAddr(c: Context): string | undefined;
  webRoot: string | null;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const bad = (msg: string) => new HttpError(400, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad('Expected a JSON body');
  }
}

function ids(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  return [...new Set(list.map(String).map((s) => s.trim()).filter(isUuid))];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const pairLimiter = new RateLimiter(10, 60_000);
  const loginLimiter = new RateLimiter(10, 60_000);
  const deviceStatus = new Map<string, { at: number; state: Pick<DeviceState, 'online' | 'error' | 'version'> }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: 'request', message: err.message }, err.status as any);
    if (err instanceof PeerError) return c.json({ error: 'peer', message: err.message }, 502);
    console.error('[handoff]', err);
    return c.json({ error: 'internal', message: err?.message ?? 'Something went wrong' }, 500);
  });

  const gz = compress();
  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/events' || p.startsWith('/api/export') || p.includes('/bundle') || p.includes('/image/')) return next();
    return gz(c, next);
  });

  // ------------------------------------------------------------ identity

  app.get('/api/health', (c) => c.json({ ok: true, app: APP_NAME, version: APP_VERSION }));

  app.get('/api/me', async (c) => {
    const s = ctx.settings.get();
    const claudeDir = ctx.index.layout.root;
    const res: MeResponse = {
      device: ctx.device(),
      access: c.get('access') ?? 'local',
      lan: { enabled: s.lan.enabled, urls: s.lan.enabled ? ctx.lanUrls() : [], port: ctx.port(), acceptPush: s.lan.acceptPush },
      claude: { dir: claudeDir, exists: fs.existsSync(claudeDir), cleanupPeriodDays: readClaudeSettings(ctx.index.layout).cleanupPeriodDays },
      inbox: (await ctx.staging.list()).length,
      index: ctx.index.status,
    };
    return c.json(res);
  });

  app.post('/api/auth/login', async (c) => {
    if (!loginLimiter.allow(ctx.remoteAddr(c) ?? '?')) throw new HttpError(429, 'Too many attempts. Wait a minute.');
    const { token } = await body<{ token: string }>(c);
    const s = ctx.settings.get();
    if (!token || !tokensEqual(String(token).trim(), s.lan.token)) throw new HttpError(401, "That access token doesn't match.");
    setCookie(c, TOKEN_COOKIE, s.lan.token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 365 });
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, TOKEN_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ sessions

  app.get('/api/sessions', (c) => c.json({ sessions: ctx.index.list(), status: ctx.index.status }));

  app.get('/api/sessions/:id', async (c) => {
    const d = await ctx.index.detail(c.req.param('id'));
    if (!d) throw notFound('Session not found');
    return c.json(d);
  });

  app.get('/api/sessions/:id/transcript', async (c) => {
    const b = await ctx.index.transcript(c.req.param('id'), c.req.query('agent') || undefined);
    if (!b) throw notFound('Session not found');
    return c.json(b.transcript);
  });

  app.get('/api/sessions/:id/line/:n', async (c) => {
    const agent = c.req.query('agent') || undefined;
    const b = await ctx.index.transcript(c.req.param('id'), agent);
    const f = ctx.index.fileFor(c.req.param('id'), agent);
    const n = Number(c.req.param('n'));
    if (!b || !f || !Number.isInteger(n) || n < 0 || n * 2 + 1 >= b.ranges.length) throw notFound('Line not found');
    const text = await readRange(f.file, b.ranges[n * 2]!, b.ranges[n * 2 + 1]!);
    const obj = tryParse(text);
    return c.json(obj ?? { raw: text });
  });

  app.get('/api/sessions/:id/image/:ref', async (c) => {
    const agent = c.req.query('agent') || undefined;
    const ref = decodeURIComponent(c.req.param('ref'));
    const m = ref.match(/^(\d+):(c\d+(?:\/\d+)?)$/);
    if (!m) throw bad('Bad image ref');
    const b = await ctx.index.transcript(c.req.param('id'), agent);
    const f = ctx.index.fileFor(c.req.param('id'), agent);
    const n = Number(m[1]);
    if (!b || !f || n * 2 + 1 >= b.ranges.length) throw notFound();
    const obj = tryParse(await readRange(f.file, b.ranges[n * 2]!, b.ranges[n * 2 + 1]!));
    const img = extractImage(obj, m[2]!);
    if (!img) throw notFound('Image not found');
    const type = /^image\/(png|jpeg|gif|webp)$/.test(img.mediaType) ? img.mediaType : 'application/octet-stream';
    return c.body(new Uint8Array(img.data), 200, { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
  });

  app.get('/api/sessions/:id/export.md', async (c) => {
    const id = c.req.param('id');
    const d = await ctx.index.detail(id);
    const b = await ctx.index.transcript(id);
    if (!d || !b) throw notFound('Session not found');
    const md = transcriptToMarkdown(d, b.transcript, { includeTools: c.req.query('tools') !== '0', includeThinking: c.req.query('thinking') === '1' });
    const name = `${d.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || id}.md`;
    return c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
  });

  app.get('/api/sessions/:id/raw', async (c) => {
    const f = ctx.index.fileFor(c.req.param('id'), c.req.query('agent') || undefined);
    if (!f) throw notFound('Session not found');
    const data = await readCompleteLines(f.file);
    return c.body(new Uint8Array(data), 200, { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="${path.basename(f.file)}"` });
  });

  app.patch('/api/sessions/:id/meta', async (c) => {
    const id = c.req.param('id');
    if (!ctx.index.get(id)) throw notFound('Session not found');
    const b = await body<{ title?: string; starred?: boolean; tags?: string[]; note?: string }>(c);
    const patch: Record<string, unknown> = {};
    if (typeof b.title === 'string') patch.title = b.title.slice(0, 200);
    if (typeof b.starred === 'boolean') patch.starred = b.starred;
    if (Array.isArray(b.tags)) patch.tags = b.tags.map(String).slice(0, 20);
    if (typeof b.note === 'string') patch.note = b.note.slice(0, 5000);
    await ctx.meta.set(id, patch);
    ctx.events.emit({ type: 'sessions', changed: [id], removed: [] });
    return c.json(ctx.index.listItem(ctx.index.get(id)!));
  });

  app.delete('/api/sessions/:id', async (c) => {
    const entry = await ctx.trash.trash(c.req.param('id'));
    return c.json(entry);
  });

  app.post('/api/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    const s = ctx.index.get(id);
    if (!s) throw notFound('Session not found');
    const cwd = ctx.index.projectInfo(s.projectDir).path;
    try {
      return c.json(openResumeTerminal(cwd, id));
    } catch (e: any) {
      throw bad(e.message);
    }
  });

  app.post('/api/reveal', async (c) => {
    const { path: p } = await body<{ path: string }>(c);
    try {
      revealFolder(String(p));
    } catch (e: any) {
      throw bad(e.message);
    }
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ projects, stats, search

  app.get('/api/projects', async (c) => c.json({ projects: await ctx.index.projectsSummary() }));

  app.get('/api/stats', (c) =>
    c.json(computeStats(ctx.index, { from: c.req.query('from'), to: c.req.query('to'), project: c.req.query('project') || undefined, tz: c.req.query('tz') }, ctx.settings.get().pricingOverrides)),
  );

  app.get('/api/search', async (c) => {
    const role = c.req.query('role');
    return c.json(
      await searchSessions(ctx.index, {
        q: c.req.query('q') ?? '',
        project: c.req.query('project') || undefined,
        role: role === 'user' || role === 'assistant' || role === 'tool' ? role : undefined,
        limit: Number(c.req.query('limit')) || undefined,
        sessionId: c.req.query('session') || undefined,
      }),
    );
  });

  // ------------------------------------------------------------ live events

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsub = ctx.events.subscribe((e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => void 0);
      });
      stream.onAbort(() => unsub());
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ app: APP_NAME, version: APP_VERSION }) });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(20_000);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => void 0);
      }
      unsub();
    }),
  );

  // ------------------------------------------------------------ export & import

  app.get('/api/export', async (c) => {
    const list = ids(c.req.query('ids'));
    if (!list.length) throw bad('Pick at least one session to export');
    const plan = await planBundle(ctx.index, list, ctx.device(), { fileHistory: c.req.query('fileHistory') !== '0', memory: c.req.query('memory') !== '0' });
    if (!plan.manifest.sessions.length) throw notFound('None of those sessions exist here');
    const name = bundleFileName(plan.manifest.sessions.length, ctx.device().name);
    return c.body(streamBundle(plan), 200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
  });

  app.get('/api/imports', async (c) => {
    const list = await ctx.staging.list();
    const out = [];
    for (const s of list) {
      const sessions = await ctx.staging.sessions(s);
      out.push({ id: s.id, createdAt: s.createdAt, source: s.source, sessions: sessions.map((x) => ({ id: x.id, title: x.title, projectPath: x.projectPath })) });
    }
    return c.json({ imports: out });
  });

  app.post('/api/imports', async (c) => {
    const filename = decodeURIComponent(c.req.header('x-filename') ?? 'upload.zip');
    const append = c.req.query('append');
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (!data.length) throw bad('The file is empty');
    const st = append ? await ctx.staging.get(append) : await ctx.staging.create({ kind: 'upload', label: filename, filename });
    if (!st) throw notFound('Import not found');
    try {
      await ctx.staging.addFile(st, data, filename);
    } catch (e: any) {
      if (!append) await ctx.staging.remove(st.id);
      throw bad(e.message);
    }
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    return c.json(await ctx.importer.plan(st));
  });

  app.get('/api/imports/:id', async (c) => {
    const st = await ctx.staging.get(c.req.param('id'));
    if (!st) throw notFound('This import is gone. It may have finished already.');
    return c.json(await ctx.importer.plan(st));
  });

  app.post('/api/imports/:id/plan', async (c) => {
    const st = await ctx.staging.get(c.req.param('id'));
    if (!st) throw notFound('This import is gone');
    const { mappings } = await body<{ mappings?: Record<string, string> }>(c);
    return c.json(await ctx.importer.plan(st, mappings ?? {}));
  });

  app.post('/api/imports/:id/commit', async (c) => {
    const st = await ctx.staging.get(c.req.param('id'));
    if (!st) throw notFound('This import is gone');
    const req = await body<ImportRequest>(c);
    const result = await ctx.importer.commit(st, {
      mappings: req.mappings ?? {},
      actions: req.actions ?? {},
      options: { ...defaultImportOptions(), ...ctx.settings.get().importDefaults, ...(req.options ?? {}) },
    });
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    ctx.events.emit({ type: 'sessions', changed: result.items.map((i) => i.newSessionId ?? i.sessionId), removed: [] });
    return c.json(result);
  });

  app.delete('/api/imports/:id', async (c) => {
    await ctx.staging.remove(c.req.param('id'));
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    return c.json({ ok: true });
  });

  app.get('/api/history', (c) => c.json({ history: ctx.history.list() }));

  app.post('/api/history/:id/undo', async (c) => {
    try {
      const r = await ctx.importer.undo(c.req.param('id'));
      ctx.events.emit({ type: 'sessions', changed: [], removed: [] });
      return c.json(r);
    } catch (e: any) {
      throw bad(e.message);
    }
  });

  // ------------------------------------------------------------ trash

  app.get('/api/trash', async (c) => c.json({ trash: await ctx.trash.list() }));
  app.post('/api/trash/:id/restore', async (c) => {
    try {
      await ctx.trash.restore(c.req.param('id'));
    } catch (e: any) {
      throw bad(e.message);
    }
    return c.json({ ok: true });
  });
  app.delete('/api/trash/:id', async (c) => {
    await ctx.trash.purge(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.delete('/api/trash', async (c) => {
    await ctx.trash.purge();
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ paired devices (this device's view)

  const clientFor = (id: string) => {
    const d = ctx.devices.get(id);
    if (!d) throw notFound('Device not found');
    return { d, client: new PeerClient(d.url, d.token) };
  };

  app.get('/api/devices', async (c) => {
    const s = ctx.settings.get();
    const now = Date.now();
    const states: DeviceState[] = await Promise.all(
      ctx.devices.list().map(async (d) => {
        const cached = deviceStatus.get(d.id);
        let state = cached && now - cached.at < 10_000 ? cached.state : undefined;
        if (!state || c.req.query('refresh') === '1') {
          try {
            const h = await new PeerClient(d.url, d.token).hello();
            state = { online: true, version: h.version };
            if (h.id !== d.id) state = { online: false, error: 'A different device answers at this address now.' };
            else void ctx.devices.touch(d.id, { lastSeenAt: new Date().toISOString() });
          } catch (e: any) {
            state = { online: false, error: e?.message ?? 'Offline' };
          }
          deviceStatus.set(d.id, { at: now, state });
        }
        const { token: _t, ...pub } = d;
        return { ...pub, ...state };
      }),
    );
    return c.json({
      devices: states,
      discovered: ctx.discovery.list(new Set(ctx.devices.list().map((d) => d.id))),
      pairing: s.lan.enabled ? ctx.pairing.current() : null,
      lan: { enabled: s.lan.enabled, urls: s.lan.enabled ? ctx.lanUrls() : [], acceptPush: s.lan.acceptPush, discovery: s.lan.discovery },
    });
  });

  app.post('/api/devices', async (c) => {
    const b = await body<{ url?: string; code?: string; token?: string; connection?: string }>(c);
    let url: string;
    let token = b.token?.trim() || undefined;
    try {
      if (b.connection) ({ url, token } = parseConnectionString(b.connection));
      else url = normalizePeerUrl(String(b.url ?? ''));
    } catch {
      throw bad("That doesn't look like an address. Try something like 192.168.1.20:7420");
    }
    const me = ctx.device();
    let remote: DeviceInfo;
    if (b.code) {
      const s = ctx.settings.get();
      const res = await new PeerClient(url).pair(String(b.code), me, ctx.port(), s.lan.enabled ? s.lan.token : undefined);
      remote = res.device;
      token = res.token;
    } else if (token) {
      remote = await new PeerClient(url, token).info();
    } else {
      throw bad('Enter the pairing code shown on the other device.');
    }
    if (remote.id === me.id) throw bad("That's this device.");
    await ctx.devices.upsert({ id: remote.id, name: remote.name, url, platform: remote.platform, token: token!, addedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
    deviceStatus.delete(remote.id);
    ctx.events.emit({ type: 'devices' });
    return c.json({ id: remote.id, name: remote.name, url, platform: remote.platform });
  });

  app.delete('/api/devices/:id', async (c) => {
    await ctx.devices.remove(c.req.param('id'));
    ctx.events.emit({ type: 'devices' });
    return c.json({ ok: true });
  });

  app.get('/api/devices/:id/sessions', async (c) => {
    const { d, client } = clientFor(c.req.param('id'));
    const remote = await client.sessions();
    const { sessions, pushable } = await compareWithRemote(ctx.index, remote, (items) => client.prefixHashes(items));
    void ctx.devices.touch(d.id, { lastSeenAt: new Date().toISOString() });
    return c.json({ device: { id: d.id, name: d.name, url: d.url }, sessions, pushable });
  });

  app.get('/api/devices/:id/sessions/:sid/transcript', async (c) => {
    const { client } = clientFor(c.req.param('id'));
    const res = await client.get(`/api/sessions/${encodeURIComponent(c.req.param('sid'))}/transcript`);
    return c.json(await res.json());
  });

  app.post('/api/devices/:id/pull', async (c) => {
    const { d, client } = clientFor(c.req.param('id'));
    const list = ids((await body<{ ids: string[] }>(c)).ids);
    if (!list.length) throw bad('Pick at least one session');
    const zip = await client.bundle(list, ctx.settings.get().importDefaults.includeFileHistory);
    const st = await ctx.staging.create({ kind: 'device', label: `From ${d.name}`, deviceId: d.id, deviceName: d.name });
    await ctx.staging.addFile(st, zip, 'bundle.zip');
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    return c.json(await ctx.importer.plan(st));
  });

  app.post('/api/devices/:id/push', async (c) => {
    const { d, client } = clientFor(c.req.param('id'));
    const list = ids((await body<{ ids: string[] }>(c)).ids);
    if (!list.length) throw bad('Pick at least one session');
    const defaults = ctx.settings.get().importDefaults;
    const plan = await planBundle(ctx.index, list, ctx.device(), { fileHistory: defaults.includeFileHistory, memory: defaults.includeMemory });
    const zip = await bundleToBuffer(plan);
    const res = await client.push(zip, ctx.device());
    return c.json({ device: d.name, ...res });
  });

  // ------------------------------------------------------------ peer API (what other devices call)

  app.get('/api/peer/hello', (c) => c.json({ app: APP_NAME, id: ctx.device().id, name: ctx.device().name, version: APP_VERSION }));

  app.post('/api/peer/pair', async (c) => {
    const ip = ctx.remoteAddr(c) ?? '?';
    if (!pairLimiter.allow(ip)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
    const b = await body<{ code: string; device: DeviceInfo; port?: number; token?: string }>(c);
    if (!ctx.pairing.verify(String(b.code ?? ''))) throw new HttpError(401, 'Wrong or expired pairing code. Check the code on the other device.');
    if (b.token && b.device?.id && b.device.id !== ctx.device().id) {
      const host = ip.replace(/^::ffff:/, '');
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${Number(b.port) || 7420}`;
      await ctx.devices.upsert({
        id: String(b.device.id),
        name: String(b.device.name ?? 'Device').slice(0, 80),
        url,
        platform: String(b.device.platform ?? ''),
        token: String(b.token),
        addedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      ctx.events.emit({ type: 'devices' });
      ctx.events.emit({ type: 'toast', tone: 'success', message: `Paired with ${b.device.name}` });
    }
    return c.json({ device: ctx.device(), token: ctx.settings.get().lan.token });
  });

  app.get('/api/peer/info', (c) => c.json(ctx.device()));

  app.get('/api/peer/sessions', (c) => c.json({ sessions: peerSessionsFromIndex(ctx.index) }));

  app.post('/api/peer/prefix-hashes', async (c) => {
    const { items } = await body<{ items: Array<{ id: string; n: number }> }>(c);
    const hashes: Record<string, string | null> = {};
    for (const it of (items ?? []).slice(0, 5000)) {
      const s = ctx.index.get(String(it.id));
      hashes[String(it.id)] = s && Number.isInteger(it.n) && it.n >= 0 && it.n <= s.main.core.idSeq.length ? prefixHash(s.main.core, it.n) : null;
    }
    return c.json({ hashes });
  });

  app.get('/api/peer/bundle', async (c) => {
    const list = ids(c.req.query('ids'));
    if (!list.length) throw bad('No sessions requested');
    const plan = await planBundle(ctx.index, list, ctx.device(), { fileHistory: c.req.query('fileHistory') !== '0', memory: true });
    return c.body(streamBundle(plan), 200, { 'content-type': 'application/zip', 'cache-control': 'no-store' });
  });

  app.post('/api/peer/inbox', async (c) => {
    if (!ctx.settings.get().lan.acceptPush) throw new HttpError(403, "This device doesn't accept sessions sent to it. Turn it on under Settings.");
    let from = { id: '', name: 'Another device' };
    try {
      from = JSON.parse(decodeURIComponent(c.req.header('x-from-device') ?? '')) ?? from;
    } catch {
      /* keep default */
    }
    const data = new Uint8Array(await c.req.arrayBuffer());
    const st = await ctx.staging.create({ kind: 'push', label: `Sent from ${from.name}`, deviceId: from.id, deviceName: from.name });
    try {
      await ctx.staging.addFile(st, data, 'bundle.zip');
    } catch (e: any) {
      await ctx.staging.remove(st.id);
      throw bad(e.message);
    }
    const n = (await ctx.staging.sessions(st)).length;
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    ctx.events.emit({ type: 'toast', tone: 'info', message: `${from.name} sent you ${n} session${n === 1 ? '' : 's'}. Review them in the inbox.` });
    return c.json({ stagingId: st.id, sessions: n });
  });

  // ------------------------------------------------------------ sync folder

  app.get('/api/sync', async (c) => c.json(await ctx.sync.state()));

  app.post('/api/sync/push', async (c) => {
    const b = await body<{ ids?: string[]; all?: boolean; force?: boolean }>(c);
    if (!ctx.sync.folder()) throw bad('Choose a sync folder first.');
    const list = b.all ? ctx.index.all().map((s) => s.id) : ids(b.ids);
    if (!list.length) throw bad('Pick at least one session');
    const r = await ctx.sync.push(list, { force: !!b.force });
    return c.json(r);
  });

  app.post('/api/sync/pull', async (c) => {
    const list = ids((await body<{ ids: string[] }>(c)).ids);
    if (!list.length) throw bad('Pick at least one session');
    const stagings = await ctx.sync.pull(list);
    if (!stagings.length) throw notFound('Those sessions are no longer in the sync folder');
    ctx.events.emit({ type: 'inbox', count: (await ctx.staging.list()).length });
    return c.json({ stagings: stagings.map((s) => s.id), plan: await ctx.importer.plan(stagings[0]!) });
  });

  app.get('/api/sync/sessions/:id/transcript', async (c) => {
    const b = await ctx.sync.transcript(c.req.param('id'));
    if (!b) throw notFound('Not in the sync folder');
    return c.json(b.transcript);
  });

  app.delete('/api/sync/sessions/:id', async (c) => {
    await ctx.sync.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ settings & folders

  app.get('/api/settings', (c) =>
    c.json({
      settings: ctx.settings.get(),
      pricing: pricingTable(),
      paths: { dataDir: ctx.paths.dataDir, claudeDir: ctx.index.layout.root, home: os.homedir() },
      platform: process.platform,
    }),
  );

  app.patch('/api/settings', async (c) => {
    const b = await body<Partial<Settings> & { lan?: Partial<Settings['lan']>; sync?: Partial<Settings['sync']> }>(c);
    const before = ctx.settings.get();
    let syncFolder: string | null | undefined;
    if (b.sync && 'folder' in b.sync) {
      const f = b.sync.folder;
      if (f === null || f === '') syncFolder = null;
      else {
        const abs = path.resolve(String(f));
        try {
          await fsp.mkdir(abs, { recursive: true });
        } catch {
          throw bad("Can't create or open that folder.");
        }
        // Don't litter a populated folder (e.g. the OneDrive root): use a subfolder unless it's already a sync folder.
        const entries = await fsp.readdir(abs).catch(() => [] as string[]);
        const isSync = entries.includes('handoff-sync.json');
        syncFolder = isSync || entries.length === 0 ? abs : path.join(abs, 'Claude Handoff');
      }
    }
    const next = await ctx.settings.update((s) => {
      if (typeof b.deviceName === 'string' && b.deviceName.trim()) s.deviceName = b.deviceName.trim().slice(0, 60);
      if (b.lan) {
        if (typeof b.lan.enabled === 'boolean') s.lan.enabled = b.lan.enabled;
        if (typeof b.lan.acceptPush === 'boolean') s.lan.acceptPush = b.lan.acceptPush;
        if (typeof b.lan.discovery === 'boolean') s.lan.discovery = b.lan.discovery;
      }
      if (syncFolder !== undefined) s.sync.folder = syncFolder;
      if (b.sync?.autoPush && ['off', 'all', 'starred'].includes(b.sync.autoPush)) s.sync.autoPush = b.sync.autoPush;
      if (b.importDefaults) s.importDefaults = { ...s.importDefaults, ...b.importDefaults };
      if (b.pricingOverrides && typeof b.pricingOverrides === 'object') s.pricingOverrides = b.pricingOverrides;
      if ('claudeDir' in b) s.claudeDir = b.claudeDir ? path.resolve(String(b.claudeDir)) : null;
      if (typeof b.port === 'number' && b.port > 0 && b.port < 65536) s.port = Math.floor(b.port);
    });
    if (next.sync.folder) await ctx.sync.ensureLayout().catch(() => void 0);
    if (next.sync.autoPush !== before.sync.autoPush || next.sync.folder !== before.sync.folder) void ctx.sync.catchUp();
    if (next.claudeDir !== before.claudeDir) void ctx.index.relocate(next.claudeDir);
    if (next.lan.enabled !== before.lan.enabled || next.lan.discovery !== before.lan.discovery) setTimeout(() => void ctx.applyNetwork(), 150);
    return c.json({ settings: next, restartNeeded: next.port !== before.port });
  });

  app.post('/api/settings/rotate-token', async (c) => {
    const { newToken } = await import('./config.js');
    const next = await ctx.settings.update((s) => {
      s.lan.token = newToken();
    });
    ctx.pairing.rotate();
    return c.json({ token: next.lan.token });
  });

  app.get('/api/fs/dirs', async (c) => c.json(await listDirs(c.req.query('path'))));

  // ------------------------------------------------------------ the web app

  if (ctx.webRoot) {
    const root = path.resolve(ctx.webRoot);
    const indexHtml = path.join(root, 'index.html');
    app.get('*', async (c) => {
      const reqPath = decodeURIComponent(new URL(c.req.url).pathname);
      if (reqPath.startsWith('/api/')) throw notFound('Unknown API route');
      const file = path.resolve(root, '.' + reqPath);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file).toLowerCase();
        const immutable = reqPath.startsWith('/assets/');
        return c.body(new Uint8Array(await fsp.readFile(file)), 200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
      }
      return c.body(await fsp.readFile(indexHtml, 'utf8'), 200, { 'content-type': MIME['.html']!, 'cache-control': 'no-cache' });
    });
  } else {
    app.get('/', (c) => c.text('Claude Handoff API is running. Start the web app with `npm run dev`, or build it with `npm run build`.'));
  }

  return app;
}

export async function linesOf(file: string): Promise<number> {
  let n = 0;
  for await (const _ of readLines(file)) n++;
  return n;
}
