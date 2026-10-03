// Development: API server with auto-reload on :7421, Vite dev server on :5173 (proxies /api).
import { spawn } from 'node:child_process';

const procs = [
  ['api', 'npx tsx watch --clear-screen=false src/server/index.ts --dev --port 7421 --no-open'],
  ['web', 'npx vite --open'],
];

const children = procs.map(([name, cmd]) => {
  const child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = name === 'api' ? '\x1b[36m[api]\x1b[0m ' : '\x1b[35m[web]\x1b[0m ';
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown();
  });
  return child;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
