import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
const command = npm ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const args = [...(npm ? [npm] : []), 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', 'node_modules/.cache/npm'];
const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: !npm && process.platform === 'win32' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'npm pack failed');
const [pack] = JSON.parse(result.stdout);
const actual = pack.files.map((file) => file.path).sort();
const expected = [
  'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  ...['index', 'catalog', 'discovery', 'plugin', 'runtime', 'types'].flatMap((name) => [
    `dist/${name}.js`, `dist/${name}.d.ts`,
  ]),
].sort();
assert.deepEqual(actual, expected, 'Unexpected published files; check the allowlist');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(pack.name, pkg.name);
assert.equal(pack.version, pkg.version);
assert.ok(pack.unpackedSize < 100_000, 'Unexpectedly large package');
console.log(`npm tarball verified: ${pack.name}@${pack.version}, ${actual.length} allowlisted files, ${pack.unpackedSize} bytes unpacked.`);
