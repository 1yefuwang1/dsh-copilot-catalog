import type { WebSearchProvider } from '@deepseek-ai/dsh-web';
import type { CopilotCredentialService } from '../dist/auth.js';
import type { BetterCopilotDependencies } from '../dist/plugin.js';
import type { BetterCopilotConfig, SearchSettings } from '../dist/config.js';
import type { SearchMode } from '../dist/search-types.js';
import { mockFetch, type CapturedRequest, type SearchBody } from './search-fixtures.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import z from '@deepseek-ai/schemastery';
import { createConfig, DEFAULT_SEARCH_MODEL } from '../dist/config.js';
import { createPlugin, inject, name } from '../dist/plugin.js';
import { COPILOT_SEARCH_PROVIDER_ID } from '../dist/provider.js';
import { accountItem, catalogFixture } from './catalog-helpers.js';
import { contextFixture, credentialFixture, enterprise, grant, runtimeFixture, token, authContext } from './search-auth-helpers.js';

const Config = createConfig(z.object({ providers: z.dict(z.any()).default({}).volatile() }));

function nativeResult() {
  return { status: 'completed', output: [
    { id: 'ws_synthetic', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.invalid/docs' }] } },
    { id: 'msg_synthetic', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic grounded answer',
      annotations: [{ type: 'url_citation', url: 'https://example.invalid/docs', title: 'Synthetic source', start_index: 0, end_index: 9 }] }] },
  ] };
}

/** Discovery and search share one fetcher in the merged plugin; route by path. */
function dualFetcher(calls: (CapturedRequest & { body?: SearchBody })[]) {
  return mockFetch(async (url: string, init) => {
    const captured: CapturedRequest & { body?: SearchBody } = { url, init };
    if (init.body) captured.body = JSON.parse(init.body);
    calls.push(captured);
    if (url.endsWith('/models')) {
      return Response.json({ data: [accountItem('gpt-6-sol'), accountItem('gpt-5.6-sol'), accountItem('claude')] });
    }
    return Response.json(nativeResult());
  });
}

function dependencies(overrides: Partial<BetterCopilotDependencies> = {}): BetterCopilotDependencies {
  return {
    ...runtimeFixture(),
    original: {
      name: 'llm-pi-ai', Config: z.object({ providers: z.dict(z.any()) }), inject: ['llm'],
      recordKeyFor: () => 'llm-pi-ai/github-copilot', apply: () => Promise.resolve(),
    } as unknown as BetterCopilotDependencies['original'],
    catalog: { ...catalogFixture() },
    installIdentity: () => () => {},
    ...overrides,
  };
}

function registrationContext(service: CopilotCredentialService, registrations: WebSearchProvider[]) {
  const base = contextFixture(service);
  return authContext({
    ...base,
    effect(execute: () => () => void) { return execute(); },
    on() { return { dispose() {} }; },
    inject(_deps: string[], callback: (child: { web: { registerSearchProvider(provider: WebSearchProvider): () => void } }) => void) {
      callback({
        web: {
          registerSearchProvider(provider: WebSearchProvider) {
            registrations.push(provider);
            return () => registrations.splice(registrations.indexOf(provider), 1);
          },
        },
      });
      return () => {};
    },
    llm: { registerAdapter() { throw new Error('Search must not replace an inference adapter'); } },
  });
}

test('search metadata, defaults and registration keep credential writes and requests at zero', async () => {
  assert.equal(name, 'better-copilot');
  assert.deepEqual(inject, ['llm', 'credentials']);
  const defaults = Config({});
  assert.equal(defaults.search.model.get(), DEFAULT_SEARCH_MODEL);
  assert.equal(defaults.search.timeoutMs.get(), 60000);
  assert.equal(defaults.search.maxResponseBytes.get(), 2097152);
  assert.equal(defaults.search.includeSources.get(), true);
  assert.equal(defaults.search.forceSearch.get(), false);
  assert.equal(defaults.search.searchMode.get(), 'default');
  const fixture = credentialFixture(grant());
  const registrations: WebSearchProvider[] = [];
  const calls: (CapturedRequest & { body?: SearchBody })[] = [];
  // Capability-local proof: count credential read *attempts* and assert zero at the
  // exact moment the provider registers, before mount-time discovery runs.
  let readAttempts = 0;
  const strictService: CopilotCredentialService = {
    ...fixture.service,
    readRecord: async () => { readAttempts++; throw new Error('search registration must not read credentials'); },
  };
  const context = authContext({
    ...contextFixture(strictService),
    effect: (execute: () => () => void) => execute(),
    on: () => ({ dispose() {} }),
    inject: (_deps: string[], callback: (child: { web: { registerSearchProvider(provider: WebSearchProvider): () => void } }) => void) => {
      callback({ web: { registerSearchProvider(provider: WebSearchProvider) {
        assert.equal(readAttempts, 0, 'search registration performs no credential read');
        registrations.push(provider);
        return () => {};
      } } });
      return () => {};
    },
    llm: { registerAdapter() { throw new Error('Search must not replace an inference adapter'); } },
  });
  const mounting = createPlugin(dependencies({ fetcher: dualFetcher(calls) }))
    .apply(context, Config({}));
  assert.equal(registrations.length, 1, 'registered without any credential read');
  assert.equal(registrations[0]!.id, COPILOT_SEARCH_PROVIDER_ID);
  assert.equal(registrations[0]!.available(), true);
  await mounting;
  // Only the separate discovery step reads; it fails open: no request, no write.
  assert.equal(readAttempts, 1, 'mount-time discovery is the only reader');
  assert.deepEqual(calls, []);
  assert.equal(fixture.stats.writes, 0);

  // The healthy path performs exactly one mount-time catalog request and no search.
  const healthy: (CapturedRequest & { body?: SearchBody })[] = [];
  const healthyFixture = credentialFixture(grant());
  await createPlugin(dependencies({ fetcher: dualFetcher(healthy) }))
    .apply(registrationContext(healthyFixture.service, []), Config({}));
  assert.deepEqual(healthy.map((call) => new URL(call.url).pathname), ['/models']);
  assert.equal(healthyFixture.stats.writes, 0);
});

test('configured plugin performs a single native auxiliary request using existing OAuth credentials', async () => {
  const fixture = credentialFixture(grant());
  const registrations: WebSearchProvider[] = [];
  const calls: (CapturedRequest & { body?: SearchBody })[] = [];
  await createPlugin(dependencies({ fetcher: dualFetcher(calls) }))
    .apply(registrationContext(fixture.service, registrations), Config({ search: { model: 'synthetic-responses-model' } }));
  const result = await registrations[0]!.search({ query: 'synthetic query', maxResults: 1 });
  const dispatched = calls.filter((call) => new URL(call.url).pathname === '/responses');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.url, `${enterprise}/responses`);
  assert.equal(dispatched[0]!.init.headers.get('authorization'), `Bearer ${token()}`);
  assert.equal(dispatched[0]!.init.headers.get('x-initiator'), 'agent');
  assert.equal(dispatched[0]!.body!.model, 'synthetic-responses-model');
  assert.deepEqual(dispatched[0]!.body!.tools, [{ type: 'web_search' }]);
  assert.deepEqual(result.sources, [{ url: 'https://example.invalid/docs', title: 'Synthetic source' }]);
  assert.equal(result.content, 'Synthetic grounded answer');
  assert.equal(fixture.stats.writes, 0);
});

test('volatile settings are snapshotted once per call and update only the next request', async () => {
  const fixture = credentialFixture(grant());
  const registrations: WebSearchProvider[] = [];
  const calls: (CapturedRequest & { body?: SearchBody })[] = [];
  const values: { apiKeyEnv?: string; baseURL?: string; model: string; maxTokens: number; timeoutMs: number; maxResponseBytes: number; includeSources: boolean; searchMode: SearchMode; forceSearch: boolean } = { apiKeyEnv: undefined, baseURL: undefined, model: 'first-synthetic-model', maxTokens: 4096,
    timeoutMs: 60000, maxResponseBytes: 2097152, includeSources: true, searchMode: 'default', forceSearch: false };
  const reads: Record<string, number> = {};
  // Volatile-setting doubles expose only get(); the plugin never reads other schema methods.
  const search = Object.fromEntries((Object.keys(values) as (keyof typeof values)[]).map((key) => [key, { get() { reads[key] = (reads[key] ?? 0) + 1; return values[key]; } }])) as unknown as SearchSettings;
  const config: BetterCopilotConfig = {
    providers: { get: () => ({}) },
    search,
    toolSchema: { providers: { get: () => ['github-copilot'] }, families: { get: () => ['gemini'] }, logFixes: { get: () => false } },
  };
  await createPlugin(dependencies({ fetcher: mockFetch(async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [accountItem('gpt-6-sol')] });
    calls.push({ url, init, body: JSON.parse(init.body) });
    values.model = 'next-synthetic-model';
    values.forceSearch = true;
    values.searchMode = 'live';
    return Response.json(nativeResult());
  }) })).apply(registrationContext(fixture.service, registrations), config);
  await registrations[0]!.search({ query: 'first query' });
  assert.ok(Object.values(reads).every((count) => count === 1));
  await registrations[0]!.search({ query: 'next query' });
  assert.ok(Object.values(reads).every((count) => count === 2));
  assert.equal(calls[0]!.body!.model, 'first-synthetic-model');
  assert.equal(calls[0]!.body!.tool_choice, undefined);
  assert.deepEqual(calls[0]!.body!.tools, [{ type: 'web_search' }]);
  assert.equal(calls[1]!.body!.model, 'next-synthetic-model');
  assert.equal(calls[1]!.body!.tool_choice, 'required');
  assert.deepEqual(calls[1]!.body!.tools, [{ type: 'web_search', external_web_access: true }]);
});

test('schema rejects invalid search setting types and limits before mounting', () => {
  for (const options of [{ maxTokens: 15 }, { timeoutMs: 0 }, { maxResponseBytes: 1 }, { searchMode: 'unknown' }, { forceSearch: 'yes' }]) {
    // Exercise runtime schema rejection of deliberately invalid values.
    assert.throws(() => Config({ search: options as never }));
  }
});
