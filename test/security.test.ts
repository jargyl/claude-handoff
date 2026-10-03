import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SettingsStore } from '../src/server/config.js';
import { securityMiddleware, TOKEN_COOKIE } from '../src/server/security.js';

let dir: string;
let settings: SettingsStore;
let app: Hono;

// The remote address comes from a test header instead of a socket.
const call = (p: string, init: RequestInit & { remote?: string; host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? 'localhost:7420');
  headers.set('x-test-remote', init.remote ?? '127.0.0.1');
  return app.request(`http://${init.host ?? 'localhost:7420'}${p}`, { ...init, headers });
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-sec-'));
  settings = new SettingsStore(path.join(dir, 'config.json'));
  await settings.update((s) => {
    s.lan.enabled = false;
    s.lan.token = 'secret-token-123';
  });
  app = new Hono();
  app.use('*', securityMiddleware(settings, (c) => c.req.header('x-test-remote')));
  app.all('*', (c) => c.json({ ok: true, access: c.get('access') }));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('requests from this machine', () => {
  it('allows reads', async () => {
    const r = await call('/api/sessions');
    expect(r.status).toBe(200);
    expect((await r.json()).access).toBe('local');
  });

  it('blocks DNS-rebinding hosts', async () => {
    expect((await call('/api/sessions', { host: 'evil.example:7420' })).status).toBe(403);
  });

  it('blocks cross-site writes and writes without the client header', async () => {
    const evil = await call('/api/sessions/x/meta', { method: 'PATCH', headers: { origin: 'https://evil.example', 'x-handoff': '1' } });
    expect(evil.status).toBe(403);
    const noHeader = await call('/api/sessions/x/meta', { method: 'PATCH', headers: { 'content-type': 'text/plain' } });
    expect(noHeader.status).toBe(403);
    const ok = await call('/api/sessions/x/meta', { method: 'PATCH', headers: { origin: 'http://localhost:7420', 'x-handoff': '1' } });
    expect(ok.status).toBe(200);
    const devServer = await call('/api/sessions/x/meta', { method: 'PATCH', headers: { origin: 'http://localhost:5173', 'x-handoff': '1' } });
    expect(devServer.status).toBe(200);
  });
});

describe('requests from the network', () => {
  const remote = '192.168.1.50';

  it('are refused while LAN sharing is off', async () => {
    expect((await call('/api/sessions', { remote, host: '192.168.1.10:7420' })).status).toBe(403);
  });

  it('need the token once LAN sharing is on', async () => {
    await settings.update((s) => void (s.lan.enabled = true));
    const host = '192.168.1.10:7420';
    expect((await call('/api/sessions', { remote, host })).status).toBe(401);
    expect((await call('/api/sessions', { remote, host, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const bearer = await call('/api/sessions', { remote, host, headers: { authorization: 'Bearer secret-token-123' } });
    expect(bearer.status).toBe(200);
    expect((await bearer.json()).access).toBe('remote');
    const cookie = await call('/api/sessions', { remote, host, headers: { cookie: `${TOKEN_COOKIE}=secret-token-123` } });
    expect(cookie.status).toBe(200);
  });

  it('serve the UI shell without a token (it holds no data)', async () => {
    expect((await call('/index.html', { remote, host: '192.168.1.10:7420' })).status).toBe(200);
  });

  it('are read-only, apart from the device endpoints', async () => {
    const host = '192.168.1.10:7420';
    const auth = { authorization: 'Bearer secret-token-123' };
    expect((await call('/api/sessions/x/meta', { method: 'PATCH', remote, host, headers: auth })).status).toBe(403);
    expect((await call('/api/sessions/x', { method: 'DELETE', remote, host, headers: auth })).status).toBe(403);
    expect((await call('/api/settings', { remote, host, headers: auth })).status).toBe(403);
    expect((await call('/api/fs/dirs', { remote, host, headers: auth })).status).toBe(403);
    expect((await call('/api/imports/x/commit', { method: 'POST', remote, host, headers: auth })).status).toBe(403);
    expect((await call('/api/peer/inbox', { method: 'POST', remote, host, headers: auth })).status).toBe(200);
    expect((await call('/api/peer/prefix-hashes', { method: 'POST', remote, host, headers: auth })).status).toBe(200);
  });

  it('can pair with a code, without a token', async () => {
    expect((await call('/api/peer/pair', { method: 'POST', remote, host: '192.168.1.10:7420' })).status).toBe(200);
    expect((await call('/api/peer/hello', { remote, host: '192.168.1.10:7420' })).status).toBe(200);
  });
});
