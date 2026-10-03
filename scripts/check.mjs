import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function sourceFiles(directory, suffix) {
  const result = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(name, suffix));
    else if (entry.name.endsWith(suffix)) result.push(name);
  }
  return result;
}
const files = [...await sourceFiles('scripts', '.mjs'), ...await sourceFiles('test', '.mjs')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const sources = await sourceFiles('src', '.ts');
for (const file of sources) {
  const source = await readFile(join(root, file), 'utf8');
  if (/\/Applications\/|\/Volumes\/|app\.asar|file:\/\/\//.test(source)) {
    throw new Error(`Machine-specific application path in ${file}`);
  }
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.private || !pkg.license || !pkg.exports['.'] || !pkg.types || !pkg.dsh?.bundle?.patch) throw new Error('Invalid publishable DSH manifest');
console.log(`Syntax checked ${files.length} tooling/test modules; ${sources.length} portable TypeScript sources and publishable manifest verified.`);
