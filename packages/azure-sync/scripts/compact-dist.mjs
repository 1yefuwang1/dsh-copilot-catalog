import { transform } from 'esbuild';
import { compactDeclaration } from './compact-declarations.mjs';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-owned generated artifacts only. Do not bundle or rewrite any external SDK module.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('Refuse to compact an aliased generated-artifact root.');
async function compact(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await realpath(path) !== path) throw new Error('Refuse to compact an aliased artifact directory.');
      await compact(path);
    } else if (entry.isFile()) {
      const info = await lstat(path);
      if (info.nlink !== 1 || await realpath(path) !== path) throw new Error('Refuse to rewrite an aliased artifact file.');
      if (entry.name.endsWith('.js') && path !== join(root, 'client.js')) {
        const output = await transform(await readFile(path, 'utf8'), {
          format: 'esm', platform: 'node', target: ['es2022'], keepNames: true,
          minifyWhitespace: true, minifyIdentifiers: true, minifySyntax: true, legalComments: 'none',
        });
        await writeFile(path, output.code);
      } else if (entry.name.endsWith('.d.ts')) {
        await writeFile(path, compactDeclaration(await readFile(path, 'utf8'), path));
      }
    }
  }
}
await compact(root);
