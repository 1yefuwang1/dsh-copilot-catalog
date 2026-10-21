import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: root,
  entryPoints: ['client.ts'],
  outfile: 'dist/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'none',
  // Preserve observable component/diagnostic names. Never mangle API properties
  // or rewrite SDK artifacts: all runtime dependencies use the native factory.
  keepNames: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  charset: 'utf8',
  logLevel: 'warning',
});
