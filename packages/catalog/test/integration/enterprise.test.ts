import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { PluginContext } from '../../dist/types.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '@deepseek-ai/dsh-llm-pi-ai';
import { createPlugin } from '../../dist/plugin.js';
import { loadRuntime } from '../../dist/runtime.js';
import { replaceCatalog } from '../../dist/catalog.js';
import { accountItem, grantFixture } from '../helpers.js';
import { transportResponse } from '../transport-fixtures.js';
type AdapterRegistration = Parameters<PluginContext['llm']['registerAdapter']>;
interface InferenceBody { model: string; reasoning?: { effort?: string }; reasoning_effort?: string; thinking?: unknown; output_config?: { effort?: string } }
interface RecordedRequest { path: string; method: string; body?: InferenceBody }
interface VerifyOptions { record: CredentialRecord | undefined; profile?: { apiKeyEnv?: string; baseURL?: string }; explicitKey?: string; ambientKey?: string; expectedToken: string; expectedOrigin?: string; listingFails?: boolean }


const enterprise = 'https://api.enterprise.githubcopilot.com';
const ghe = 'https://copilot-api.msft.ghe.com';
const copilotToken = (account = 'enterprise') => ['synthetic-token', `proxy-ep=proxy.${account}.githubcopilot.com`].join(';');
const gheToken = 'synthetic-token;proxy-ep=copilot-api.msft.ghe.com';

function fakeContext(record: CredentialRecord | undefined, key?: string, ambientKey?: string) {
  const registrations: { routes: AdapterRegistration[0]; adapter: AdapterRegistration[1] }[] = [];
  const effects: (() => void)[] = [];
  const credentials = {
    readRecord: async () => record,
    resolve: async (ref: string) => ref === 'SYNTHETIC_COPILOT_TOKEN' && key ? { value: key, source: 'synthetic' } : undefined,
    listRecords: async () => [],
    modifyRecord: async () => { throw new Error('Valid synthetic credentials must not refresh or persist'); },
    deleteRecord: async () => { throw new Error('Inference must not delete credentials'); },
  };
  const ctx = {
    fiber: { entry: { options: { id: 'llm-pi-ai-catalog' } } },
    get: (name: string) => name === 'credentials' ? credentials
      : name === 'launchEnvironment' && ambientKey ? { get: (ref: string) => ref === 'COPILOT_GITHUB_TOKEN' ? { value: ambientKey, source: 'process' } : undefined } : undefined,
    inject() {}, on() {},
    effect(execute: () => () => void) { effects.push(execute()); },
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      registerAdapter(routes: AdapterRegistration[0], adapter: AdapterRegistration[1]) { registrations.push({ routes, adapter }); return { replace() {} }; },
      registerConfigurableProviders() { return { replace() {} }; },
      registerModelDiscovery() {},
    },
  };
  return { ctx, registrations, dispose: () => { for (const release of effects.splice(0)) release(); } };
}

async function verifyRequests({ record, profile = {}, explicitKey, ambientKey, expectedToken, expectedOrigin = enterprise, listingFails = false }: VerifyOptions) {
  const runtime = await loadRuntime();
  const snapshot = { ...runtime.catalog };
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const items = [
    accountItem('gpt-6-sol'), // Known bundled model must route to the account endpoint too.
    accountItem('arbitrary-responses-model'),
    accountItem('arbitrary-chat-model', { supported_endpoints: ['/chat/completions'] }),
    accountItem('arbitrary-native-model', { supported_endpoints: ['/v1/messages'] }),
  ];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, expectedOrigin, 'Every discovery and inference request must use the expected account endpoint');
    assert.equal(request.headers.get('Authorization'), `Bearer ${expectedToken}`);
    if (request.method === 'GET') {
      assert.equal(url.pathname, '/models');
      assert.equal(request.headers.get('User-Agent'), 'GitHubCopilotChat/0.68.0');
      assert.equal(request.headers.get('Editor-Version'), 'vscode/1.140.0');
      assert.equal(request.headers.get('Editor-Plugin-Version'), 'copilot-chat/0.68.0');
      assert.equal(request.headers.get('Copilot-Integration-Id'), 'vscode-chat');
      assert.equal(request.headers.get('X-GitHub-Api-Version'), '2026-08-01');
      assert.equal(request.headers.get('Openai-Intent'), 'model-access');
      assert.equal(request.headers.get('X-Interaction-Type'), 'model-access');
      assert.equal(request.headers.get('Content-Type'), null);
      assert.equal(request.headers.get('X-Interaction-Id'), null);
      assert.equal(request.headers.get('X-VSCode-User-Agent-Library-Version'), 'electron-fetch');
      assert.match(request.headers.get('Editor-Device-Id') ?? '', /^[0-9a-f-]{36}$/iu);
      assert.match(request.headers.get('VScode-MachineId') ?? '', /^[0-9a-f-]{36}$/iu);
      assert.match(request.headers.get('VScode-SessionId') ?? '', /^[0-9a-f-]{36}$/iu);
      assert.match(request.headers.get('X-Request-Id') ?? '', /^[0-9a-f-]{36}$/iu);
      assert.match(request.headers.get('X-Agent-Task-Id') ?? '', /^[0-9a-f-]{36}$/iu);
      assert.equal([...request.headers.keys()].some((name) => name.startsWith('x-stainless-')), false);
      requests.push({ path: url.pathname, method: request.method });
      return Response.json({ data: items }, { status: listingFails ? 503 : 200 });
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('User-Agent'), 'GitHubCopilotChat/0.68.0');
    assert.equal(request.headers.get('Editor-Version'), 'vscode/1.140.0');
    assert.equal(request.headers.get('Editor-Plugin-Version'), 'copilot-chat/0.68.0');
    assert.equal(request.headers.get('Copilot-Integration-Id'), 'vscode-chat');
    assert.equal(request.headers.get('X-GitHub-Api-Version'), '2026-08-01');
    assert.equal(request.headers.get('Openai-Intent'), 'conversation-agent');
    assert.equal(request.headers.get('X-Interaction-Type'), 'conversation-agent');
    assert.equal(request.headers.get('X-Initiator'), 'user');
    assert.equal(request.headers.get('X-VSCode-User-Agent-Library-Version'), 'electron-fetch');
    assert.equal([...request.headers.keys()].some((name) => name.startsWith('x-stainless-')), false);
    if (url.pathname === '/v1/messages') {
      assert.equal(request.headers.get('Anthropic-Version'), '2023-06-01');
      assert.equal(request.headers.get('Anthropic-Dangerous-Direct-Browser-Access'), null);
    }
    const body: InferenceBody = await request.json();
    requests.push({ path: url.pathname, method: request.method, body });
    const api = ({ '/responses': 'openai-responses', '/chat/completions': 'openai-completions', '/v1/messages': 'anthropic-messages' } as Record<string, string>)[url.pathname];
    assert.ok(api, 'The actual transport must use its advertised endpoint');
    return transportResponse(api, body.model);
  };
  const plugin = createPlugin(runtime);
  const { ctx, registrations, dispose } = fakeContext(record, explicitKey, ambientKey);
  try {
    const config = Config({ providers: { 'github-copilot': profile } });
    const before = structuredClone(config.providers.get());
    await plugin.apply(ctx as unknown as PluginContext, config);
    assert.deepEqual(config.providers.get(), before, 'The active settings input must remain untouched');
    if (listingFails) assert.deepEqual(runtime.catalog, snapshot, 'Failed discovery must preserve the bundled catalog');
    assert.equal(registrations.length, 1);
    const { adapter } = registrations[0]!;
    const selected = listingFails ? ['gpt-6-sol'] : items.map((item) => item.id);
    for (const model of selected) {
      const chunks = [];
      for await (const chunk of adapter.stream({
        provider: 'github-copilot', model, reasoningEffort: 'high' as Parameters<AdapterRegistration[1]['stream']>[0]['reasoningEffort'],
        system: 'Synthetic test instructions',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) chunks.push(chunk);
      const finish = chunks.at(-1);
      assert.ok(finish && finish.type === 'finish');
      assert.equal(finish.reason.kind, 'stop', JSON.stringify(finish.reason));
      assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && 'delta' in chunk && chunk.delta === 'ok') ||
        chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text === 'ok'));
    }
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1);
    assert.equal(requests.filter((request) => request.method === 'POST').length, selected.length);
    for (const model of selected) {
      const request = requests.find((request) => request.body?.model === model);
      const expectedPath = (items.find((item) => item.id === model)!.supported_endpoints as string[])[0];
      assert.equal(request?.path, expectedPath, `${model} must use its advertised inference protocol`);
    }
    if (!listingFails) {
      const response = requests.find((request) => request.body?.model === 'arbitrary-responses-model')!.body!;
      const chat = requests.find((request) => request.body?.model === 'arbitrary-chat-model')!.body!;
      const native = requests.find((request) => request.body?.model === 'arbitrary-native-model')!.body!;
      assert.equal(response.reasoning!.effort, 'high');
      assert.equal(chat.reasoning_effort, 'high');
      assert.deepEqual(native.thinking, { type: 'adaptive', display: 'summarized' });
      assert.equal(native.output_config!.effort, 'high');
    }
  } finally {
    dispose();
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

test('actual DSH OAuth enterpriseUrl fallback routes GHE discovery and all three inference protocols', async () => {
  await verifyRequests({ record: grantFixture({ enterpriseUrl: 'msft.ghe.com', access: 'synthetic-token' }),
    expectedToken: 'synthetic-token', expectedOrigin: ghe });
});

test('actual DSH OAuth proxy-ep routes GHE discovery and all three inference protocols', async () => {
  await verifyRequests({ record: grantFixture({ access: gheToken }), expectedToken: gheToken, expectedOrigin: ghe });
});

test('actual DSH stored API-key proxy-ep routes GHE discovery and all three inference protocols', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: gheToken }, expectedToken: gheToken, expectedOrigin: ghe });
});

test('actual DSH opaque API-key path respects an explicitly configured GHE baseURL', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: 'synthetic-token' },
    profile: { baseURL: ghe }, expectedToken: 'synthetic-token', expectedOrigin: ghe });
});

test('actual DSH OAuth enterpriseUrl fallback keeps GHE routing for the bundled model when listing fails', async () => {
  await verifyRequests({ record: grantFixture({ enterpriseUrl: 'msft.ghe.com', access: 'synthetic-token' }),
    expectedToken: 'synthetic-token', expectedOrigin: ghe, listingFails: true });
});

test('actual DSH API-key proxy-ep keeps GHE routing for the bundled model when listing fails', async () => {
  await verifyRequests({ record: { kind: 'api-key', key: gheToken },
    expectedToken: gheToken, expectedOrigin: ghe, listingFails: true });
});
