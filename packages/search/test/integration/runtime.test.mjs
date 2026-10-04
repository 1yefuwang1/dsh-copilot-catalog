import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createModels } from '@earendil-works/pi-ai';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { loadRuntime } from '../../dist/runtime.js';
import { COPILOT_SEARCH_PROVIDER_ID } from '../../dist/provider.js';
import { contextFixture, credentialFixture, enterprise, grant, token } from '../auth-helpers.mjs';

const resultBody = () => ({ status: 'completed', output: [
  { id: 'ws_synthetic', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
    { type: 'url', url: 'https://example.invalid/one' }, { type: 'url', url: 'https://example.invalid/two' },
  ] } },
  { id: 'msg_synthetic', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic answer', annotations: [] }] },
] });

test('runtime uses the adapter-resolved real public pi-ai collection and unchanged credential key', async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.createModels, createModels);
  assert.equal(runtime.recordKeyFor, recordKeyFor);
  assert.equal(String(runtime.recordKeyFor('github-copilot')), 'llm-pi-ai/github-copilot');
  assert.equal(runtime.provider.id, 'github-copilot');
  const auth = await runtime.oauth.toAuth({ type: 'oauth', access: token(), refresh: 'synthetic', expires: 0 });
  assert.equal(auth.baseUrl, enterprise);
  assert.ok(!Object.keys(runtime.headers).some((key) => key.toLowerCase() === 'authorization'));
});

test('published search entry loads real peers without credential reads or network requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Import must never fetch'); };
  try {
    const plugin = await import('dsh-copilot-search');
    assert.equal(plugin.name, 'web-search-copilot');
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(typeof plugin.apply, 'function');
    assert.deepEqual(plugin.inject, ['web']);
    assert.equal(plugin.COPILOT_SEARCH_PROVIDER_ID, COPILOT_SEARCH_PROVIDER_ID);
  } finally { globalThis.fetch = originalFetch; }
});

test('actual DSH web seam selects the Copilot provider, caps results, and disposes registration', async () => {
  const { createPlugin, Config } = await import('../../dist/plugin.js');
  const runtime = await loadRuntime();
  const host = new Context();
  const web = new WebRuntime(host, { searchProvider: COPILOT_SEARCH_PROVIDER_ID, fetchProvider: 'http' });
  const fixture = credentialFixture(grant());
  const registrations = [];
  const requests = [];
  const ctx = { ...contextFixture(fixture.service), web: { registerSearchProvider(provider) {
    const dispose = web.registerSearchProvider(provider);
    registrations.push(dispose);
    return dispose;
  } } };
  createPlugin(runtime, { fetcher: async (url, init) => {
    assert.equal(new URL(url).origin, enterprise);
    assert.equal(init.headers.get('authorization'), `Bearer ${token()}`);
    requests.push(JSON.parse(init.body));
    return Response.json(resultBody());
  } }).apply(ctx, Config({ model: 'synthetic-responses-model' }));
  const result = await web.search({ query: 'synthetic query', maxResults: 1 });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools, [{ type: 'web_search' }]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(fixture.stats.writes, 0);
  registrations[0]();
  await assert.rejects(web.search({ query: 'after disposal' }), (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
});
