import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, packages, workspacePaths } from './workspaces.mjs';

async function sourceFiles(directory, suffix) {
  const result = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(name, suffix));
    else if (entry.name.endsWith(suffix)) result.push(name);
  }
  return result;
}

const leaves = await packages();
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (rootManifest.private !== true || rootManifest.dsh || rootManifest.main || rootManifest.exports ||
    rootManifest.packageManager !== 'pnpm@11.7.0') {
  throw new Error('Root must be a private, non-plugin pnpm workspace');
}
const definition = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
for (const path of workspacePaths) if (!definition.includes(`  - ${path}\n`)) throw new Error(`Missing pnpm workspace: ${path}`);

const files = [...await sourceFiles('scripts', '.mjs')];
const sources = [];
const names = new Set();
for (const { path, manifest } of leaves) {
  if (names.has(manifest.name)) throw new Error('Workspace package names must be unique');
  names.add(manifest.name);
  if (!manifest.license || !manifest.exports?.['.'] || !manifest.types || !manifest.dsh?.bundle?.patch ||
      manifest.dsh.manifestVersion !== 1 || manifest.repository?.directory !== path ||
      manifest.repository.url !== rootManifest.repository.url) {
    throw new Error(`Invalid publishable DSH manifest in ${path}`);
  }
  if (manifest.dependencies && Object.values(manifest.dependencies).some((value) => /^workspace:/u.test(value))) {
    throw new Error(`Published plugins cannot depend on private workspace packages: ${path}`);
  }
  files.push(...await sourceFiles(`${path}/test`, '.mjs'));
  sources.push(...await sourceFiles(`${path}/src`, '.ts'));
  await readFile(join(root, path, manifest.dsh.bundle.patch), 'utf8');
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of sources) {
  const source = await readFile(join(root, file), 'utf8');
  if (/\/Applications\/|\/Volumes\/|app\.asar|file:\/\/\//u.test(source)) {
    throw new Error(`Machine-specific application path in ${file}`);
  }
}
console.log(`Syntax checked ${files.length} tooling/test modules; ${sources.length} portable TypeScript sources and ${leaves.length} standalone DSH manifests verified.`);
