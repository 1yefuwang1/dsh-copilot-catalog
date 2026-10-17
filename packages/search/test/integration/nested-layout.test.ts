import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntime } from '../../dist/runtime.js';

/** A layout where the plugin and the adapter resolve different pi-ai copies. */
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'search-nested-'));
  const app = join(root, 'app');
  const adapter = join(app, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai');
  const pi = join(app, 'node_modules', '@earendil-works', 'pi-ai');
  await mkdir(adapter, { recursive: true });
  await mkdir(join(pi, 'dist', 'providers'), { recursive: true });
  await writeFile(join(adapter, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', version: '9.9.9', type: 'module', main: 'index.js' }));
  await writeFile(join(adapter, 'index.js'), [
    "export const name = 'stub-adapter';",
    "export const recordKeyFor = (id) => 'nested/' + id;",
    '',
  ].join('\n'));
  await writeFile(join(pi, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '9.9.9', type: 'module' }));
  await writeFile(join(pi, 'dist', 'index.js'), [
    'export function createModels() { return { nested: true, setProvider() {} }; }',
    '',
  ].join('\n'));
  await writeFile(join(pi, 'dist', 'providers', 'github-copilot.js'), [
    'const oauth = { refresh: async () => {}, toAuth: async () => ({ apiKey: "nested", baseUrl: "https://api.individual.githubcopilot.com" }) };',
    "export function githubCopilotProvider() { return { id: 'github-copilot', auth: { oauth }, getModels: () => [] }; }",
    '',
  ].join('\n'));
  return { root, adapterEntry: join(adapter, 'index.js') };
}

test('search loads pi-ai factories and OAuth from the adapter copy, not the plugin-visible one', async t => {
  const fixture = await layout();
  t.after(async () => { await rm(fixture.root, { recursive: true, force: true }); });
  const runtime = await loadRuntime({ adapterEntry: fixture.adapterEntry });
  assert.equal(String(runtime.recordKeyFor('github-copilot')), 'nested/github-copilot');
  assert.equal(runtime.provider.id, 'github-copilot');
  assert.equal(typeof runtime.provider.auth.oauth?.refresh, 'function');
  const created = runtime.createModels({} as never) as unknown as { nested?: boolean };
  assert.equal(created.nested, true, 'createModels comes from the adapter-resolved copy');
  const local = await import('@earendil-works/pi-ai');
  assert.notEqual(runtime.createModels, local.createModels);
});
