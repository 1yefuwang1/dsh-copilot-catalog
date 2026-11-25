import assert from 'node:assert/strict';
import { test } from 'node:test';
import z from '@deepseek-ai/schemastery';
import { createConfig } from '../dist/config.js';
import { createCatalogCacheEntry, opencodeCacheScope } from '../dist/catalog-cache.js';
import { normalizeOpencodeCatalog } from '../dist/opencode.js';
import { createPlugin } from '../dist/plugin.js';
import type { BetterCopilotDependencies } from '../dist/plugin.js';
import type { CatalogCache, CatalogCacheEntry, CatalogCacheScope, OriginalAdapter, PluginContext } from '../dist/catalog-types.js';
import { accountItem, discoveryFixture, runtimeDependencies } from './catalog-helpers.js';
import { opencodeCatalogFixture, opencodeDocument, opencodeItem, opencodeResponse } from './opencode-helpers.js';

const FakeAdapterConfig = z.object({ providers: z.dict(z.any()).default({}).volatile() });
const Config = createConfig(FakeAdapterConfig);
const INTERVAL = 900_000;

interface FixtureOverrides {
  providers?: Record<string, Record<string, unknown>>;
  catalogProviders?: string[];
  opencodeModels?: Record<string, unknown>[];
  opencodeOffline?: boolean;
  cache?: CatalogCache;
  now?: () => number;
}

function fixture(overrides: FixtureOverrides = {}) {
  let clock = Date.now();
  const now = overrides.now ?? (() => clock);
  const events: [string, ...unknown[]][] = [];
  const warnings: unknown[][] = [];
  const effects: (() => void)[] = [];
  const registered: { providers: string[]; adapter: Record<string, unknown> }[] = [];
  const calls = { copilot: 0, opencode: 0 };
  let applied: { ctx: unknown; config: { providers: { get(): Record<string, unknown> } } } | undefined;
  let opencodeModels = overrides.opencodeModels ?? [opencodeItem('glm-5.3'), opencodeItem('synthetic-live-model')];
  const fetcher = async (input: URL | RequestInfo) => {
    if (String(input).startsWith('https://opencode.ai')) {
      calls.opencode++;
      if (overrides.opencodeOffline) throw new Error('synthetic opencode offline');
      return opencodeResponse(opencodeDocument(...opencodeModels));
    }
    calls.copilot++;
    return { ok: true, json: async () => ({ data: [accountItem('gpt-6-sol')] }) };
  };
  const discovery = discoveryFixture({ fetcher: fetcher as never, now });
  const opencodeCatalog = opencodeCatalogFixture();
  const opencodeBaseline = structuredClone(opencodeCatalog);
  const copilotBaselineKeys = Object.keys(discovery.catalog);
  const original = {
    name: 'llm-pi-ai', Config: FakeAdapterConfig, inject: ['llm'],
    recordKeyFor: () => 'llm-pi-ai/github-copilot',
    apply(ctx: Record<string, unknown>, config: never) {
      applied = { ctx, config: config as never };
      return 'adapter-result';
    },
  };
  const dependencies: BetterCopilotDependencies = {
    ...runtimeDependencies(original as unknown as OriginalAdapter, discovery.options),
    opencodeGoCatalog: opencodeCatalog,
    ...(overrides.cache === undefined ? {} : { cache: overrides.cache }),
    installIdentity: () => () => {},
  };
  const config = Config({
    providers: overrides.providers ?? { 'github-copilot': {}, 'opencode-go': {} },
    catalog: { providers: overrides.catalogProviders ?? ['opencode-go'] },
  });
  const ctx = {
    get: (name: string) => name === 'credentials' ? discovery.credentials : undefined,
    effect(execute: () => () => void) { effects.push(execute()); return 'effect'; },
    inject() { return 'inject'; },
    on() { return { dispose() {} }; },
    emit(event: string, ...args: unknown[]) { events.push([event, ...args]); },
    logger: { info() {}, warn(...args: unknown[]) { warnings.push(args); } },
    llm: {
      registerAdapter(providers: string[], adapter: Record<string, unknown>) {
        registered.push({ providers, adapter });
        return { replace() {} };
      },
    },
  };
  // The real adapter registers through the decorated LLM service during apply.
  const stubAdapter = {
    providerInfo: (provider: string) => ({ id: provider, name: provider }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => ({ priceImages: () => [] }),
    imageRequestTarget: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: 1 } }),
    prepareCall: async (provider: string, model: string) => ({ model: { provider, id: model, name: model }, stream: async function* () {} }),
    stream: async function* () {},
  };
  const plugin = createPlugin({
    ...dependencies,
    original: {
      ...original,
      apply(ctx: unknown, config: unknown) {
        applied = { ctx, config: config as never };
        ((ctx as { llm: { registerAdapter(p: string[], a: unknown): unknown } }).llm)
          .registerAdapter(Object.keys(discovery.catalog), stubAdapter);
        return 'adapter-result';
      },
    } as unknown as BetterCopilotDependencies['original'],
  });
  return {
    plugin, config, ctx, discovery, dependencies, opencodeCatalog, opencodeBaseline,
    events, warnings, effects, registered, calls, stubAdapter, copilotBaselineKeys,
    applied: () => applied,
    advance(ms: number) { clock += ms; },
    setOpencodeModels(models: Record<string, unknown>[]) { opencodeModels = models; },
    dispose() { for (const release of effects.splice(0)) release(); },
    apply: () => plugin.apply(ctx as unknown as PluginContext, config as never),
  };
}

test('the plugin syncs both catalogs at mount and publishes a fresh provider facade', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  assert.equal(await f.apply(), 'adapter-result');
  assert.deepEqual(Object.keys(f.discovery.catalog), ['gpt-6-sol']);
  assert.deepEqual(Object.keys(f.opencodeCatalog), ['glm-5.3', 'synthetic-live-model']);
  assert.equal(f.calls.copilot, 1);
  assert.equal(f.calls.opencode, 1);
  const updates = f.events.filter(([event]) => event === 'llm/models-updated');
  assert.equal(updates.filter(([, provider]) => provider === 'opencode-go').length, 1,
    'one publication notifies the OpenCode Go picker');
  assert.ok(updates.some(([, provider]) => provider === 'github-copilot'));
  const invocation = f.applied();
  assert.ok(invocation);
  assert.notEqual(invocation.config.providers.get(), f.config.providers.get(),
    'the revision invalidates the adapter profile snapshot without mutating stored settings');
  assert.deepEqual(Object.keys(invocation.config.providers.get()), ['github-copilot', 'opencode-go']);
});

test('the decorated adapter refreshes a stale OpenCode catalog on demand and notifies pickers', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  await f.apply();
  assert.equal(f.calls.opencode, 1);
  const decorated = f.registered[0]!.adapter as {
    listModels(provider: string): Promise<unknown[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<unknown>;
  };
  await decorated.listModels('opencode-go');
  assert.equal(f.calls.opencode, 1, 'the mount refresh is still inside its interval');
  f.advance(INTERVAL);
  f.setOpencodeModels([opencodeItem('glm-5.3'), opencodeItem('synthetic-live-model'), opencodeItem('kimi-k3.1-pro')]);
  await decorated.listModels('opencode-go');
  assert.equal(f.calls.opencode, 2);
  assert.ok(Object.hasOwn(f.opencodeCatalog, 'kimi-k3.1-pro'));
  const updates = f.events.filter(([event, provider]) => event === 'llm/models-updated' && provider === 'opencode-go');
  assert.ok(updates.length >= 2, 'each successful publication notifies the OpenCode Go picker');

  const before = f.calls.opencode;
  f.advance(INTERVAL);
  await decorated.resolveModel('opencode-go', 'another-new-model');
  assert.equal(f.calls.opencode, before + 1, 'an unknown model triggers one bounded refresh');
  await decorated.resolveModel('opencode-go', 'another-new-model-2');
  assert.equal(f.calls.opencode, before + 1, 'the miss cooldown bounds repeated refreshes');
  const copilotBefore = f.calls.copilot;
  await decorated.listModels('github-copilot');
  assert.equal(f.calls.copilot, copilotBefore + 1, 'copilot is only refreshed by its own policy');
});

test('disabling catalog.providers or omitting the route skips the public listing entirely', async (t) => {
  const disabled = fixture({ catalogProviders: [] });
  t.after(disabled.dispose);
  await disabled.apply();
  assert.equal(disabled.calls.opencode, 0);
  assert.deepEqual(Object.keys(disabled.opencodeCatalog), Object.keys(disabled.opencodeBaseline));

  const absent = fixture({ providers: { 'github-copilot': {} } });
  t.after(absent.dispose);
  await absent.apply();
  assert.equal(absent.calls.opencode, 0);
  assert.deepEqual(Object.keys(absent.opencodeCatalog), Object.keys(absent.opencodeBaseline));
});

test('a startup cache is published without a live request and a failed live refresh keeps it', async (t) => {
  const scope = opencodeCacheScope('https://opencode.ai/inference/go/v1/models');
  const normalized = normalizeOpencodeCatalog(opencodeDocument(opencodeItem('synthetic-cached-model')))!;
  const entry = createCatalogCacheEntry(scope, { data: normalized.data as unknown as Record<string, unknown>[] }, Date.now(), [], 'opencode-go')!;
  const reads: CatalogCacheScope[] = [];
  const cache: CatalogCache = {
    async read(requested: CatalogCacheScope) {
      reads.push(requested);
      return requested.accountKey === entry.accountKey ? { ...entry } as CatalogCacheEntry : undefined;
    },
    async write() {},
  };
  const f = fixture({ cache, opencodeOffline: true });
  t.after(f.dispose);
  await f.apply();
  assert.equal(f.calls.opencode, 1, 'a live refresh is still attempted after the cached selection');
  assert.deepEqual(Object.keys(f.opencodeCatalog), ['synthetic-cached-model']);
  assert.ok(reads.some((read) => read.accountKey === entry.accountKey));
  assert.ok(f.warnings.some((args) => args[0] === 'OpenCode Go catalog refresh: %s' && args[1] === 'CACHE_FALLBACK:FETCH_FAILED'));
  assert.equal(f.events.filter(([event, provider]) => event === 'llm/models-updated' && provider === 'opencode-go').length, 1);
});

test('unsupported catalog provider names are reported once and harmlessly ignored', async (t) => {
  const f = fixture({ catalogProviders: ['opencode-go', 'synthetic-provider'] });
  t.after(f.dispose);
  await f.apply();
  assert.ok(f.warnings.some((args) => args[0] === 'better-copilot: unsupported catalog provider "%s" ignored' && args[1] === 'synthetic-provider'));
  assert.equal(f.calls.opencode, 1);
});

test('unloading restores both installed catalogs', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  await f.apply();
  assert.ok(Object.hasOwn(f.opencodeCatalog, 'synthetic-live-model'));
  assert.ok(Object.hasOwn(f.discovery.catalog, 'gpt-6-sol'));
  f.dispose();
  assert.deepEqual(Object.keys(f.opencodeCatalog), Object.keys(f.opencodeBaseline));
  assert.deepEqual(Object.keys(f.discovery.catalog), f.copilotBaselineKeys);
});

test('an incompatible runtime still loads and simply skips OpenCode discovery', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  const withoutCatalog = createPlugin({
    ...runtimeDependencies(f.dependencies.original as unknown as OriginalAdapter, f.discovery.options),
    installIdentity: () => () => {},
  });
  const config = Config({ providers: { 'github-copilot': {}, 'opencode-go': {} } });
  assert.equal(await withoutCatalog.apply(f.ctx as unknown as PluginContext, config as never), 'adapter-result');
  assert.equal(f.calls.opencode, 0);
});
