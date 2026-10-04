import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, createPlugin, DEFAULT_SEARCH_MODEL, inject, name } from '../dist/plugin.js';
import { COPILOT_SEARCH_PROVIDER_ID } from '../dist/provider.js';
import { contextFixture, credentialFixture, enterprise, grant, runtimeFixture, token } from './auth-helpers.mjs';

function nativeResult() {
  return { status: 'completed', output: [
    { id: 'ws_synthetic', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.invalid/docs' }] } },
    { id: 'msg_synthetic', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic grounded answer',
      annotations: [{ type: 'url_citation', url: 'https://example.invalid/docs', title: 'Synthetic source', start_index: 0, end_index: 9 }] }] },
  ] };
}

function registrationContext(service, registrations) {
  return { ...contextFixture(service),
    web: { registerSearchProvider(provider) { registrations.push(provider); return () => registrations.splice(registrations.indexOf(provider), 1); } },
    llm: { registerAdapter() { throw new Error('Search must not replace an inference adapter'); } },
  };
}

test('search metadata, default schema and registration have no credential/network side effects', () => {
  assert.equal(name, 'web-search-copilot');
  assert.deepEqual(inject, ['web']);
  const config = Config({});
  assert.equal(config.model.get(), DEFAULT_SEARCH_MODEL);
  assert.equal(config.timeoutMs.get(), 60000);
  assert.equal(config.maxResponseBytes.get(), 2097152);
  assert.equal(config.includeSources.get(), true);
  assert.equal(config.forceSearch.get(), false);
  assert.equal(config.searchMode.get(), 'default');
  const fixture = credentialFixture(grant());
  const registrations = [];
  createPlugin(runtimeFixture(), { fetcher: async () => { throw new Error('Registration cannot fetch'); } })
    .apply(registrationContext(fixture.service, registrations), config);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, COPILOT_SEARCH_PROVIDER_ID);
  assert.equal(registrations[0].available(), true);
  assert.equal(fixture.stats.reads, 0);
  assert.equal(fixture.stats.writes, 0);
});

test('configured plugin performs a single native auxiliary request using existing OAuth credentials', async () => {
  const fixture = credentialFixture(grant());
  const registrations = [], calls = [];
  createPlugin(runtimeFixture(), { fetcher: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json(nativeResult());
  } }).apply(registrationContext(fixture.service, registrations), Config({ model: 'synthetic-responses-model' }));
  const result = await registrations[0].search({ query: 'synthetic query', maxResults: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${enterprise}/responses`);
  assert.equal(calls[0].init.headers.get('authorization'), `Bearer ${token()}`);
  assert.equal(calls[0].init.headers.get('x-initiator'), 'agent');
  assert.equal(calls[0].body.model, 'synthetic-responses-model');
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(result.sources, [{ url: 'https://example.invalid/docs', title: 'Synthetic source' }]);
  assert.equal(result.content, 'Synthetic grounded answer');
  assert.equal(fixture.stats.writes, 0);
});

test('volatile settings are snapshotted once per call and update only the next request', async () => {
  const fixture = credentialFixture(grant());
  const registrations = [], calls = [];
  const values = { apiKeyEnv: undefined, baseURL: undefined, model: 'first-synthetic-model', maxTokens: 4096,
    timeoutMs: 60000, maxResponseBytes: 2097152, includeSources: true, searchMode: 'default', forceSearch: false };
  const reads = {};
  const config = Object.fromEntries(Object.keys(values).map((key) => [key, { get() { reads[key] = (reads[key] ?? 0) + 1; return values[key]; } }]));
  createPlugin(runtimeFixture(), { fetcher: async (_url, init) => {
    calls.push(JSON.parse(init.body));
    values.model = 'next-synthetic-model';
    values.forceSearch = true;
    values.searchMode = 'live';
    return Response.json(nativeResult());
  } }).apply(registrationContext(fixture.service, registrations), config);
  await registrations[0].search({ query: 'first query' });
  assert.ok(Object.values(reads).every((count) => count === 1));
  await registrations[0].search({ query: 'next query' });
  assert.ok(Object.values(reads).every((count) => count === 2));
  assert.equal(calls[0].model, 'first-synthetic-model');
  assert.equal(calls[0].tool_choice, undefined);
  assert.deepEqual(calls[0].tools, [{ type: 'web_search' }]);
  assert.equal(calls[1].model, 'next-synthetic-model');
  assert.equal(calls[1].tool_choice, 'required');
  assert.deepEqual(calls[1].tools, [{ type: 'web_search', external_web_access: true }]);
});

test('schema rejects invalid setting types and limits before mounting', () => {
  for (const options of [{ maxTokens: 15 }, { timeoutMs: 0 }, { maxResponseBytes: 1 }, { searchMode: 'unknown' }, { forceSearch: 'yes' }]) {
    assert.throws(() => Config(options));
  }
});
