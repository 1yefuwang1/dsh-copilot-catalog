import { transform } from 'esbuild';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-owned generated artifacts only. Do not bundle or rewrite any external SDK module.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('Refuse to compact an aliased generated-artifact root.');
async function compact(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compact(path);
    else if (entry.isFile() && entry.name.endsWith('.js') && path !== join(root, 'client.js')) {
      const output = await transform(await readFile(path, 'utf8'), {
        format: 'esm', platform: 'node', target: ['es2022'], keepNames: true,
        minifyWhitespace: true, minifyIdentifiers: true, minifySyntax: true, legalComments: 'none',
      });
      await writeFile(path, output.code);
    }
  }
}
await compact(root);
