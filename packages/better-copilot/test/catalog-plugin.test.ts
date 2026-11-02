import type { CredentialKey, OriginalAdapter, PluginContext } from '../dist/catalog-types.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import z from '@deepseek-ai/schemastery';
import { createConfig } from '../dist/config.js';
import { createPlugin, providersFacade } from '../dist/plugin.js';
import { accountItem, catalogFixture, discoveryFixture, fetchRequest, runtimeDependencies, type FixtureOptions, type FixtureCredentials } from './catalog-helpers.js';

interface ProviderProfile { baseURL?: string; apiKeyEnv?: string }
interface FixtureConfig { providers: { get(): Record<'github-copilot', ProviderProfile> } }
interface FixtureContext {
  get(name: string): FixtureCredentials | undefined;
  effect(execute: () => () => void): unknown;
  inject(deps: string[], callback: (child: { web: { registerSearchProvider(provider: unknown): unknown } }) => void): unknown;
  on(event: string, listener: unknown, options?: unknown): { dispose(): void };
  logger?: { info(...args: unknown[]): unknown; warn(...args: unknown[]): unknown };
}
type AdapterCall = ['apply', FixtureContext, FixtureConfig, string[]];
type LogCall = ['info' | 'warn', ...unknown[]];
type IdentityCall = 'install' | 'release';
type Call = AdapterCall | LogCall;

/** The adapter schema shape the merged config reuses. */
const FakeAdapterConfig = z.object({ providers: z.dict(z.any()).default({}).volatile() });
const Config = createConfig(FakeAdapterConfig);

function fixture(overrides: Partial<FixtureOptions> = {}) {
  const f = discoveryFixture();
  const calls: Call[] = [];
  const identityCalls: IdentityCall[] = [];
  const effects: (() => void)[] = [];
  const config: FixtureConfig = { providers: { get: () => ({ 'github-copilot': {} }) } };
  const original = {
    name: 'llm-pi-ai', Config: FakeAdapterConfig, inject: ['llm'],
    recordKeyFor: () => 'key' as CredentialKey,
    apply(ctx: FixtureContext, supplied: FixtureConfig) { calls.push(['apply', ctx, supplied, Object.keys(f.catalog)]); return 'adapter-result'; },
  };
  const ctx: FixtureContext = {
    get: (name) => name === 'credentials' ? f.credentials : undefined,
    effect: (execute) => {
      const release = execute();
      effects.push(release);
    },
    // No web service in these fixtures: search stays unmounted, never fatal.
    inject: () => undefined,
    on: () => ({ dispose() {} }),
    logger: {
      info: (...args: unknown[]) => calls.push(['info', ...args]),
      warn: (...args: unknown[]) => calls.push(['warn', ...args]),
    },
  };
  const installIdentity = () => {
    identityCalls.push('install');
    return () => { identityCalls.push('release'); };
  };
  // The dynamic Cordis adapter double implements only the settings/lifecycle seam used here.
  const plugin = createPlugin({
    ...runtimeDependencies(original as unknown as OriginalAdapter, { ...f.options, ...overrides }),
    installIdentity,
  });
  const dispose = () => { for (const release of effects.splice(0)) release(); };
  return { ...f, plugin, original, ctx, config, calls, identityCalls, dispose };
}

test('the merged plugin replaces the adapter and preserves its provider schema', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  assert.equal(f.plugin.name, 'better-copilot');
  // The provider field schema is the adapter's own instance, not a restatement.
  assert.equal((f.plugin.Config as unknown as { dict: { providers: unknown } }).dict.providers,
    (FakeAdapterConfig as unknown as { dict: { providers: unknown } }).dict.providers);
  assert.deepEqual(f.plugin.inject, ['llm', 'credentials']);
  assert.equal(await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never), 'adapter-result');
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[1], f.ctx);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(f.config.providers.get()['github-copilot']!.baseURL, undefined);
  assert.deepEqual(invocation[3], ['gpt-6-sol']);
});

test('wire identity is installed by default and released with the plugin effect', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  assert.deepEqual(f.identityCalls, ['install']);
  f.dispose();
  assert.deepEqual(f.identityCalls, ['install', 'release']);
});

test('wire identity opt-out performs no installation and no identity work', async (t) => {
  const previous = process.env.DSH_COPILOT_WIRE_IDENTITY;
  process.env.DSH_COPILOT_WIRE_IDENTITY = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COPILOT_WIRE_IDENTITY;
    else process.env.DSH_COPILOT_WIRE_IDENTITY = previous;
  });
  const f = fixture();
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  assert.deepEqual(f.identityCalls, []);
});

test('discovery failure is fail-open without leaking raw OAuth or credential exceptions', async (t) => {
  const f = fixture({ fetcher: async () => { throw new Error('Bearer TOP-SECRET token payload'); } });
  t.after(f.dispose);
  assert.equal(await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never), 'adapter-result');
  assert.deepEqual(Object.keys(f.catalog), Object.keys(catalogFixture()));
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('DISCOVERY_FAILED'));
  assert.ok(!log.includes('TOP-SECRET'));
});

test('no credentials and no logger still delegate to original adapter', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  f.ctx = { get: () => undefined, effect: f.ctx.effect, inject: () => undefined, on: f.ctx.on };
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]![0], 'apply');
});

test('a bounded startup timeout delegates to the adapter', async (t) => {
  const f = fixture({ timeoutMs: 10, fetcher: () => new Promise(() => {}) });
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  assert.ok(JSON.stringify(f.calls[0]!).includes('TIMEOUT'));
  assert.equal(f.calls.at(-1)![0], 'apply');
});

test('new model diagnostics escape control characters', async (t) => {
  const f = fixture({ fetcher: async () => ({ ok: true, json: async () => ({
    data: [accountItem('gpt-6-sol'), accountItem('unknown\nFORGED-LOG')],
  }) }) });
  t.after(f.dispose);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  const diagnostic = f.calls[0]!.at(-1);
  assert.equal(diagnostic, '["unknown\\nFORGED-LOG"]');
});

test('validated Enterprise routing survives a failed model listing without changing bundled descriptors', async (t) => {
  const f = fixture({ fetcher: async () => ({ ok: false, status: 503 }) });
  t.after(f.dispose);
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.deepEqual(f.catalog, before);
});

test('GHE account routing survives a failed listing as a runtime default without rewriting settings', async (t) => {
  const f = fixture({ oauth: {
    refresh: async () => { throw new Error('Valid synthetic credentials must not refresh'); },
    toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: 'https://copilot-api.msft.ghe.com' }),
  }, fetcher: async (url, init) => {
    assert.equal(url.origin, 'https://copilot-api.msft.ghe.com');
    assert.equal(init.redirect, 'error');
    return { ok: false, status: 503 };
  } });
  t.after(f.dispose);
  const before = structuredClone(f.catalog);
  await f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://copilot-api.msft.ghe.com');
  assert.equal(f.config.providers.get()['github-copilot']!.baseURL, undefined);
  assert.deepEqual(f.catalog, before);
  const log = JSON.stringify(f.calls.filter((call) => call[0] !== 'apply'));
  assert.ok(log.includes('HTTP_ERROR'));
  assert.ok(log.includes('https://copilot-api.msft.ghe.com'));
});

test('the endpoint facade preserves explicit URLs, other providers, volatile updates, and snapshot memoization', () => {
  let raw: Record<'github-copilot' | 'openai', ProviderProfile> = { 'github-copilot': {}, openai: { baseURL: 'https://example.invalid' } };
  const providers = { get: () => raw };
  const routed = providersFacade(providers, 'https://api.enterprise.githubcopilot.com');
  const first = routed.get();
  assert.equal(routed.get(), first);
  assert.equal(first.openai, raw.openai);
  assert.equal(raw['github-copilot']!.baseURL, undefined);
  raw = { ...raw, 'github-copilot': { baseURL: 'https://api.business.githubcopilot.com' } };
  assert.equal(routed.get(), raw);
  assert.equal(routed.get()['github-copilot']!.baseURL, 'https://api.business.githubcopilot.com');
  raw = { ...raw, 'github-copilot': {} };
  assert.equal(routed.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(providersFacade(providers, undefined), providers);
});

test('an explicit API-key reference wins over an unrelated stored OAuth account', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  const token = ['synthetic-token', 'proxy-ep=proxy.enterprise.githubcopilot.com'].join(';');
  f.credentials.resolve = async (ref) => {
    assert.equal(ref, 'SYNTHETIC_COPILOT_TOKEN');
    return { value: token };
  };
  f.credentials.readRecord = () => { throw new Error('Explicit API key must bypass the unrelated stored grant'); };
  await f.plugin.apply(f.ctx as unknown as PluginContext,
    Config({ providers: { 'github-copilot': { apiKeyEnv: 'SYNTHETIC_COPILOT_TOKEN' } } }) as never);
  const invocation = f.calls.find((call): call is AdapterCall => call[0] === 'apply');
  assert.ok(invocation);
  assert.equal(invocation[2].providers.get()['github-copilot']!.baseURL, 'https://api.enterprise.githubcopilot.com');
  assert.equal(fetchRequest(f.requests, 0)[2].headers.get('Authorization'), `Bearer ${token}`);
});

test('adapter mount errors remain fatal rather than being mistaken for discovery failures', async (t) => {
  const f = fixture();
  t.after(f.dispose);
  f.original.apply = () => { throw new Error('duplicate route'); };
  await assert.rejects(f.plugin.apply(f.ctx as unknown as PluginContext, Config({ providers: { 'github-copilot': {} } }) as never), /duplicate route/);
});

test('incompatible runtime fails clearly and the static inject list is fixed', () => {
  assert.throws(() => createPlugin({} as never), /Incompatible/);
  const f = fixture();
  f.original.inject = ['llm', 'credentials'];
  const plugin = createPlugin(runtimeDependencies(f.original as unknown as OriginalAdapter, f.options));
  assert.deepEqual(plugin.inject, ['llm', 'credentials']);
});
