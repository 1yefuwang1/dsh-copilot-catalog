import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '@deepseek-ai/dsh-llm-pi-ai';
import { createPlugin } from '../../dist/plugin.js';
import { loadRuntime } from '../../dist/runtime.js';
import { replaceCatalog } from '../../dist/catalog.js';
import { accountItem, grantFixture } from '../helpers.mjs';
import { transportResponse } from '../transport-fixtures.mjs';

const enterprise = 'https://api.enterprise.githubcopilot.com';
const copilotToken = (account = 'enterprise') => ['synthetic-token', `proxy-ep=proxy.${account}.githubcopilot.com`].join(';');

function fakeContext(record, key, ambientKey) {
  const registrations = [];
  const credentials = {
    readRecord: async () => record,
    resolve: async (ref) => ref === 'SYNTHETIC_COPILOT_TOKEN' && key ? { value: key, source: 'synthetic' } : undefined,
    listRecords: async () => [],
    modifyRecord: async () => { throw new Error('Valid synthetic credentials must not refresh or persist'); },
    deleteRecord: async () => { throw new Error('Inference must not delete credentials'); },
  };
  const ctx = {
    fiber: { entry: { options: { id: 'llm-pi-ai-catalog' } } },
    get: (name) => name === 'credentials' ? credentials
      : name === 'launchEnvironment' && ambientKey ? { get: (ref) => ref === 'COPILOT_GITHUB_TOKEN' ? { value: ambientKey, source: 'process' } : undefined } : undefined,
    inject() {}, on() {},
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      registerAdapter(routes, adapter) { registrations.push({ routes, adapter }); return { replace() {} }; },
      registerConfigurableProviders() { return { replace() {} }; },
      registerModelDiscovery() {},
    },
  };
  return { ctx, registrations };
}

async function verifyRequests({ record, profile = {}, explicitKey, ambientKey, expectedToken, listingFails = false }) {
  const runtime = await loadRuntime();
  const snapshot = { ...runtime.catalog };
  const originalFetch = globalThis.fetch;
  const requests = [];
  const items = [
    accountItem('gpt-6-sol'), // Known bundled model must route to Enterprise too.
    accountItem('arbitrary-responses-model'),
    accountItem('arbitrary-chat-model', { supported_endpoints: ['/chat/completions'] }),
    accountItem('arbitrary-native-model', { supported_endpoints: ['/v1/messages'] }),
  ];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, enterprise, 'No discovery or inference request may use the Individual endpoint');
    assert.equal(request.headers.get('Authorization'), `Bearer ${expectedToken}`);
    if (request.method === 'GET') {
      assert.equal(url.pathname, '/models');
      requests.push({ path: url.pathname, method: request.method });
      return Response.json({ data: items }, { status: listingFails ? 503 : 200 });
    }
    const body = await request.json();
    requests.push({ path: url.pathname, method: request.method, body });
    const api = { '/responses': 'openai-responses', '/chat/completions': 'openai-completions', '/v1/messages': 'anthropic-messages' }[url.pathname];
    assert.ok(api, 'The actual transport must use its advertised endpoint');
    return transportResponse(api, body.model);
  };
  try {
    const plugin = createPlugin(runtime);
    const { ctx, registrations } = fakeContext(record, explicitKey, ambientKey);
    const config = Config({ providers: { 'github-copilot': profile } });
    const before = structuredClone(config.providers.get());
    await plugin.apply(ctx, config);
    assert.deepEqual(config.providers.get(), before, 'The active settings input must remain untouched');
    assert.equal(registrations.length, 1);
    const { adapter } = registrations[0];
    const selected = listingFails ? ['gpt-6-sol'] : items.map((item) => item.id);
    for (const model of selected) {
      const chunks = [];
      for await (const chunk of adapter.stream({
        provider: 'github-copilot', model, reasoningEffort: 'high',
        system: 'Synthetic test instructions',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.type, 'finish');
      assert.equal(chunks.at(-1)?.reason.kind, 'stop', JSON.stringify(chunks.at(-1)?.reason));
      assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.delta === 'ok') ||
        chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.text === 'ok'));
    }
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1);
    assert.equal(requests.filter((request) => request.method === 'POST').length, selected.length);
    if (!listingFails) {
      const response = requests.find((request) => request.body?.model === 'arbitrary-responses-model').body;
      const chat = requests.find((request) => request.body?.model === 'arbitrary-chat-model').body;
      const native = requests.find((request) => request.body?.model === 'arbitrary-native-model').body;
      assert.equal(response.reasoning.effort, 'high');
      assert.equal(chat.reasoning_effort, 'high');
      assert.deepEqual(native.thinking, { type: 'adaptive', display: 'summarized' });
      assert.equal(native.output_config.effort, 'high');
    }
  } finally {
    globalThis.fetch = originalFetch;
    replaceCatalog(runtime.catalog, snapshot);
  }
}

test('actual DSH adapter routes OAuth Enterprise discovery and all three inference protocols correctly', async () => {
  await verifyRequests({ record: grantFixture({ access: copilotToken() }), expectedToken: copilotToken() });
});

test('actual DSH API-key override uses Enterprise instead of the unrelated stored OAuth account', async () => {
  await verifyRequests({ record: grantFixture({ access: copilotToken('individual') }),
    profile: { apiKeyEnv: 'SYNTHETIC_COPILOT_TOKEN' }, explicitKey: copilotToken(), expectedToken: copilotToken() });
});

test('actual DSH stored API-key path derives Enterprise routing from the access token', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: copilotToken() }, expectedToken: copilotToken() });
});

test('actual DSH ambient API-key path honors the launch-time Enterprise token', async () => {
  await verifyRequests({ record: undefined, ambientKey: copilotToken(), expectedToken: copilotToken() });
});

test('actual DSH opaque API-key path respects an explicitly configured Enterprise baseURL', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: 'synthetic-token' },
    profile: { baseURL: enterprise }, expectedToken: 'synthetic-token' });
});

test('actual DSH inference keeps Enterprise routing when model discovery fails', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: copilotToken() }, expectedToken: copilotToken(), listingFails: true });
});
