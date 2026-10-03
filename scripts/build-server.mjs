// Bundle the server (and its dependencies) into one file: dist/server/index.js.
// Together with dist/web, the dist folder runs anywhere with plain `node`.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // some dependencies still call require(); give the ESM bundle one
  banner: { js: "import { createRequire as __handoffRequire } from 'node:module'; const require = __handoffRequire(import.meta.url);" },
});
