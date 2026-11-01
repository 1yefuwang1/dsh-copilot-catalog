import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntime } from '../../dist/runtime.js';

/**
 * A layout where the plugin and the adapter resolve different pi-ai copies.
 * The merged runtime imports all three public pi-ai entry points from the
 * adapter's tree: `dist/index.js`, `providers/github-copilot.js` and
 * `providers/github-copilot.models.js`.
 */
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'better-copilot-nested-'));
  const app = join(root, 'app');
  const adapter = join(app, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai');
  const pi = join(app, 'node_modules', '@earendil-works', 'pi-ai');
  await mkdir(adapter, { recursive: true });
  await mkdir(join(pi, 'dist', 'providers'), { recursive: true });
  await writeFile(join(adapter, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '9.9.9', type: 'module', main: 'index.js' }));
  await writeFile(join(adapter, 'index.js'), [
    "export const name = 'stub-adapter';",
    'export const Config = () => ({});',
    'export const apply = () => {};',
    "export const inject = ['llm'];",
    "export const recordKeyFor = (id) => 'nested/' + id;",
    "export const owner = 'adapter-copy';",
    '',
  ].join('\n'));
  await writeFile(join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '9.9.9', type: 'module' }));
  await writeFile(join(pi, 'dist', 'index.js'), [
    'export function createModels() { return { nested: true, setProvider() {} }; }',
    '',
  ].join('\n'));
  await writeFile(join(pi, 'dist', 'providers', 'github-copilot.models.js'), [
    'export const GITHUB_COPILOT_MODELS = { nested: true };',
    '',
  ].join('\n'));
  await writeFile(join(pi, 'dist', 'providers', 'github-copilot.js'), [
    'const oauth = { refresh: async () => {}, toAuth: async () => ({ apiKey: "nested", baseUrl: "https://api.individual.githubcopilot.com" }) };',
    "export function githubCopilotProvider() { return { id: 'github-copilot', auth: { oauth }, getModels: () => [] }; }",
    '',
  ].join('\n'));
  return { root, adapterEntry: join(adapter, 'index.js') };
}

test('the merged runtime loads the adapter, catalog, OAuth and factories from the adapter tree', async t => {
  const fixture = await layout();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const runtime = await loadRuntime({ adapterEntry: fixture.adapterEntry });
  // The adapter itself came from the fixture, not the workspace installation.
  assert.equal(runtime.original.name, 'stub-adapter');
  // Catalog, OAuth hooks and factories all come from the adapter's sibling copy.
  assert.deepEqual(runtime.catalog, { nested: true });
  assert.equal(typeof runtime.oauth.refresh, 'function');
  assert.equal(typeof runtime.oauth.toAuth, 'function');
  assert.equal(String(runtime.recordKeyFor('github-copilot')), 'nested/github-copilot');
  assert.equal(runtime.provider.id, 'github-copilot');
  const created = runtime.createModels({} as never) as unknown as { nested?: boolean };
  assert.equal(created.nested, true, 'createModels comes from the adapter-resolved copy');
  // The plugin-visible workspace copies are different objects and are not what we loaded.
  const [localCatalog, localPi] = await Promise.all([
    import('@earendil-works/pi-ai/providers/github-copilot.models'),
    import('@earendil-works/pi-ai'),
  ]);
  assert.notEqual(runtime.catalog, localCatalog.GITHUB_COPILOT_MODELS);
  assert.notEqual(runtime.createModels, localPi.createModels);
});

test('search keeps a guarded provider clone while discovery keeps the raw OAuth hooks', async t => {
  const fixture = await layout();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const runtime = await loadRuntime({ adapterEntry: fixture.adapterEntry });
  // The search-owned clone replaces only refresh; toAuth stays the adapter's hook.
  assert.equal(typeof runtime.provider.auth.oauth?.refresh, 'function');
  assert.notEqual(runtime.provider.auth.oauth?.refresh, runtime.oauth.refresh);
  assert.equal(runtime.provider.auth.oauth?.toAuth, runtime.oauth.toAuth);
  assert.ok(!Object.keys(runtime.headers).some((key) => key.toLowerCase() === 'authorization'));
  assert.equal(runtime.headers['Copilot-Integration-Id'], 'vscode-chat');
});
