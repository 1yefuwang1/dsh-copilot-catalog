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
  // Preserve observable diagnostic/component names while bounding the growing public UI.
  keepNames: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  charset: 'utf8',
  logLevel: 'warning',
});
