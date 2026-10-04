import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { APP_NAME, APP_VERSION, DEFAULT_PORT, DeviceStore, MetaStore, SettingsStore, defaultImportOptions, resolvePaths, type RuntimeOptions } from './config.js';
import { SessionIndex } from './claude/sessionIndex.js';
import { EventHub } from './events.js';
import { CustomCommandStore, RunManager } from './runner.js';
import { securityMiddleware } from './security.js';
import { createApp, type AppContext } from './app.js';
import { StagingStore } from './transfer/staging.js';
import { HistoryStore, Importer, MappingMemory } from './transfer/importer.js';
import { SyncFolder } from './transfer/sync.js';
import { Discovery } from './transfer/discovery.js';
import { PairingCodes } from './transfer/peers.js';
import { Trash } from './trash.js';
import { lanAddresses, openBrowser } from './system.js';
import type { DeviceInfo } from '../shared/types.js';
import { Hono, type Context } from 'hono';

function parseArgs(argv: string[]): RuntimeOptions & { help?: boolean } {
  const o: RuntimeOptions & { help?: boolean } = { open: true, dev: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') o.port = Number(next());
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--host') o.host = next();
    else if (a === '--claude-dir') o.claudeDir = next();
    else if (a === '--data-dir') o.dataDir = next();
    else if (a === '--no-open') o.open = false;
    else if (a === '--lan') o.lan = true;
    else if (a === '--dev') o.dev = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `Claude Handoff ${APP_VERSION}: a local dashboard for your Claude Code sessions

Usage: claude-handoff [options]

  --port <n>          Port to listen on (default ${DEFAULT_PORT})
  --lan               Allow other devices on your network (token required)
  --host <addr>       Bind address (overrides --lan)
  --claude-dir <dir>  Claude Code folder (default ~/.claude or $CLAUDE_CONFIG_DIR)
  --data-dir <dir>    Where Handoff keeps its own data (default ~/.claude-handoff)
  --no-open           Don't open the browser
`;

async function isHandoffAt(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as any;
    return j?.app === APP_NAME;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const paths = resolvePaths(opts.dataDir);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const settings = new SettingsStore(paths.configFile);
  if (opts.lan) await settings.update((s) => void (s.lan.enabled = true));
  const meta = new MetaStore(paths.metaFile);
  const devices = new DeviceStore(paths.devicesFile);
  const events = new EventHub();
  const index = new SessionIndex(settings, meta, paths.cacheDir, opts.claudeDir ? path.resolve(opts.claudeDir) : undefined);
  const staging = new StagingStore(paths.inboxDir);
  const history = new HistoryStore(paths.historyFile);
  let port = opts.port ?? settings.get().port ?? DEFAULT_PORT;

  const device = (): DeviceInfo => ({
    id: settings.get().deviceId,
    name: settings.get().deviceName,
    platform: process.platform,
    homeDir: os.homedir(),
    claudeDir: index.layout.root,
    app: APP_NAME,
    version: APP_VERSION,
  });

  const importer = new Importer({
    index,
    staging,
    mappings: new MappingMemory(path.join(paths.dataDir, 'mappings.json')),
    history,
    backupsDir: paths.backupsDir,
    device,
    defaults: () => ({ ...defaultImportOptions(), ...settings.get().importDefaults }),
  });
  const sync = new SyncFolder({ index, settings, device, staging, events });
  const discovery = new Discovery(() => ({ id: settings.get().deviceId, name: settings.get().deviceName, port }));
  const pairing = new PairingCodes();
  const trash = new Trash(paths.trashDir, index);
  const runs = new RunManager();
  const customRuns = new CustomCommandStore(path.join(paths.dataDir, 'run-commands.json'));
  runs.on('change', () => events.emit({ type: 'runs' }));

  index.on('index', (status) => events.emit({ type: 'index', status }));
  index.on('sessions', (e) => events.emit({ type: 'sessions', changed: e.changed, removed: e.removed }));
  index.on('live', (e) => events.emit({ type: 'live', sessions: e.sessions }));

  const remoteAddr = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;

  // Pick the web build: dist/web next to the bundled server, or the repo's dist when run from source.
  const here = import.meta.dirname;
  const webRoot = opts.dev
    ? null
    : ([path.join(here, '..', 'web'), path.join(here, '..', '..', 'dist', 'web')].find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null);

  let server: http.Server | null = null;
  const bindHost = () => opts.host ?? (settings.get().lan.enabled ? '0.0.0.0' : '127.0.0.1');

  const ctx: AppContext = {
    settings,
    meta,
    devices,
    index,
    staging,
    importer,
    history,
    sync,
    discovery,
    pairing,
    trash,
    events,
    runs,
    customRuns,
    paths,
    device,
    port: () => port,
    // nothing to advertise when we only listen on loopback (e.g. --host 127.0.0.1)
    lanUrls: () => (/^(127\.|localhost$|::1$)/.test(bindHost()) ? [] : lanAddresses().map((a) => `http://${a}:${port}`)),
    applyNetwork: async () => {
      await listen(port, true);
      const s = settings.get();
      if (s.lan.enabled && s.lan.discovery) discovery.start();
      else discovery.stop();
    },
    remoteAddr,
    webRoot,
  };

  const root = new Hono();
  root.use('*', securityMiddleware(settings, remoteAddr));
  root.route('/', createApp(ctx));
  const listener = getRequestListener(root.fetch);

  function listen(p: number, rebind = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = () => {
        const srv = http.createServer(listener);
        srv.keepAliveTimeout = 5000;
        srv.once('error', reject);
        srv.listen(p, bindHost(), () => {
          srv.off('error', reject);
          server = srv;
          resolve();
        });
      };
      if (rebind && server) {
        const old = server;
        server = null;
        old.close(() => start());
        old.closeAllConnections?.();
      } else start();
    });
  }

  // Find a port; if Handoff is already running, just open it.
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(port);
      break;
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if (await isHandoffAt(port)) {
        const url = `http://localhost:${port}`;
        console.log(`Claude Handoff is already running at ${url}`);
        if (opts.open) openBrowser(url);
        return;
      }
      if (opts.port || attempt >= 10) {
        console.error(`Port ${port} is in use. Pick another with --port.`);
        process.exit(1);
      }
      port++;
    }
  }

  const url = `http://localhost:${port}`;
  const s = settings.get();
  console.log(`\n  Claude Handoff ${APP_VERSION}`);
  console.log(`  ${opts.dev ? 'API' : 'Dashboard'}: ${url}`);
  if (s.lan.enabled) for (const u of ctx.lanUrls()) console.log(`  On your network: ${u}`);
  console.log(`  Claude folder: ${index.layout.root}`);
  console.log(`  Data: ${paths.dataDir}\n`);
  if (!webRoot && !opts.dev) console.log('  The web app isn\'t built yet. Run "npm run build" (or use "npm start").\n');

  if (s.lan.enabled && s.lan.discovery) discovery.start();
  void index.start().then(() => sync.start());
  if (opts.open && !opts.dev) openBrowser(url);

  const shutdown = () => {
    runs.stopAll();
    index.stop();
    sync.stop();
    discovery.stop();
    server?.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // closing the console window on Windows
  process.on('SIGHUP', shutdown);
  process.on('exit', () => runs.stopAll());
}

// Keep the dashboard up if something unexpected slips through (a file vanishing mid-read, a peer dropping).
process.on('unhandledRejection', (e: any) => console.error('[handoff] unexpected error:', e?.stack ?? e));
process.on('uncaughtException', (e: any) => console.error('[handoff] unexpected error:', e?.stack ?? e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
