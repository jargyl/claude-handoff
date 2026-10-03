// `npm start`: install dependencies and build when needed, then run the dashboard.
// On a fresh machine this is the only command you need after cloning.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const server = path.join(root, 'dist', 'server', 'index.js');
const web = path.join(root, 'dist', 'web', 'index.html');

function newest(dir) {
  let max = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else max = Math.max(max, fs.statSync(p).mtimeMs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return max;
}

const run = (cmd) => {
  const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.error(`Claude Handoff needs Node.js 20.11 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const hasDeps = fs.existsSync(path.join(root, 'node_modules', 'vite')) && fs.existsSync(path.join(root, 'node_modules', 'hono'));
const built = fs.existsSync(server) && fs.existsSync(web);
const stale = built && newest(path.join(root, 'src')) > Math.min(fs.statSync(server).mtimeMs, fs.statSync(web).mtimeMs);

if (!built || stale) {
  if (!hasDeps) {
    console.log('Installing dependencies…');
    run('npm install --no-fund --no-audit');
  }
  console.log(built ? 'Source changed, rebuilding…' : 'Building Claude Handoff…');
  run('npm run build --silent');
}

await import(pathToFileURL(server).href);
