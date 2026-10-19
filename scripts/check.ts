import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';
import { root, packages, assertWorkspaceDefinition, type PackageManifest } from './workspaces.js';

async function sourceFiles(directory: string, suffix: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(name, suffix));
    else if (entry.name.endsWith(suffix)) result.push(name);
  }
  return result;
}

const leaves = await packages();
const rootManifest: PackageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (rootManifest.private !== true || rootManifest.dsh || rootManifest.main || rootManifest.exports ||
    rootManifest.packageManager !== 'pnpm@11.7.0') {
  throw new Error('Root must be a private, non-plugin pnpm workspace');
}
const definition = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
assertWorkspaceDefinition(definition);

// One runtime baseline: the SDK the repository develops and tests against.
const dshVersion = rootManifest.devDependencies?.['@deepseek-ai/dsh-agent'];
if (typeof dshVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(dshVersion)) {
  throw new Error('Root must pin one exact @deepseek-ai/dsh-agent development version');
}

const files = [...await sourceFiles('scripts', '.ts')];
const sources: string[] = [];
const names = new Set<string>();
const legacy = ['.js', '.mjs', '.cjs', '.jsx'];
for (const suffix of legacy) {
  const remaining = await sourceFiles('scripts', suffix);
  if (remaining.length) throw new Error(`Maintained tooling must use TypeScript: ${remaining.join(', ')}`);
}
for (const { path, manifest } of leaves) {
  if (names.has(manifest.name)) throw new Error('Workspace package names must be unique');
  names.add(manifest.name);
  if (!manifest.license || !manifest.exports?.['.'] || !manifest.types || !manifest.dsh?.bundle?.patch ||
      manifest.dsh.manifestVersion !== 1 || manifest.repository?.directory !== path ||
      manifest.repository.url !== rootManifest.repository?.url) {
    throw new Error(`Invalid publishable DSH manifest in ${path}`);
  }
  if (manifest.dependencies && Object.values(manifest.dependencies).some((value) => /^workspace:/u.test(value))) {
    throw new Error('Published plugins cannot depend on private workspace packages: ' + path);
  }
  // Every leaf declares the same exact runtime, and the runtime itself accepts it.
  if (manifest.engines?.dsh !== dshVersion) {
    throw new Error(`${path} must declare engines.dsh ${dshVersion}`);
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if ((name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) && range !== dshVersion) {
      throw new Error(`${path} peer ${name} must be exactly ${dshVersion}`);
    }
  }
  const incompatibility = evaluatePluginCompatibility(manifest as object, {}, dshVersion);
  if (incompatibility !== undefined) {
    throw new Error(`${path} declares requirements the target runtime rejects: ${JSON.stringify(incompatibility.requirements)}`);
  }
  files.push(...await sourceFiles(`${path}/test`, '.ts'));
  sources.push(...await sourceFiles(`${path}/src`, '.ts'));
  for (const suffix of legacy) {
    const remaining = [...await sourceFiles(`${path}/src`, suffix), ...await sourceFiles(`${path}/test`, suffix)];
    if (remaining.length) throw new Error(`Maintained sources/tests must use TypeScript: ${remaining.join(', ')}`);
  }
  const patch = await readFile(join(root, path, manifest.dsh.bundle.patch), 'utf8');
  if (path === 'packages/worktrees') {
    sources.push(`${path}/client.ts`, `${path}/client.types.d.ts`);
    const client = await readFile(join(root, path, 'client.ts'), 'utf8');
    const moduleId = client.match(/window\.__ModuleLoader__\.load\(\{\s*id: '([^']+)'/u)?.[1];
    const configKey = client.match(/name: 'plugins\.row\.config', key: '([^']+)'/u)?.[1];
    if (manifest.name !== '@1yefuwang1/dsh-worktrees' || moduleId !== manifest.name ||
        configKey !== `${manifest.name}#git-worktrees` || manifest.exports['./client'] !== './dist/client.js' ||
        !patch.includes(`      name: '${manifest.name}'`) || !patch.includes('    - id: git-worktrees') ||
        manifest.publishConfig?.access !== 'public' || manifest.publishConfig.registry !== 'https://registry.npmjs.org/') {
      throw new Error('Worktree package, Client loader, native config row and public npm identity must agree');
    }
  }
  if (path === 'packages/azure-sync') {
    sources.push(`${path}/client.ts`, `${path}/client.types.d.ts`, `${path}/client-model.ts`, `${path}/client-blocks.ts`);
    const client = await readFile(join(root, path, 'client.ts'), 'utf8');
    const moduleId = client.match(/window\.__ModuleLoader__\.load\(\{\s*id: '([^']+)'/u)?.[1];
    const configKey = client.match(/name: 'plugins\.row\.config', key: '([^']+)'/u)?.[1];
    if (manifest.name !== '@1yefuwang1/dsh-azure-sync' || moduleId !== manifest.name ||
        configKey !== `${manifest.name}#azure-sync` || manifest.exports['./client'] !== './dist/client.js' ||
        !patch.includes(`      name: '${manifest.name}'`) || !patch.includes('    - id: azure-sync') ||
        manifest.publishConfig?.access !== 'public' || manifest.publishConfig.registry !== 'https://registry.npmjs.org/') {
      throw new Error('Azure sync package, Client loader, native config row and public npm identity must agree');
    }
  }
}
for (const file of sources) {
  const source = await readFile(join(root, file), 'utf8');
  if (/\/Applications\/|\/Volumes\/|app\.asar|file:\/\/\//u.test(source)) {
    throw new Error(`Machine-specific application path in ${file}`);
  }
}
// The typecheck script checks all maintained TypeScript, including tooling and tests.
console.log(`Verified ${files.length} TypeScript tooling/test modules; ${sources.length} portable TypeScript sources and ${leaves.length} standalone DSH manifests.`);
