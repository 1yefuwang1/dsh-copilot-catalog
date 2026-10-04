import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntime } from '../../dist/runtime.js';
import { replaceCatalog, selectAccountModels } from '../../dist/catalog.js';
import { syncCopilotCatalog } from '../../dist/discovery.js';
import { accountItem, grantFixture } from '../helpers.mjs';
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models';
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

test('npm peers load a real DSH adapter and its public Copilot OAuth hooks', async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.original.name, 'llm-pi-ai');
  assert.equal(typeof runtime.original.Config, 'function');
  assert.equal(typeof runtime.original.apply, 'function');
  assert.equal(typeof runtime.oauth.refresh, 'function');
  assert.equal(typeof runtime.oauth.toAuth, 'function');
  assert.ok(Object.keys(runtime.catalog).length > 0);
  const auth = await runtime.oauth.toAuth({ type: 'oauth', access: 'synthetic-token', refresh: 'synthetic', expires: 0 });
  assert.equal(auth.baseUrl, 'https://api.individual.githubcopilot.com');
});

test('discovery mutates the catalog visible to the real adapter catalog APIs', async () => {
  const { catalog, original } = await loadRuntime();
  assert.equal(catalog, GITHUB_COPILOT_MODELS);
  const snapshot = { ...catalog };
  try {
    const result = await syncCopilotCatalog({ readRecord: async () => grantFixture() }, {
      catalog,
      recordKey: original.recordKeyFor('github-copilot'),
      oauth: {
        refresh: async (value) => value,
        toAuth: async () => ({ apiKey: 'synthetic', baseUrl: 'https://api.individual.githubcopilot.com' }),
      },
      fetcher: async () => ({ ok: true, json: async () => ({ data: [accountItem('future-responses-model')] }) }),
    });
    assert.equal(result.status, 'synced');
    assert.deepEqual(getBuiltinModels('github-copilot').map((model) => model.id), ['future-responses-model']);
    const provider = builtinProviders().find((value) => value.id === 'github-copilot');
    assert.deepEqual(provider.getModels().map((model) => model.id), ['future-responses-model']);
  } finally {
    replaceCatalog(catalog, snapshot);
  }
});

test('actual published provider supports every dynamically selected protocol', async () => {
  const { catalog } = await loadRuntime();
  const items = [
    accountItem('future-responses-model'),
    accountItem('future-chat-model', { supported_endpoints: ['/chat/completions'] }),
    accountItem('future-messages-model', { supported_endpoints: ['/v1/messages'] }),
  ];
  const { models } = selectAccountModels({ data: items }, catalog);
  for (const [id, api] of [
    ['future-responses-model', 'openai-responses'],
    ['future-chat-model', 'openai-completions'],
    ['future-messages-model', 'anthropic-messages'],
  ]) {
    assert.equal(models[id].api, api);
    assert.equal(models[id].provider, 'github-copilot');
    assert.equal(models[id].contextWindow, 1000000);
  }
});

test('public package entry exports Cordis metadata without doing credential/network I/O', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Import must not perform discovery'); };
  try {
    const plugin = await import('../../dist/index.js');
    const { original } = await loadRuntime();
    assert.equal(plugin.Config, original.Config);
    assert.equal(plugin.name, original.name);
    assert.ok(plugin.inject.includes('llm'));
    assert.ok(plugin.inject.includes('credentials'));
    assert.equal(typeof plugin.apply, 'function');
    assert.equal(typeof plugin.syncCopilotCatalog, 'function');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
