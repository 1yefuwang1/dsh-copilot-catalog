import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntime } from '../../dist/runtime.js';

/** A layout where the plugin and the adapter resolve different pi-ai copies. */
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'catalog-nested-'));
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
    "export const recordKeyFor = (id) => 'stub/' + id;",
    "export const owner = 'adapter-copy';",
    '',
  ].join('\n'));
  await writeFile(join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '9.9.9', type: 'module' }));
  await writeFile(join(pi, 'dist', 'providers', 'github-copilot.models.js'), [
    'export const GITHUB_COPILOT_MODELS = { nested: true };',
    '',
  ].join('\n'));
  await writeFile(join(pi, 'dist', 'providers', 'github-copilot.js'), [
    'const oauth = { refresh: async () => {}, toAuth: async () => ({ apiKey: "nested", baseUrl: "https://api.individual.githubcopilot.com" }) };',
    'export function githubCopilotProvider() { return { auth: { oauth }, getModels: () => [] }; }',
    '',
  ].join('\n'));
  return { root, adapterEntry: join(adapter, 'index.js') };
}

test('the runtime loads pi-ai from the adapter, never from the plugin-visible copy', async t => {
  const fixture = await layout();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const runtime = await loadRuntime({ adapterEntry: fixture.adapterEntry });
  // The adapter itself came from the fixture, not the workspace installation.
  assert.equal(runtime.original.name, 'stub-adapter');
  // Catalog, OAuth hooks and factories all come from the adapter's sibling copy.
  assert.deepEqual(runtime.catalog, { nested: true });
  assert.equal(typeof runtime.oauth.refresh, 'function');
  assert.equal(typeof runtime.oauth.toAuth, 'function');
  // The plugin-visible workspace copy is a different object and is not what we loaded.
  const local = await import('@earendil-works/pi-ai/providers/github-copilot.models');
  assert.notEqual(runtime.catalog, local.GITHUB_COPILOT_MODELS);
});
