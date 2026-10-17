// `--background`: start the server as its own process, without a console
// window, and return once it's listening. Its output goes to a log file. The
// launcher stays only long enough to report whether that worked, so a failed
// start still shows its error in the window you started it from.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, type Paths } from './config.js';

/** Set for the server process the launcher starts; holds the log file's path. */
export const LOG_ENV = 'HANDOFF_LOG_FILE';
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type LauncherMessage = { handoff: 'ready'; url: string } | { handoff: 'already-running'; url: string };

/** In the background server: tell the launcher how starting went. */
export function tellLauncher(m: LauncherMessage): void {
  if (process.env[LOG_ENV] && process.send) process.send(m);
}

export const logFile = (paths: Paths) => path.join(paths.dataDir, 'handoff.log');

export async function startInBackground(argv: string[], paths: Paths): Promise<never> {
  const log = logFile(paths);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  try {
    if (fs.statSync(log).size > MAX_LOG_BYTES) fs.renameSync(log, `${log}.old`);
  } catch {
    /* no log yet, or it's in use */
  }
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, `\n--- ${new Date().toISOString()} starting Claude Handoff ${APP_VERSION}\n`);
  const start = fs.fstatSync(fd).size;

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...argv.filter((a) => a !== '--background')], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, [LOG_ENV]: log },
  });
  fs.closeSync(fd);

  const outcome = await new Promise<LauncherMessage | { handoff: 'exited'; code: number | null } | { handoff: 'slow' }>((resolve) => {
    const timer = setTimeout(() => resolve({ handoff: 'slow' }), 60_000);
    const done = (r: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer);
      resolve(r);
    };
    child.once('message', (m: any) => done(m));
    child.once('exit', (code) => done({ handoff: 'exited', code }));
    child.once('error', (e) => {
      console.error(`Couldn't start Claude Handoff: ${e.message}`);
      done({ handoff: 'exited', code: 1 });
    });
  });

  const where = process.platform === 'win32' ? 'Use the Handoff icon in the notification area (next to the clock) to open or quit it.' : 'Quit it from the dashboard (the power button at the bottom of the sidebar).';
  switch (outcome.handoff) {
    case 'ready':
      console.log(`Claude Handoff is running in the background at ${outcome.url}\n${where}\nLog: ${log}`);
      break;
    case 'already-running':
      console.log(`Claude Handoff is already running at ${outcome.url}`);
      break;
    case 'slow':
      console.log(`Claude Handoff is still starting. If the dashboard doesn't open, look in the log: ${log}`);
      break;
    case 'exited': {
      // show what the server said, so the error is visible without opening the log
      let said = '';
      try {
        said = fs.readFileSync(log, 'utf8').slice(start).trim();
      } catch {
        /* nothing to show */
      }
      console.error(said ? `${said}\n` : '');
      console.error(`Claude Handoff stopped while starting. The log is at ${log}`);
      process.exit(outcome.code || 1);
    }
  }
  if (child.connected) child.disconnect();
  child.unref();
  process.exit(0);
}
