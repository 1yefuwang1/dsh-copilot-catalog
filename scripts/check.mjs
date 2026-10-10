import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, packages, assertWorkspaceDefinition } from './workspaces.mjs';

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
assertWorkspaceDefinition(definition);

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
  const patch = await readFile(join(root, path, manifest.dsh.bundle.patch), 'utf8');
  if (path === 'packages/worktrees') {
    const client = await readFile(join(root, path, 'client.js'), 'utf8');
    const moduleId = client.match(/window\.__ModuleLoader__\.load\(\{\s*id: '([^']+)'/u)?.[1];
    const configKey = client.match(/name: 'plugins\.row\.config', key: '([^']+)'/u)?.[1];
    if (manifest.name !== '@1yefuwang1/dsh-worktrees' || moduleId !== manifest.name ||
        configKey !== `${manifest.name}#git-worktrees` ||
        !patch.includes(`      name: '${manifest.name}'`) || !patch.includes('    - id: git-worktrees') ||
        manifest.publishConfig?.access !== 'public' || manifest.publishConfig.registry !== 'https://registry.npmjs.org/') {
      throw new Error('Worktree package, Client loader, native config row and public npm identity must agree');
    }
  }
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
