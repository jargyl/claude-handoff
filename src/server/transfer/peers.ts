// Talking to Claude Handoff running on another machine on the same network.

import crypto from 'node:crypto';
import type { DeviceInfo, PeerSession, RemoteSessionView, SyncStatus } from '../../shared/types.js';
import type { SessionIndex } from '../claude/sessionIndex.js';
import { compareRemote } from './compare.js';

export class PeerError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export function normalizePeerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port && u.protocol === 'http:') u.port = '7420';
  return `${u.protocol}//${u.host}`;
}

/** "http://192.168.1.20:7420#token" or a URL with ?token= → url + token */
export function parseConnectionString(input: string): { url: string; token?: string } {
  const s = input.trim();
  const hash = s.indexOf('#');
  if (hash > 0) return { url: normalizePeerUrl(s.slice(0, hash)), token: s.slice(hash + 1) || undefined };
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
    const token = u.searchParams.get('token') ?? undefined;
    u.search = '';
    return { url: normalizePeerUrl(u.toString()), token };
  } catch {
    return { url: normalizePeerUrl(s) };
  }
}

export class PeerClient {
  constructor(
    public url: string,
    private token?: string,
  ) {}

  private async req(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
    try {
      const res = await fetch(`${this.url}${path}`, {
        ...init,
        signal: ctrl.signal,
        // x-handoff marks this as a deliberate client call (the other side rejects state changes without it)
        headers: { 'x-handoff': '1', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(init.headers ?? {}) },
      });
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as any;
          if (body?.message) msg = body.message;
        } catch {
          /* not json */
        }
        if (res.status === 401) msg = 'The other device rejected the access token. Pair again.';
        if (res.status === 403 && /LAN sharing is off/.test(msg)) msg = 'LAN sharing is turned off on the other device.';
        throw new PeerError(msg, res.status);
      }
      return res;
    } catch (e: any) {
      if (e instanceof PeerError) throw e;
      if (e?.name === 'AbortError') throw new PeerError("The other device didn't answer in time.");
      throw new PeerError(`Can't reach ${this.url}. Is Claude Handoff running there with LAN sharing on?`);
    } finally {
      clearTimeout(t);
    }
  }

  async hello(): Promise<{ app: string; id: string; name: string; version: string }> {
    return (await this.req('/api/peer/hello', { timeoutMs: 4000 })).json() as any;
  }

  async info(): Promise<DeviceInfo> {
    return (await this.req('/api/peer/info', { timeoutMs: 4000 })).json() as any;
  }

  async sessions(): Promise<PeerSession[]> {
    return ((await (await this.req('/api/peer/sessions', { timeoutMs: 15000 })).json()) as any).sessions;
  }

  async prefixHashes(items: Array<{ id: string; n: number }>): Promise<Record<string, string | null>> {
    if (items.length === 0) return {};
    const res = await this.req('/api/peer/prefix-hashes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
      timeoutMs: 15000,
    });
    return ((await res.json()) as any).hashes;
  }

  async bundle(ids: string[], fileHistory: boolean): Promise<Buffer> {
    const q = new URLSearchParams({ ids: ids.join(','), fileHistory: fileHistory ? '1' : '0' });
    const res = await this.req(`/api/peer/bundle?${q}`, { timeoutMs: 10 * 60_000 });
    return Buffer.from(await res.arrayBuffer());
  }

  async push(zip: Buffer, from: DeviceInfo): Promise<{ stagingId: string; sessions: number }> {
    const res = await this.req('/api/peer/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-from-device': encodeURIComponent(JSON.stringify({ id: from.id, name: from.name })) },
      body: new Uint8Array(zip),
      timeoutMs: 10 * 60_000,
    });
    return res.json() as any;
  }

  async get(path: string): Promise<Response> {
    return this.req(path, { timeoutMs: 30000 });
  }

  async pair(code: string, me: DeviceInfo, port: number, myToken?: string): Promise<{ device: DeviceInfo; token: string }> {
    const res = await this.req('/api/peer/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: me, port, token: myToken }),
      timeoutMs: 8000,
    });
    return res.json() as any;
  }
}

/** Short-lived 6-digit pairing code shown on the device being paired with. */
export class PairingCodes {
  private code = '';
  private expires = 0;
  private failures = 0;

  current(): { code: string; expiresAt: number } {
    if (Date.now() > this.expires || !this.code) this.rotate();
    return { code: this.code, expiresAt: this.expires };
  }

  rotate(): void {
    this.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.expires = Date.now() + 10 * 60_000;
    this.failures = 0;
  }

  verify(input: string): boolean {
    const clean = String(input ?? '').replace(/\D/g, '');
    if (!this.code || Date.now() > this.expires) return false;
    const ok = clean.length === 6 && crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(this.code));
    if (ok) this.rotate();
    else if (++this.failures >= 5) this.rotate(); // too many guesses: burn the code
    return ok;
  }
}

export function peerSessionsFromIndex(index: SessionIndex): PeerSession[] {
  return index.list().map((s) => ({
    id: s.id,
    projectPath: s.projectPath,
    projectName: s.projectName,
    title: s.title,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    userMessages: s.userMessages,
    sizeBytes: s.sizeBytes,
    idCount: s.idCount,
    idHash: s.idHash,
    live: !!s.live,
  }));
}

/** Compare a remote device's sessions with ours. */
export async function compareWithRemote(
  index: SessionIndex,
  remote: PeerSession[],
  prefixes: (items: Array<{ id: string; n: number }>) => Promise<Record<string, string | null>>,
): Promise<{ sessions: RemoteSessionView[]; pushable: Array<{ id: string; status: SyncStatus }> }> {
  const need: Array<{ id: string; n: number }> = [];
  for (const r of remote) {
    const l = index.get(r.id);
    if (l && r.idCount > l.main.core.idSeq.length && r.idHash !== l.main.core.idHash) need.push({ id: r.id, n: l.main.core.idSeq.length });
  }
  const hashes = await prefixes(need);
  const sessions: RemoteSessionView[] = [];
  const remoteIds = new Set<string>();
  const pushable: Array<{ id: string; status: SyncStatus }> = [];
  for (const r of remote) {
    remoteIds.add(r.id);
    const l = index.get(r.id);
    if (!l) {
      sessions.push({ ...r, status: 'new' });
      continue;
    }
    const status = await compareRemote(l.main.core, r, async () => hashes[r.id] ?? null);
    sessions.push({ ...r, status, localProjectPath: index.projectInfo(l.projectDir).path });
    if (status === 'local-ahead') pushable.push({ id: r.id, status });
  }
  for (const l of index.all()) if (!remoteIds.has(l.id)) pushable.push({ id: l.id, status: 'missing' });
  return { sessions, pushable };
}
