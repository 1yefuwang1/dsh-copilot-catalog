import { mockFetch, type SearchBody, type HttpRequestInit } from '../search-fixtures.js';
import type { WebSearchProvider } from '@deepseek-ai/dsh-web';
import type { CopilotCredentialService } from '../../dist/auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createModels } from '@earendil-works/pi-ai';
import { WebRuntime } from '@deepseek-ai/dsh-web';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import { loadRuntime } from '../../dist/runtime.js';
import { COPILOT_SEARCH_PROVIDER_ID } from '../../dist/provider.js';
import { createPlugin } from '../../dist/plugin.js';
import { Config, runtimeDependencies } from '../merged-fixtures.js';
import { contextFixture, credentialFixture, enterprise, ghe, gheToken, grant, token, authContext } from '../search-auth-helpers.js';

const resultBody = () => ({ status: 'completed', output: [
  { id: 'ws_synthetic', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
    { type: 'url', url: 'https://example.invalid/one' }, { type: 'url', url: 'https://example.invalid/two' },
  ] } },
  { id: 'msg_synthetic', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic answer', annotations: [] }] },
] });
/** Parse the same plain provider ids the shipped cordis.patch.yml supplies; rc.3 yields live volatile refs. */
const webConfig = () => WebRuntime.Config({ searchProvider: COPILOT_SEARCH_PROVIDER_ID, fetchProvider: 'http' });

/** The merged plugin also injects a web service and installs guard/identity seams. */
function mergedContext(service: CopilotCredentialService, web: { registerSearchProvider(provider: WebSearchProvider): () => void }) {
  return authContext({
    ...contextFixture(service),
    effect: (execute: () => () => void) => execute(),
    on: () => ({ dispose() {} }),
    inject: (_deps: string[], callback: (child: { web: typeof web }) => void) => { callback({ web }); return () => {}; },
    web,
  });
}

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

test('published merged entry loads real peers without credential reads or network requests', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Import must never fetch'); };
  try {
    const plugin = await import('dsh-better-copilot');
    assert.equal(plugin.name, 'better-copilot');
    assert.equal(typeof plugin.Config, 'function');
    assert.equal(typeof plugin.apply, 'function');
    assert.deepEqual(plugin.inject, ['llm', 'credentials']);
    assert.equal(plugin.COPILOT_SEARCH_PROVIDER_ID, COPILOT_SEARCH_PROVIDER_ID);
    assert.equal(typeof plugin.syncCopilotCatalog, 'function');
  } finally { globalThis.fetch = originalFetch; }
});

test('GHE search resolves and refreshes real public auth through the actual DSH web seam', async () => {
  const requests: string[] = [];
  const runtime = await loadRuntime({ fetcher: mockFetch<HttpRequestInit>(async (url, init) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    if (url === 'https://api.company.ghe.com/copilot_internal/v2/token') {
      assert.equal(init.headers.get('authorization'), 'Bearer test-refresh-token');
      return Response.json({ token: gheToken(), expires_at: Math.floor(Date.now() / 1000) + 1800 });
    }
    assert.equal(url, `${ghe}/models`);
    assert.equal(init.headers.get('authorization'), `Bearer ${gheToken()}`);
    return Response.json({ data: [{ id: 'synthetic-responses-model', model_picker_enabled: true, policy: { state: 'enabled' } }] });
  }) });
  const host = new Context();
  const web = new WebRuntime(host, webConfig());
  const fixture = credentialFixture(grant({ access: gheToken(), enterpriseUrl: 'company.ghe.com', expires: 0 }));
  let dispose!: () => void;
  const ctx = mergedContext(fixture.service, { registerSearchProvider(provider: WebSearchProvider) {
    dispose = web.registerSearchProvider(provider);
    return dispose;
  } });
  await createPlugin(runtimeDependencies(runtime, { fetcher: mockFetch(async (url, init) => {
    requests.push(url);
    assert.equal(url, `${ghe}/responses`);
    assert.equal(init.headers.get('authorization'), `Bearer ${gheToken()}`);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(init.body).tools, [{ type: 'web_search' }]);
    return Response.json(resultBody());
  }) })).apply(ctx, Config({ search: { model: 'synthetic-responses-model' } }));
  try {
    const result = await web.search({ query: 'synthetic GHE query', maxResults: 1 });
    assert.equal(result.sources.length, 1);
    assert.equal(result.truncated, true);
    assert.deepEqual(requests, [
      'https://api.company.ghe.com/copilot_internal/v2/token', `${ghe}/models`, `${ghe}/responses`,
    ]);
    assert.equal(fixture.stats.writes, 1);
    assert.equal(fixture.current().payload.enterpriseUrl, 'company.ghe.com');
    assert.equal(fixture.current().payload.refresh, 'test-refresh-token');
  } finally { dispose(); }
});

test('rc.3 web selection and account credentials are resolved again without remounting', async () => {
  const runtime = await loadRuntime();
  const host = new Context();
  const config = webConfig();
  let selected = COPILOT_SEARCH_PROVIDER_ID;
  // Preserve the public volatile-reference protocol while simulating a loader update.
  const web = new WebRuntime(host, {
    ...config, searchProvider: Object.freeze({ ...config.searchProvider, get: () => selected }),
  });
  const fixture = credentialFixture(grant());
  const requests: { url: string; authorization: string | null }[] = [];
  let dispose!: () => void;
  const ctx = mergedContext(fixture.service, { registerSearchProvider(provider: WebSearchProvider) {
    dispose = web.registerSearchProvider(provider);
    return dispose;
  } });
  await createPlugin(runtimeDependencies(runtime, { fetcher: mockFetch(async (url, init) => {
    // Mount-time catalog discovery is a separate concern from search dispatch.
    if (String(url).endsWith('/models')) return Response.json({ data: [] });
    requests.push({ url, authorization: init.headers.get('authorization') });
    return Response.json(resultBody());
  }) })).apply(ctx, Config({ search: { model: 'synthetic-responses-model' } }));
  try {
    await web.search({ query: 'first account' });
    selected = 'missing-synthetic-search';
    await assert.rejects(web.search({ query: 'selector changed' }),
      (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
    assert.equal(requests.length, 1, 'unselected provider never dispatches');
    fixture.set(grant({ access: gheToken(), enterpriseUrl: 'company.ghe.com' }));
    selected = COPILOT_SEARCH_PROVIDER_ID;
    await web.search({ query: 'next account' });
    assert.deepEqual(requests, [
      { url: `${enterprise}/responses`, authorization: `Bearer ${token()}` },
      { url: `${ghe}/responses`, authorization: `Bearer ${gheToken()}` },
    ]);
    assert.equal(fixture.stats.writes, 0, 'unexpired account rotation needs no persisted refresh');
  } finally { dispose(); }
});

test('rc.3 web directory lists Copilot and reports search registration/disposal while preserving result limits', async () => {
  const runtime = await loadRuntime();
  const host = new Context();
  let directoryChanges = 0;
  host.on('web/providers-changed', () => { directoryChanges++; });
  const web = new WebRuntime(host, webConfig());
  assert.deepEqual(web.listProviders(), { search: [], fetch: [] });
  const fixture = credentialFixture(grant());
  const registrations: (() => void)[] = [];
  const requests: SearchBody[] = [];
  const ctx = mergedContext(fixture.service, { registerSearchProvider(provider: WebSearchProvider) {
    const dispose = web.registerSearchProvider(provider);
    registrations.push(dispose);
    return dispose;
  } });
  await createPlugin(runtimeDependencies(runtime, { fetcher: mockFetch(async (url, init) => {
    assert.equal(new URL(url).origin, enterprise);
    assert.equal(init.headers.get('authorization'), `Bearer ${token()}`);
    requests.push(JSON.parse(init.body));
    return Response.json(resultBody());
  }) })).apply(ctx, Config({ search: { model: 'synthetic-responses-model' } }));
  assert.deepEqual(web.listProviders().search.map(({ id }) => id), [COPILOT_SEARCH_PROVIDER_ID]);
  assert.deepEqual(web.listProviders().fetch, []);
  assert.equal(directoryChanges, 1);
  const result = await web.search({ query: 'synthetic query', maxResults: 1 });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.tools, [{ type: 'web_search' }]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(fixture.stats.writes, 0);
  registrations[0]!();
  assert.deepEqual(web.listProviders(), { search: [], fetch: [] });
  assert.equal(directoryChanges, 2);
  await assert.rejects(web.search({ query: 'after disposal' }), (error) => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING');
});
