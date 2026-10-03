import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ImportOptions, PairedDevice, Settings } from '../shared/types.js';
import { writeJsonAtomic } from './util/fsx.js';

export const APP_NAME = 'claude-handoff';
export const APP_VERSION = '0.1.0';
export const DEFAULT_PORT = 7420;

export interface RuntimeOptions {
  port?: number;
  host?: string;
  claudeDir?: string;
  dataDir?: string;
  open: boolean;
  lan?: boolean;
  dev: boolean;
}

export interface Paths {
  dataDir: string;
  configFile: string;
  metaFile: string;
  devicesFile: string;
  historyFile: string;
  cacheDir: string;
  inboxDir: string;
  backupsDir: string;
  trashDir: string;
}

export function resolvePaths(dataDir?: string): Paths {
  const root = dataDir ?? process.env.HANDOFF_DATA_DIR ?? path.join(os.homedir(), '.claude-handoff');
  return {
    dataDir: root,
    configFile: path.join(root, 'config.json'),
    metaFile: path.join(root, 'meta.json'),
    devicesFile: path.join(root, 'devices.json'),
    historyFile: path.join(root, 'history.json'),
    cacheDir: path.join(root, 'cache'),
    inboxDir: path.join(root, 'inbox'),
    backupsDir: path.join(root, 'backups'),
    trashDir: path.join(root, 'trash'),
  };
}

export const defaultImportOptions = (): ImportOptions => ({
  rewriteMetadata: true,
  rewriteContent: false,
  includeFileHistory: true,
  includeMemory: true,
});

export function newToken(): string {
  // 24 chars of base32-ish (no lookalikes), grouped for readability when typed by hand
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(24);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

function defaults(): Settings {
  return {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    port: DEFAULT_PORT,
    claudeDir: null,
    lan: { enabled: false, token: newToken(), acceptPush: true, discovery: true },
    sync: { folder: null, autoPush: 'off' },
    importDefaults: defaultImportOptions(),
    pricingOverrides: {},
  };
}

export { writeJsonAtomic };

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

type Listener = (s: Settings) => void;

export class SettingsStore {
  private settings: Settings;
  private listeners = new Set<Listener>();

  constructor(private file: string) {
    const stored = readJsonSync<Partial<Settings>>(file, {});
    const d = defaults();
    this.settings = {
      ...d,
      ...stored,
      lan: { ...d.lan, ...(stored.lan ?? {}) },
      sync: { ...d.sync, ...(stored.sync ?? {}) },
      importDefaults: { ...d.importDefaults, ...(stored.importDefaults ?? {}) },
      pricingOverrides: stored.pricingOverrides ?? {},
    };
    if (!fs.existsSync(file)) void writeJsonAtomic(file, this.settings);
  }

  get(): Settings {
    return this.settings;
  }

  async update(patch: (s: Settings) => Settings | void): Promise<Settings> {
    const draft = structuredClone(this.settings);
    const next = patch(draft) ?? draft;
    this.settings = next;
    await writeJsonAtomic(this.file, next);
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

// ---------------------------------------------------------------- per-session metadata

export interface SessionMeta {
  title?: string;
  starred?: boolean;
  tags?: string[];
  note?: string;
}

export class MetaStore {
  private data: { sessions: Record<string, SessionMeta> };
  constructor(private file: string) {
    this.data = readJsonSync(file, { sessions: {} as Record<string, SessionMeta> });
    if (!this.data.sessions) this.data.sessions = {};
  }
  get(id: string): SessionMeta {
    return this.data.sessions[id] ?? {};
  }
  all(): Record<string, SessionMeta> {
    return this.data.sessions;
  }
  async set(id: string, patch: SessionMeta): Promise<SessionMeta> {
    const next: SessionMeta = { ...this.get(id), ...patch };
    if (next.title !== undefined && !next.title.trim()) delete next.title;
    if (next.note !== undefined && !next.note.trim()) delete next.note;
    if (next.tags) next.tags = [...new Set(next.tags.map((t) => t.trim()).filter(Boolean))];
    if (!next.starred) delete next.starred;
    if (next.tags && next.tags.length === 0) delete next.tags;
    if (Object.keys(next).length === 0) delete this.data.sessions[id];
    else this.data.sessions[id] = next;
    await writeJsonAtomic(this.file, this.data);
    return next;
  }
  async rename(oldId: string, newId: string): Promise<void> {
    if (!this.data.sessions[oldId]) return;
    this.data.sessions[newId] = this.data.sessions[oldId]!;
    await writeJsonAtomic(this.file, this.data);
  }
}

// ---------------------------------------------------------------- paired devices (tokens kept server-side)

export interface StoredDevice extends PairedDevice {
  token: string;
}

export class DeviceStore {
  private devices: StoredDevice[];
  constructor(private file: string) {
    this.devices = readJsonSync<StoredDevice[]>(file, []);
  }
  list(): StoredDevice[] {
    return this.devices;
  }
  get(id: string): StoredDevice | undefined {
    return this.devices.find((d) => d.id === id);
  }
  async upsert(d: StoredDevice): Promise<void> {
    const i = this.devices.findIndex((x) => x.id === d.id);
    if (i >= 0) this.devices[i] = { ...this.devices[i], ...d };
    else this.devices.push(d);
    await writeJsonAtomic(this.file, this.devices);
  }
  async touch(id: string, patch: Partial<StoredDevice>): Promise<void> {
    const d = this.get(id);
    if (!d) return;
    Object.assign(d, patch);
    await writeJsonAtomic(this.file, this.devices);
  }
  async remove(id: string): Promise<void> {
    this.devices = this.devices.filter((d) => d.id !== id);
    await writeJsonAtomic(this.file, this.devices);
  }
}
