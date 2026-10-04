import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { packages, packageManager, containedPath } from './workspaces.mjs';

const modules = {
  'dsh-copilot-catalog': ['index', 'catalog', 'discovery', 'plugin', 'runtime', 'types'],
  'dsh-copilot-search': ['index', 'auth', 'endpoint', 'errors', 'plugin', 'provider', 'refresh', 'responses', 'runtime', 'types'],
};
for (const { directory, manifest: pkg } of await packages(process.argv[2])) {
  const invocation = packageManager(['pack', '--dry-run', '--json', '--config.ignore-scripts=true']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: directory, encoding: 'utf8', shell: invocation.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'pnpm pack failed');
  const pack = JSON.parse(result.stdout);
  assert.ok(modules[pkg.name], 'Package must have an explicit publication allowlist');
  const actual = pack.files.map((file) => file.path).sort();
  const expected = [
    'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
    ...modules[pkg.name].flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`]),
  ].sort();
  assert.deepEqual(actual, expected, `Unexpected published files in ${pkg.name}; check the allowlist`);
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  let unpackedSize = 0;
  for (const file of actual) unpackedSize += (await readFile(containedPath(directory, file))).byteLength;
  assert.ok(unpackedSize < 150_000, 'Unexpectedly large package');
  for (const entry of Object.values(pkg.exports)) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(actual.includes(target.replace(/^\.\//u, '')), `Missing exported file: ${target}`);
    }
  }
  console.log(`pnpm package verified: ${pack.name}@${pack.version}, ${actual.length} allowlisted files, ${unpackedSize} source bytes.`);
}
