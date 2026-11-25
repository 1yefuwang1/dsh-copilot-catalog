import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replaceCatalog } from '../../dist/catalog.js';
import { createCatalogCacheEntry, opencodeCacheScope } from '../../dist/catalog-cache.js';
import { opencodeCatalogFixture } from '../opencode-helpers.js';
import { normalizeOpencodeCatalog } from '../../dist/opencode.js';
import { syncOpencodeCatalog } from '../../dist/opencode-discovery.js';
import { loadRuntime } from '../../dist/runtime.js';
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models';
import { builtinProviders, getAllBuiltinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai';

function liveResponse(...models: { id: string; api: Record<string, unknown>; limit?: Record<string, unknown> }[]) {
  return Response.json({
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      type: 'chat',
      name: model.id,
      api: model.api,
      modalities: { input: ['text'] },
      capabilities: { tools: { supported: true }, temperature: true, reasoning: { supported: true, effort: ['low', 'high'] } },
      limit: model.limit ?? { context: 200_000, output: 64_000 },
      cost: { text: { input: { price: 1 }, output: { price: 2 } } },
    })),
  });
}

test('the runtime resolves the adapter-owned OpenCode Go chat catalog', async () => {
  const runtime = await loadRuntime();
  assert.equal(runtime.opencodeGoCatalog, OPENCODE_GO_MODELS);
  assert.ok(Object.keys(runtime.opencodeGoCatalog).length > 0);
  assert.ok(Object.keys(runtime.opencodeGoCatalog).every((id) => runtime.opencodeGoCatalog[id]!.provider === 'opencode-go'));
});

test('discovery mutates only the OpenCode Go chat catalog visible to the real adapter', async () => {
  const { opencodeGoCatalog } = await loadRuntime();
  const snapshot = { ...opencodeGoCatalog };
  const others = () => builtinProviders()
    .filter((provider) => provider.id !== 'opencode-go')
    .map((provider) => provider.id + ':' + getAllBuiltinModels(provider.id as Parameters<typeof getAllBuiltinModels>[0])
      .map((model) => model.id).join(','));
  const othersBefore = others();
  try {
    const result = await syncOpencodeCatalog({
      catalog: opencodeGoCatalog,
      baselineCatalog: opencodeCatalogFixture(),
      fetcher: async () => liveResponse(
        { id: 'future-openai-model', api: { 'chat-completions': {} } },
        { id: 'future-messages-model', api: { messages: {} } },
        { id: 'future-responses-model', api: { responses: {} } },
      ),
    });
    assert.equal(result.status, 'synced');
    assert.deepEqual(getBuiltinModels('opencode-go').map((model) => model.id),
      ['future-openai-model', 'future-messages-model', 'future-responses-model']);
    const provider = builtinProviders().find((value) => value.id === 'opencode-go');
    assert.ok(provider);
    assert.deepEqual(provider.getModels().map((model) => model.id),
      ['future-openai-model', 'future-messages-model', 'future-responses-model']);
    for (const model of provider.getModels()) {
      assert.ok(supportedProtocols().includes(model.api), `${model.api} remains serviceable by the published adapter`);
      assert.equal(model.provider, 'opencode-go');
      assert.ok(model.type === undefined || model.type === 'chat');
    }
    assert.deepEqual(others(), othersBefore, 'only the OpenCode Go chat catalog is mutated');
  } finally {
    replaceCatalog(opencodeGoCatalog, snapshot);
  }
  assert.deepEqual(Object.keys(opencodeGoCatalog), Object.keys(snapshot));
});

test('a cached OpenCode selection also reaches the real adapter catalog APIs', async () => {
  const { opencodeGoCatalog } = await loadRuntime();
  const snapshot = { ...opencodeGoCatalog };
  try {
    const normalized = {
      object: 'list',
      data: [{
        id: 'synthetic-cached-model', type: 'chat', name: 'Synthetic cached model',
        api: { 'chat-completions': {} }, modalities: { input: ['text'] },
        capabilities: { tools: { supported: true }, temperature: true, reasoning: { supported: false } },
        limit: { context: 128_000, output: 32_000 },
        cost: { text: { input: { price: 0 }, output: { price: 0 } } },
      }],
    };
    const scope = opencodeCacheScope('https://opencode.ai/inference/go/v1/models');
    const metadata = normalizeOpencodeCatalog(normalized)!;
    const entry = createCatalogCacheEntry(scope, { data: metadata.data as unknown as Record<string, unknown>[] },
      1_800_000_000_000, [], 'opencode-go')!;
    const cache = {
      async read() { return entry; },
      async write() {},
    };
    const result = await syncOpencodeCatalog({
      catalog: opencodeGoCatalog,
      baselineCatalog: opencodeCatalogFixture(),
      cache,
      now: () => 1_800_000_000_000,
      fetcher: async () => { throw new Error('synthetic offline'); },
    });
    assert.equal(result.status, 'cached');
    assert.deepEqual(getBuiltinModels('opencode-go').map((model) => model.id), ['synthetic-cached-model']);
  } finally {
    replaceCatalog(opencodeGoCatalog, snapshot);
  }
});
